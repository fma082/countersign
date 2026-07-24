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
import { govern, executeGate, executeUndo, TOOLS } from "@/lib/engine/tools";
import { putGate, takeGate } from "@/lib/engine/gate-store";
import { rateLimit, clientIp } from "@/lib/engine/rate-limit";
import { resetCatalog } from "@/lib/scenario/catalog";
import type { ChatMessage, ErrorReason, StreamFrame, UndoSpec, ViewEffect } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are the Copilot inside Northbase, a fictional product-admin panel.
Today is 2026-07-21. The catalog has 30 products.

Operate the panel through tools. Prefer tools over guessing.

Reads (run on their own):
- query_products(metric): count a group. Metrics sit on DISTINCT AXES — never cross them:
    · status axis:  active (status is active) · discontinued (status is discontinued)
    · sale axis:    on_sale (a live, valid promo) · expired_sale (a promo that ended, not cleared)
    · other:        below_reorder · negative_margin · all
  "How many active products?" → active (STATUS), never on_sale. "How many on sale?" → on_sale.
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
        emit({ type: "done" });
      } else if (fallback) {
        runFallback(fallback, emit);
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
      emit({ type: "done" });
      return;
    }

    messages.push({
      role: "assistant",
      content: text,
      tool_calls: pending.map((p) => ({ id: p.id, function: { name: p.name, arguments: p.args } })),
    });

    for (const call of pending) {
      const decision = govern(call.id, call.name, call.args);

      if (decision.kind === "gate") {
        // Destructive op waits FIRST. Remember what we offered so approval
        // re-resolves server-side; emit the gate and stop — no `done`.
        putGate({ id: decision.gate.id, tool: call.name, args: call.args });
        emit({ type: "tool", event: decision.event });
        emit({ type: "gate", gate: decision.gate });
        return;
      }

      emit({ type: "tool", event: decision.event });
      anyToolRan = true;
      if (decision.kind !== "invalid" && hasEffect(decision.effect)) {
        emit({ type: "effect", effect: decision.effect });
      }
      // Tie each result back to the call that produced it — its own id, never
      // mixed. Groq (OpenAI-style) rejects a role:"tool" message without it.
      messages.push({ role: "tool", content: decision.toolResult, tool_call_id: call.id });
    }
  }

  emit({ type: "done" });
}

/**
 * The guided degradation path — the model is paused, so run this step's known
 * tool ourselves. This is NOT a simulation: it goes through the same `govern`
 * every model-driven call does, so the effect, the gate, its preview and
 * targetIds are the real, server-resolved article. The only thing missing is the
 * model's spoken narration, and the paused note says so.
 */
function runFallback(fallback: Fallback, emit: Emit): void {
  const decision = govern("call_fallback", fallback.tool, fallback.args);
  emit({ type: "paused", text: PAUSED_FALLBACK });

  if (decision.kind === "gate") {
    putGate({ id: decision.gate.id, tool: fallback.tool, args: fallback.args });
    emit({ type: "tool", event: decision.event });
    emit({ type: "gate", gate: decision.gate });
    return;
  }

  emit({ type: "tool", event: decision.event });
  if (decision.kind !== "invalid" && hasEffect(decision.effect)) {
    emit({ type: "effect", effect: decision.effect });
  }
  emit({ type: "done" });
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
  emit({ type: "token", text: gateClosing(result.toolResult) });
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

function gateClosing(toolResult: string): string {
  try {
    const { approved, excluded } = JSON.parse(toolResult) as { approved: number; excluded: number };
    if (approved === 0) return "Nothing ran — every target was excluded.";
    const tail = excluded ? ` ${excluded} held back by you.` : "";
    return `Done — applied to ${approved} product${approved === 1 ? "" : "s"}.${tail}`;
  } catch {
    return "Done.";
  }
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
const KNOWN_METRICS = ["on_sale", "expired_sale", "active", "discontinued", "below_reorder", "negative_margin", "all"] as const;

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
  }
  return { name, args };
}
