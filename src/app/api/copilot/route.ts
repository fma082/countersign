/**
 * Copilot engine endpoint — the governance layer.
 *
 * Consumes RawFrames from the provider-agnostic adapter, applies governance,
 * and emits StreamFrames (NDJSON) the client can reflect verbatim.
 *
 * Request shapes:
 *   { messages }                          → run a turn (may stop at a gate)
 *   { messages, action:"approve", gateId, excludedIds } → execute an approved
 *                                            (possibly partial) destructive op
 *   { action:"undo", undo, force? }       → reverse a reversible write
 *
 * Reversible writes run inside a normal turn. The human approves what THIS layer
 * will execute; the client can shrink a gate's effect but never define it.
 */

import { streamChatResilient } from "@/lib/engine/resilient";
import { govern, executeGate, executeUndo, METRIC_SPEC, TOOLS } from "@/lib/engine/tools";
import { putGate, takeGate } from "@/lib/engine/gate-store";
import { rateLimit, clientIp } from "@/lib/engine/rate-limit";
import { resetCatalog } from "@/lib/scenario/catalog";
import type {
  ChatMessage,
  ErrorReason,
  RenderPayload,
  StreamFrame,
  ToolOutcome,
  UndoSpec,
  ViewEffect,
} from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The metric vocabulary, rendered from the server's own phrases. The model is
 * told a metric means exactly the string it will be handed back as
 * `criterionLabel`, so routing and labelling cannot drift apart.
 *
 * `stock_below` prints with its `{n}` placeholder intact — the parameter is
 * visible in the meaning, so "less than 50 in stock" has somewhere to land that
 * isn't `below_reorder`. The substituted label is built server-side, after the
 * call, from the number the model passed.
 */
const METRIC_VOCABULARY = (
  [
    ["status axis", ["active", "discontinued"]],
    ["sale axis", ["on_sale", "expired_sale"]],
    ["stock axis", ["below_reorder", "stock_below"]],
    ["other", ["negative_margin", "all"]],
  ] as const
)
  .map(
    ([axis, metrics]) =>
      `    · ${axis}: ` +
      metrics.map((m) => `${m} = ${METRIC_SPEC[m].phrase}`).join(" · "),
  )
  .join("\n");

const SYSTEM_PROMPT = `You are the Copilot inside Northbase, a fictional product-admin panel.
Today is 2026-07-21. The catalog has 30 products.

Operate the panel through tools. Prefer tools over guessing.

Reads (run on their own):
- query_products(metric): count a group and show the human the matching rows. Metrics sit on DISTINCT AXES — never cross them:
${METRIC_VOCABULARY}
  Match the user's words to the metric whose meaning above covers them, and pick that metric only. "How many active products?" → active (STATUS), never on_sale.
  THE STOCK AXIS HAS TWO METRICS AND THEY ARE NOT INTERCHANGEABLE. A question naming a NUMBER of units is stock_below, and you must pass that number as threshold: "less than 50 in stock", "under 50 units", "stock below 50", "menos de 50 en stock", "con menos de 50 unidades" → stock_below with threshold: 50. Only a question with NO number — "running low", "which need reordering", "below the reorder point", "hay que reponer" — is below_reorder. Never answer a numbered question with below_reorder: it compares each product to its own reorder point, so it does not contain the user's number at all.
- inspect_product(sku): the real status/stock/reorder/margin/sale of ONE product. Use for any question about a single sku (e.g. "what is the status of NB-AU-1005?").
- filter_view(filter, reveal_margin?): filter the table; filter ∈ those metrics or "none".

Reversible writes (run immediately, one product, undoable):
- update_price(sku, price)
- adjust_stock(sku, stock)
- set_web_visible(sku, visible) — visible is REQUIRED (true = show, false = hide). There is no toggle; always state the direction explicitly.
Always pass a single sku for these.

Destructive writes (you propose, a human approves — you cannot run them):
- clear_expired_sales()
- discontinue_products(filter)

Rules:
- Never invent counts. Call a tool and report what it returns.
- A tool result carrying "rendered": true means the panel is already displaying those rows. Never list them, and never mention that they are displayed — write ONE sentence about what they mean.
- Name the group by copying the tool result's own "criterionLabel" string into your sentence, word for word, together with its "count". That label is the criterion the system actually ran. Then STOP: never append a clause that explains, restates or equates it with something else — no "meaning ...", no "which means ...", no "i.e.", and never the user's own phrasing. Your paraphrase and their wording both name a criterion the system did not run. The shape, written with placeholders that must never appear literally in an answer: a result {"count": N, "criterionLabel": "<LABEL>"} becomes exactly "N <LABEL>." — substitute the two values, append nothing. If a result has no "criterionLabel", describe it only from the fields that result actually contains.
- Keep answers to 1-3 short sentences. No markdown headings, no bullet dumps.
- For a single-product price/stock/visibility change, use the reversible tool with its sku.
- To LIST or COUNT discontinued products, use a READ (query_products or filter_view with "discontinued"). discontinue_products is the DESTRUCTIVE write that MARKS products discontinued — use it only to actually discontinue, never to look at ones that already are.`;

