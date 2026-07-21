/**
 * Adapter frame — the ONLY module that knows how to talk to Ollama.
 *
 * It emits raw frames and nothing else. It is ignorant of governance: it does
 * not know what a "gate" is, does not compute previews, does not label counts.
 * Swapping Ollama for a cloud provider means rewriting THIS FILE ONLY — the
 * governance layer above it must not change.
 *
 * Transport: fetch + ReadableStream against Ollama's NDJSON /api/chat.
 */

import type { ChatMessage, RawFrame, ToolCall } from "./types";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
export const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
export const PROVIDER_LABEL = "Ollama";

/** A tool definition in the provider's expected shape (JSON-schema function). */
export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChunk {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  error?: string;
}

let toolCallSeq = 0;

/**
 * Stream a chat completion as raw frames. Provider-agnostic signature:
 * messages in, RawFrames out. The caller owns governance and cancellation.
 */
export async function* streamChat(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): AsyncGenerator<RawFrame> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        stream: true,
        options: { temperature: 0 },
      }),
      signal,
    });
  } catch (err) {
    yield { type: "error", message: reachError(err) };
    return;
  }

  if (!res.ok || !res.body) {
    yield {
      type: "error",
      message: `Provider returned ${res.status}. Is \`${MODEL}\` pulled in Ollama?`,
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // NDJSON: one JSON object per line.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue; // partial/garbled line — skip, keep reading
        }

        if (chunk.error) {
          yield { type: "error", message: chunk.error };
          return;
        }

        const content = chunk.message?.content;
        if (content) yield { type: "token", text: content };

        const calls = chunk.message?.tool_calls;
        if (calls?.length) {
          for (const c of calls) {
            yield {
              type: "toolCall",
              id: `call_${++toolCallSeq}`,
              name: c.function?.name ?? "",
              args: normalizeArgs(c.function?.arguments),
            };
          }
        }

        if (chunk.done) {
          yield { type: "done" };
          return;
        }
      }
    }
    yield { type: "done" };
  } catch (err) {
    if (signal?.aborted) return; // caller cancelled — silent
    yield { type: "error", message: reachError(err) };
  }
}

/** Ollama may hand arguments as an object or a JSON string; normalize to object. */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function reachError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|network/i.test(msg)) {
    return `Can't reach the model at ${OLLAMA_HOST}. Is Ollama running?`;
  }
  return msg;
}

/** Non-streaming call — one round, returns the assembled message. Used for the
 *  short "digest the tool result" round where streaming buys nothing. */
export async function completeChat(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      options: { temperature: 0 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  const data = (await res.json()) as OllamaChunk;
  const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).map((c) => ({
    function: {
      name: c.function?.name ?? "",
      arguments: normalizeArgs(c.function?.arguments),
    },
  }));
  return { content: data.message?.content ?? "", toolCalls };
}
