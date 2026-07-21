/**
 * Copilot engine endpoint — the governance layer.
 *
 * Consumes RawFrames from the provider-agnostic adapter, applies governance,
 * and emits StreamFrames (NDJSON) the client can reflect verbatim. The human
 * approves what THIS layer will execute — never a client re-interpretation.
 *
 * Two request shapes:
 *   { messages }                 → run a turn (may stop at a gate)
 *   { messages, action:"approve"} → execute the parked destructive op, then close
 */

import { streamChat } from "@/lib/engine/ollama";
import { govern, executeApprovedClear, TOOLS } from "@/lib/engine/tools";
import { resetCatalog } from "@/lib/scenario/catalog";
import type { ChatMessage, StreamFrame, ViewEffect } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are the Copilot inside Northbase, a fictional product-admin panel.
Today is 2026-07-21. The catalog has 30 products.

You operate the panel through tools. Prefer tools over guessing:
- query_products(metric): count/inspect. metric ∈ expired_sales, active_sales, below_reorder, negative_margin, all.
- filter_view(filter, reveal_margin?): filter the visible table; filter ∈ the same metrics or "none". Set reveal_margin=true to show the Margin column.
- clear_expired_sales(): DESTRUCTIVE. Removes sale prices from products whose sale has ended. It requires human approval; you cannot run it yourself — you propose it and stop.

Rules:
- Never invent counts. Call query_products and report the number it returns.
- Keep answers to 1-3 short sentences. No markdown headings, no bullet dumps.
- When the user wants to fix or clean up expired sales, call clear_expired_sales and let the human approve.`;

const MAX_ROUNDS = 4;

interface Body {
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  action?: "approve";
}

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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const emit = (frame: StreamFrame) =>
        controller.enqueue(enc.encode(JSON.stringify(frame) + "\n"));

      const run = body.action === "approve" ? runApprove : runTurn;

      run(history, emit)
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

type Emit = (frame: StreamFrame) => void;

/** A normal turn: stream, govern tools, loop, and stop dead at a gate. */
async function runTurn(history: ChatMessage[], emit: Emit): Promise<void> {
  // A fresh conversation (a single user message — i.e. the client just loaded)
  // re-seeds the catalog so the planted conflicts return. This keeps the demo
  // repeatable without restarting the server, and mirrors the page's own reset.
  if (history.length <= 1) resetCatalog();

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = "";
    const pending: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let errored = false;
    // Small models sometimes "speak" a tool call as JSON text instead of
    // emitting a structured call. We hold any turn whose text starts with `{`
    // so a broken JSON blob never reaches the transcript as an assistant
    // message — it is either salvaged into a real tool call or flushed as-is.
    let holding = false;

    for await (const frame of streamChat(messages, TOOLS)) {
      if (frame.type === "token") {
        text += frame.text;
        if (!holding && text.trimStart().startsWith("{")) holding = true;
        if (!holding) emit({ type: "token", text: frame.text });
      } else if (frame.type === "toolCall") {
        pending.push({ id: frame.id, name: frame.name, args: frame.args });
      } else if (frame.type === "error") {
        emit({ type: "error", message: frame.message });
        errored = true;
      }
    }
    if (errored) return;

    // Salvage a tool call the model emitted as text rather than structure.
    if (pending.length === 0 && holding) {
      const rescued = salvageToolCall(text);
      if (rescued) pending.push({ id: `call_s${round}`, ...rescued });
    }

    // No tools requested → the turn is done. If we held a JSON blob that wasn't
    // a tool call, it was the model's literal answer — flush it now.
    if (pending.length === 0) {
      if (holding && text.trim()) emit({ type: "token", text });
      emit({ type: "done" });
      return;
    }

    // Record the assistant's tool-call turn for the model loop.
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: pending.map((p) => ({
        function: { name: p.name, arguments: p.args },
      })),
    });

    for (const call of pending) {
      const decision = govern(call.id, call.name, call.args);

      if (decision.kind === "gate") {
        // CONTRACT: destructive op waits FIRST. Emit the gate and stop the
        // engine entirely — no `done`. Only a human signal resumes.
        emit({ type: "tool", event: decision.event });
        emit({ type: "gate", gate: decision.gate });
        return;
      }

      emit({ type: "tool", event: decision.event });
      if (decision.kind === "safe" && hasEffect(decision.effect)) {
        emit({ type: "effect", effect: decision.effect });
      }
      // Both safe and invalid results feed back to the model so it can continue
      // or correct itself. Invalid never surfaced as "ok".
      messages.push({ role: "tool", content: decision.toolResult });
    }
    // loop: let the model read the tool results and produce the final answer
  }

  // Ran out of rounds — close cleanly rather than hang.
  emit({ type: "done" });
}

/**
 * The approve path: run the parked sweep and report the outcome.
 *
 * The confirmation is authored by the SERVER, not the model. This is the same
 * invariant as everywhere else — the server resolves, the client reflects. A
 * language model narrating a destructive action it did not itself run is
 * exactly the kind of "confident but wrong" surface this project argues
 * against, so the closing line states what actually happened, verbatim.
 */
async function runApprove(_history: ChatMessage[], emit: Emit): Promise<void> {
  const result = executeApprovedClear("call_approved");
  emit({ type: "tool", event: result.event });
  emit({ type: "effect", effect: result.effect });
  emit({ type: "token", text: defaultClosing(result.toolResult) });
  emit({ type: "done" });
}

function defaultClosing(toolResult: string): string {
  try {
    const { cleared } = JSON.parse(toolResult) as { cleared: number };
    return `Done — cleared ${cleared} expired sale price${cleared === 1 ? "" : "s"}. The active sale was left untouched.`;
  } catch {
    return "Done — the expired sales were cleared.";
  }
}

function hasEffect(e: ViewEffect): boolean {
  return Boolean(e.filter || e.reveal || e.margins || e.mutations);
}

const KNOWN_TOOLS = ["clear_expired_sales", "filter_view", "query_products"] as const;
const KNOWN_METRICS = ["expired_sales", "active_sales", "below_reorder", "negative_margin", "all"] as const;

/**
 * Recover a tool call the model wrote as JSON text (a small-model quirk) instead
 * of a structured call. Only fires when the whole turn is a JSON-shaped blob
 * naming a known tool, so genuine prose never trips it. Governance still decides
 * what the call is allowed to do — this only reclassifies the channel.
 */
function salvageToolCall(
  text: string,
): { name: string; args: Record<string, unknown> } | null {
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
      /* fall through to heuristics */
    }
  }
  if (name !== "clear_expired_sales" && Object.keys(args).length === 0) {
    const metric = KNOWN_METRICS.find((m) => t.includes(m));
    if (metric) args[name === "filter_view" ? "filter" : "metric"] = metric;
    if (/reveal|margin/i.test(t)) args.reveal_margin = true;
  }
  return { name, args };
}