const MAX_ROUNDS = 4;

interface Body {
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  action?: "approve" | "undo";
  gateId?: string;
  excludedIds?: string[];
  undo?: UndoSpec;
  force?: boolean;
  /** Guided steps only: the tool this step is known to run. If the model can't
   *  be reached, the server runs it directly rather than break the flow. */
  fallbackTool?: string;
  fallbackArgs?: Record<string, unknown>;
}

/** A guided step's predetermined tool, for the degradation path. */
interface Fallback {
  tool: string;
  args: Record<string, unknown>;
}

// Server-authored, honest notes that stand in for the missing model narration
// when the model is paused. NEVER fabricated "answers" — they name the pause and
// point at the real, server-side effect.
const PAUSED_FALLBACK =
  "Model paused — running this step's operation directly. What follows is the system's real result, executed server-side, not a narration.";
const PAUSED_AFTER_TOOL =
  "Model paused — the operation ran and its result stands. Only the model's spoken summary is on hold.";

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const history: ChatMessage[] = (body.messages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Rate limit only the model-consuming path — a fresh turn. Approve/undo are
  // pure governance (no provider call), so a visitor mid-decision is never
  // blocked from finishing what they started.
  const isModelTurn = body.action !== "approve" && body.action !== "undo";
  if (isModelTurn) {
    const { ok, retryAfter } = rateLimit(clientIp(req));
    if (!ok) {
      return oneFrame(
        {
          type: "error",
          reason: "rate_limit",
          message: `You've reached the demo's request limit. Try again in about ${retryAfter}s.`,
        },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const emit = (frame: StreamFrame) =>
        controller.enqueue(enc.encode(JSON.stringify(frame) + "\n"));

      const fallback: Fallback | undefined = body.fallbackTool
        ? { tool: body.fallbackTool, args: body.fallbackArgs ?? {} }
        : undefined;

      const run =
        body.action === "approve"
          ? () => runGateDecision(body, emit)
          : body.action === "undo"
            ? () => runUndo(body, emit)
            : () => runTurn(history, emit, fallback);

      run()
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "Engine failure.";
          emit({ type: "error", message });
        })
        .finally(() => controller.close());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** A one-off NDJSON body carrying a single frame — used for pre-stream refusals
 *  (e.g. rate limit) so the client's uniform reader still gets a typed frame,
 *  not a bare status. */
function oneFrame(frame: StreamFrame, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(frame) + "\n", {
    status,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      ...extra,
    },
  });
}

type Emit = (frame: StreamFrame) => void;

/**
 * The message that opened this turn — the LAST thing the human said, which is
 * the only phrasing a render of this turn may be attributed to.
 *
 * This used to be a tool argument the model filled in, and the model dragged a
 * previous turn's question forward: an `expired_sale` list captioned with the
 * `negative_margin` question from the turn before. The subtitle claims to quote
 * the human, so a stale one puts words in their mouth.
 *
 * The route holds the whole history and therefore already knows which message
 * is current; the model was never needed for this. Reading it here — once, at
 * the top of the turn, before any tool runs — means every render below is
 * attributed to the same sentence, and no round of a multi-tool turn can pick
 * up a different one.
 */
function turnMessage(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return undefined;
}

/**
 * A normal turn: stream (with transient-failure retries), govern tools, run
 * reads/reversibles, stop at a gate.
 *
 * When the model is paused after its retries are spent, the turn still lands
 * honestly — never a stack trace, never faked narration:
 *   - if a tool already ran this turn, the effect stands and only the model's
 *     summary is missing → emit a paused note + `done`;
 *   - else if this is a guided step (a `fallback` tool is known), run that tool
 *     directly, server-side, with a paused note → the flow always completes;
 *   - else (free input, nothing to fall back to) → surface the typed error, for
 *     the client to reframe (a pause) or report (a real fault).
 */
