/**
 * Adapter frame — the ONLY module that knows how to talk to Groq.
 *
 * Sibling of `ollama.ts`, not a replacement. Same signature (messages +
 * TOOLS in, RawFrames out), same ignorance of governance: it does not know
 * what a "gate" is, does not compute previews, does not label counts. The
 * governance layer above consumes the identical frame contract whether it came
 * from here or from Ollama.
 *
 * Transport: fetch + ReadableStream against Groq's OpenAI-compatible
 * /chat/completions with `stream: true` (SSE). Two Groq-specific concerns live
 * here and nowhere else:
 *
 *   1. Tool calls arrive OpenAI-style — `choices[].delta.tool_calls`, whose
 *      `arguments` stream as string fragments keyed by `index`. We accumulate
 *      per index and translate to the internal `toolCall` RawFrame at the end.
 *   2. Throttling. Groq answers so fast (a full turn in ~22ms) that streaming
 *      and every loading state are invisible — text lands in one block. We
 *      insert a small, configurable delay between content deltas so the cadence
 *      is legible, matching what warm local Ollama gave for free. See
 *      DEV_STATE.md — the speed is an anti-feature for these trust patterns.
 */

import type { ChatMessage, ProviderTool, RawFrame, ToolCall } from "./types";

const GROQ_HOST = process.env.GROQ_HOST ?? "https://api.groq.com/openai/v1";
export const MODEL = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";
export const PROVIDER_LABEL = "Groq";

/** Milliseconds to wait between streamed content deltas. Configurable so it can
 *  be tuned per environment; 0 disables the throttle. Groq only. */
const THROTTLE_MS = Number(process.env.GROQ_THROTTLE_MS ?? "28");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── OpenAI-compatible streaming shapes ──────────────────────────────────────
interface DeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface GroqChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: DeltaToolCall[] };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
}

/** A tool call being assembled across deltas — `arguments` arrives fragmented. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

let toolCallSeq = 0;

/**
 * Stream a chat completion as raw frames. Same provider-agnostic signature as
 * the Ollama adapter: messages in, RawFrames out. The caller owns governance
 * and cancellation.
 */
export async function* streamChat(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): AsyncGenerator<RawFrame> {
  let res: Response;
  try {
    res = await fetch(`${GROQ_HOST}/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL,
        messages: toOpenAIMessages(messages),
        tools,
        stream: true,
        temperature: 0,
      }),
      signal,
    });
  } catch (err) {
    yield reachError(err);
    return;
  }

  if (!res.ok || !res.body) {
    yield await httpError(res);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Tool calls accumulate by their delta `index` until the stream closes.
  const calls = new Map<number, PartialCall>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: events separated by a blank line; each carries `data: <json>`.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield* flushCalls(calls);
          yield { type: "done" };
          return;
        }

        let chunk: GroqChunk;
        try {
          chunk = JSON.parse(payload) as GroqChunk;
        } catch {
          continue; // partial/garbled SSE line — skip, keep reading
        }

        if (chunk.error) {
          yield { type: "error", message: errText(chunk.error), reason: "provider_down" };
          return;
        }

        const choice = chunk.choices?.[0];
        const content = choice?.delta?.content;
        if (content) {
          if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
          yield { type: "token", text: content };
        }

        for (const tc of choice?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = calls.get(idx) ?? { id: tc.id ?? "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          calls.set(idx, acc);
        }

        if (choice?.finish_reason) {
          yield* flushCalls(calls);
          yield { type: "done" };
          return;
        }
      }
    }
    yield* flushCalls(calls);
    yield { type: "done" };
  } catch (err) {
    if (signal?.aborted) return; // caller cancelled — silent
    yield reachError(err);
  }
}

/** Emit the accumulated tool calls as RawFrames, once, when the stream closes. */
function* flushCalls(calls: Map<number, PartialCall>): Generator<RawFrame> {
  for (const c of [...calls.values()]) {
    if (!c.name) continue;
    yield {
      type: "toolCall",
      id: c.id || `call_${++toolCallSeq}`,
      name: c.name,
      args: parseArgs(c.args),
    };
  }
  calls.clear();
}

/** Non-streaming call — one round, returns the assembled message. Kept for
 *  parity with the Ollama adapter's interface (the route streams, but the
 *  contract is symmetric). */
export async function completeChat(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${GROQ_HOST}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      messages: toOpenAIMessages(messages),
      tools,
      stream: false,
      temperature: 0,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: DeltaToolCall[] } }>;
  };
  const msg = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => ({
    function: {
      name: c.function?.name ?? "",
      arguments: parseArgs(c.function?.arguments ?? ""),
    },
  }));
  return { content: msg?.content ?? "", toolCalls };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const key = process.env.GROQ_API_KEY ?? "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

/**
 * Our `ChatMessage` already matches the OpenAI shape for role/content. The one
 * seam is `tool_calls`: internally they carry a parsed args object; OpenAI wants
 * a stringified `arguments` and an `id`/`type`. Assistant turns that carried a
 * tool call are translated; everything else passes through untouched.
 */
function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: `call_${i}`,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments ?? {}),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Groq streams `arguments` as a JSON string, possibly fragmented; parse to an
 *  object. An empty or unparseable blob resolves to `{}` (governance rejects it
 *  as invalid rather than the adapter guessing). */
function parseArgs(raw: string): Record<string, unknown> {
  const t = raw.trim();
  if (!t) return {};
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

function errText(e: { message?: string } | string): string {
  return typeof e === "string" ? e : (e.message ?? "Provider error.");
}

/** Non-2xx from Groq. Auth, quota, and 5xx all read as "the live model isn't
 *  available" to the visitor — a stack trace helps no one at this door. */
async function httpError(res: Response): Promise<RawFrame> {
  let detail = "";
  try {
    const body = (await res.json()) as GroqChunk;
    if (body.error) detail = errText(body.error);
  } catch {
    /* body not JSON — status alone is enough */
  }
  const message =
    res.status === 401 || res.status === 403
      ? "The live model rejected the request (auth)."
      : res.status === 429
        ? "The live model is out of capacity right now."
        : `The live model returned ${res.status}.${detail ? ` ${detail}` : ""}`;
  return { type: "error", message, reason: "provider_down" };
}

function reachError(err: unknown): RawFrame {
  const msg = err instanceof Error ? err.message : String(err);
  // Detail stays in server logs; the visitor sees a dignified line, not a trace.
  console.error("[groq] transport error:", msg);
  return {
    type: "error",
    message: "Can't reach the live model right now.",
    reason: "provider_down",
  };
}
