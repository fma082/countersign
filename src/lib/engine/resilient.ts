/**
 * Resilience layer — retries a transient model failure before it ever reaches
 * the visitor.
 *
 * The demo runs on a free-tier backend that intermittently answers "out of
 * capacity". On its own that lands the visitor in a failure state, sometimes
 * mid-flow. This wrapper absorbs the blip: it re-attempts the provider call with
 * growing backoff and only surfaces an error once the retries are spent. During
 * the wait nothing is emitted — the turn is still in `thinking`, so the log's
 * loading indicator already reads as "the agent is working", not "it broke".
 *
 * Two rules keep it honest and safe:
 *   - Only `model_paused` (transient: capacity, 5xx, network) is retried.
 *     `provider_error` (a contract/auth bug) and `rate_limit` are surfaced at
 *     once — retrying them just hammers a doomed request.
 *   - A retry only happens if the failure is the FIRST thing the attempt
 *     produced. Once a token or tool call has streamed, we never re-run — that
 *     would duplicate output. (The capacity failure fails at connect time, so
 *     this covers the real case.)
 *
 * It changes no engine logic; it wraps the provider stream and yields the exact
 * same RawFrame contract.
 */

import type { ChatMessage, ErrorReason, ProviderTool, RawFrame } from "./types";
import { streamChat } from "./provider";

/** Backoff schedule (ms) between attempts. Its length is the retry count. */
const BACKOFF_MS = parseList(process.env.MODEL_RETRY_BACKOFF_MS, [1000, 2500, 5000]);

/**
 * Test affordance (off unless set): force every provider attempt to fail with a
 * given reason, to exercise the retry → degrade path without waiting on the real
 * backend to be down. `MODEL_FORCE_ERROR=model_paused` drives the full
 * retry-then-fallback flow; `provider_error` the permanent path.
 */
const FORCE_ERROR = normalizeForce(process.env.MODEL_FORCE_ERROR);

const isRetryable = (reason?: ErrorReason): boolean => reason === "model_paused";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* streamChatResilient(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): AsyncGenerator<RawFrame> {
  const maxRetries = BACKOFF_MS.length;

  for (let attempt = 0; ; attempt++) {
    let emittedOutput = false;
    let retryErr: (RawFrame & { type: "error" }) | null = null;

    for await (const frame of attemptStream(messages, tools, signal)) {
      if (frame.type === "error") {
        if (!emittedOutput && isRetryable(frame.reason) && attempt < maxRetries) {
          retryErr = frame; // hold it; back off and retry below
          break;
        }
        yield frame; // permanent, mid-stream, or retries spent — surface it
        return;
      }
      emittedOutput = true;
      yield frame;
      if (frame.type === "done") return;
    }

    if (!retryErr) return; // stream ended without error and without `done`
    if (signal?.aborted) return;
    await sleep(BACKOFF_MS[attempt]);
    if (signal?.aborted) return;
    // loop → next attempt
  }
}

/** One provider attempt, or the forced-error stand-in when the test hook is on. */
async function* attemptStream(
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal?: AbortSignal,
): AsyncGenerator<RawFrame> {
  if (FORCE_ERROR) {
    yield {
      type: "error",
      message:
        FORCE_ERROR === "model_paused"
          ? "The model is out of capacity right now. (forced)"
          : "Forced provider error.",
      reason: FORCE_ERROR,
    };
    return;
  }
  yield* streamChat(messages, tools, signal);
}

// ── config parsing ──────────────────────────────────────────────────────────

function parseList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : fallback;
}

function normalizeForce(raw: string | undefined): ErrorReason | undefined {
  if (raw === "model_paused" || raw === "provider_error") return raw;
  return undefined;
}