async function runTurn(history: ChatMessage[], emit: Emit, fallback?: Fallback): Promise<void> {
  if (history.length <= 1) resetCatalog();

  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const render = renderSlot(emit);
  // Read once, here, from the message that OPENED this turn. Every render in the
  // turn is attributed to this sentence and to no other. See `turnMessage`.
  const turn = turnMessage(history);
  let anyToolRan = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = "";
    const pending: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let streamError: { message: string; reason?: ErrorReason } | null = null;
    let holding = false;

    for await (const frame of streamChatResilient(messages, TOOLS)) {
      if (frame.type === "token") {
        text += frame.text;
        if (!holding && text.trimStart().startsWith("{")) holding = true;
        if (!holding) emit({ type: "token", text: frame.text });
      } else if (frame.type === "toolCall") {
        pending.push({ id: frame.id, name: frame.name, args: frame.args });
      } else if (frame.type === "error") {
        // The wrapper only yields an error once retries are spent.
        streamError = { message: frame.message, reason: frame.reason };
      }
    }

    if (streamError) {
      if (anyToolRan) {
        emit({ type: "paused", text: PAUSED_AFTER_TOOL });
        render.flush();
        emit({ type: "done" });
      } else if (fallback) {
        runFallback(fallback, emit, render, turn);
      } else {
        emit({ type: "error", message: streamError.message, reason: streamError.reason });
      }
      return;
    }

    if (pending.length === 0 && holding) {
      const rescued = salvageToolCall(text);
      if (rescued) pending.push({ id: `call_s${round}`, ...rescued });
    }
    if (pending.length === 0) {
      if (holding && text.trim()) emit({ type: "token", text });
      render.flush();
      emit({ type: "done" });
      return;
    }

    messages.push({
      role: "assistant",
      content: text,
      tool_calls: pending.map((p) => ({ id: p.id, function: { name: p.name, arguments: p.args } })),
    });

    for (const call of pending) {
      const decision = govern(call.id, call.name, call.args, turn);

      if (decision.kind === "gate") {
        // Destructive op waits FIRST. Remember what we offered so approval
        // re-resolves server-side; emit the gate and stop — no `done`. A gate is
        // a close, so the turn's render lands here: whatever a read resolved
        // before the proposal still has to reach the human, above the gate card.
        putGate({ id: decision.gate.id, tool: call.name, args: call.args });
        render.flush();
        emit({ type: "tool", event: decision.event });
        emit({ type: "gate", gate: decision.gate });
        return;
      }

      emit({ type: "tool", event: decision.event });
      anyToolRan = true;
      if (decision.kind !== "invalid") {
        if (hasEffect(decision.effect)) emit({ type: "effect", effect: decision.effect });
        render.hold(decision.outcome);
      }
      // ONLY `modelPayload` crosses into the conversation. Whatever rows the
      // tool resolved left on the render channel above and are not in scope
      // here — the model cannot enumerate what it was never handed.
      // Tie each result back to the call that produced it — its own id, never
      // mixed. Groq (OpenAI-style) rejects a role:"tool" message without it.
      messages.push({
        role: "tool",
        content: JSON.stringify(decision.outcome.modelPayload),
        tool_call_id: call.id,
      });
    }
  }

  render.flush();
  emit({ type: "done" });
}

/**
 * The guided degradation path — the model is paused, so run this step's known
 * tool ourselves. This is NOT a simulation: it goes through the same `govern`
 * every model-driven call does, so the effect, the gate, its preview and
 * targetIds are the real, server-resolved article. The only thing missing is the
 * model's spoken narration, and the paused note says so.
 */
function runFallback(
  fallback: Fallback,
  emit: Emit,
  render: RenderSlot,
  turn?: string,
): void {
  const decision = govern("call_fallback", fallback.tool, fallback.args, turn);
  emit({ type: "paused", text: PAUSED_FALLBACK });

  if (decision.kind === "gate") {
    putGate({ id: decision.gate.id, tool: fallback.tool, args: fallback.args });
    render.flush();
    emit({ type: "tool", event: decision.event });
    emit({ type: "gate", gate: decision.gate });
    return;
  }

  emit({ type: "tool", event: decision.event });
  if (decision.kind !== "invalid") {
    if (hasEffect(decision.effect)) emit({ type: "effect", effect: decision.effect });
    render.hold(decision.outcome);
  }
  render.flush();
  emit({ type: "done" });
}

interface RenderSlot {
  /** Take a tool's client-only half, replacing whatever was held before it. */
  hold(outcome: ToolOutcome): void;
  /** Ship the held payload, if any. Idempotent — a second call emits nothing. */
  flush(): void;
}

/**
 * The turn's ONE render slot. A turn emits at most one `render` frame, and the
 * LAST `renderPayload` produced wins: tools run in order, so the last one is the
 * turn's final resolved state.
 *
 * This is a constraint, not an optimisation. Two renders in one turn make the
 * panel contradict ITSELF, and make one of the two disagree with the table:
 * ask about margins and then to filter to expired sales, and `query_products`
 * (3 selling below cost) and `filter_view` (6 on expired sale) each shipped a
 * product_list. The panel stacked both, while the table header said "6 of 30" —
 * so the top list was rows the system no longer stands behind, presented with
 * the same authority as the ones it does. A human reading the wrong one reads it
 * as current. One list per turn is the only version the server can vouch for.
 *
 * `modelPayload` is untouched by this: every tool still reports its own result
 * to the model, and every tool still emits its own `tool` event, so both cards
 * stay visible with their summaries. What collapses is the render — never the
 * record of what ran.
 */
function renderSlot(emit: Emit): RenderSlot {
  let held: RenderPayload | undefined;
  return {
    hold(outcome) {
      if (outcome.renderPayload) held = outcome.renderPayload;
    },
    flush() {
      if (!held) return;
      emit({ type: "render", render: held });
      held = undefined;
    },
  };
}

/**
 * Approve (possibly partially) a parked destructive op. The server re-resolves
 * its own preview from the stored spec and re-intersects with the exclusions —
 * the client shrinks the effect, it never defines it. Confirmation is authored
 * here, not narrated by the model.
 */
async function runGateDecision(body: Body, emit: Emit): Promise<void> {
  const stored = body.gateId ? takeGate(body.gateId) : undefined;
  if (!stored) {
    emit({ type: "error", message: "That approval has expired. Ask for the change again." });
    return;
  }
  const excluded = Array.isArray(body.excludedIds) ? body.excludedIds : [];
  const result = executeGate("call_gate", stored.tool, stored.args, excluded);
  emit({ type: "tool", event: result.event });
  emit({ type: "effect", effect: result.effect });
  // One gate, one outcome — the single-render rule is satisfied by construction.
  if (result.outcome.renderPayload) {
    emit({ type: "render", render: result.outcome.renderPayload });
  }
  emit({ type: "token", text: gateClosing(result.outcome.modelPayload) });
  emit({ type: "done" });
}

/** Reverse a reversible write. Human-only signal. Still server-resolved: a
 *  stale target (value drifted) is surfaced, not overwritten blindly. */
async function runUndo(body: Body, emit: Emit): Promise<void> {
  if (!body.undo) {
    emit({ type: "error", message: "Nothing to undo." });
    return;
  }
  const r = executeUndo("call_undo", body.undo, body.force === true);
  if (r.kind === "stale") {
    emit({ type: "staleUndo", stale: { spec: body.undo, field: r.field, expected: r.expected, actual: r.actual } });
    emit({ type: "done" });
    return;
  }
  emit({ type: "tool", event: r.event });
  if (hasEffect(r.effect)) emit({ type: "effect", effect: r.effect });
  emit({ type: "done" });
}

function gateClosing(payload: unknown): string {
  const { approved, excluded } = (payload ?? {}) as { approved?: number; excluded?: number };
  if (typeof approved !== "number") return "Done.";
  if (approved === 0) return "Nothing ran — every target was excluded.";
  const tail = excluded ? ` ${excluded} held back by you.` : "";
  return `Done — applied to ${approved} product${approved === 1 ? "" : "s"}.${tail}`;
}

function hasEffect(e: ViewEffect): boolean {
  return Boolean(e.filter || e.reveal || e.margins || e.mutations);
}

const KNOWN_TOOLS = [
  "clear_expired_sales",
  "discontinue_products",
  "update_price",
  "adjust_stock",
  "set_web_visible",
  "filter_view",
  "query_products",
] as const;
const KNOWN_METRICS = ["on_sale", "expired_sale", "active", "discontinued", "below_reorder", "stock_below", "negative_margin", "all"] as const;

/** Recover a tool call the model wrote as JSON text instead of structure. */
function salvageToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  const name = KNOWN_TOOLS.find((n) => t.includes(`"${n}"`) || t.includes(n));
  if (!name) return null;

  let args: Record<string, unknown> = {};
  const argMatch = t.match(/"(?:arguments|parameters)"\s*:\s*(\{[^{}]*\})/);
  if (argMatch) {
    try {
      const parsed = JSON.parse(argMatch[1]) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") args = parsed;
    } catch {
      /* heuristics below */
    }
  }
  if (Object.keys(args).length === 0) {
    const metric = KNOWN_METRICS.find((m) => t.includes(m));
    if (metric) args[name === "filter_view" || name === "discontinue_products" ? "filter" : "metric"] = metric;
    if (/reveal|margin/i.test(t)) args.reveal_margin = true;
    // A threshold metric is nothing without its number. Recover it from the same
    // text rather than let the read resolve to a criterion with a hole in it —
    // and if there is no number, the read is refused as invalid, not defaulted.
    if (metric === "stock_below") {
      const n = t.match(/\d+(?:\.\d+)?/);
      if (n) args.threshold = Number(n[0]);
    }
  }
  return { name, args };
}
