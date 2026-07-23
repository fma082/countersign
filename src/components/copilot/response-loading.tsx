"use client";

import { AlertTriangle, CloudOff, RotateCcw, Timer } from "lucide-react";
import type { ErrorReason } from "@/lib/engine/types";

/**
 * Pattern 02 — AI Response Loading States, realized for the copilot log.
 *
 * The variants live across the transcript: `streaming` is the block cursor on the
 * assistant text, `tool calls` are the event cards, `done` is the settled message.
 * This file supplies the two that appear in the response's own slot: the pre-token
 * "thinking" dots, and the error state with retry.
 *
 * Both are TRANSITORY and tied to the statechart, not timers. The shell renders
 * them in the log — right where the answer will land — only while the status is
 * `thinking` / `error`, so they vanish the instant the first token arrives. They
 * are never committed as log entries.
 */

/** The <3s case: typing dots in the assistant's slot, before the first token. */
export function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1" role="status" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-ink-3"
          style={{ animation: "cs-typing 1.1s ease-in-out infinite", animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

/** The engine process failed. Icon + text (never colour alone) and a retry. */
export function ResponseError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-token border border-error/50 bg-field px-3 py-2.5">
      <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-error">
        <AlertTriangle size={13} className="mt-px flex-none" aria-hidden />
        {message ?? "The engine hit a problem."}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <RotateCcw size={11} />
        Retry
      </button>
    </div>
  );
}

/**
 * The dignified fallback — shown when the failure is *expected* rather than a
 * bug: the shared demo model is unavailable, or the visitor hit the per-IP rate
 * limit. This link lives for years and gets opened cold from old PDFs and
 * LinkedIn; whoever lands here in an interview must see an explained state, not
 * a stack trace. Distinct copy per reason, and a note on what Countersign is so
 * the page still communicates when the model can't.
 */
export function ResponseFallback({
  reason,
  message,
  onRetry,
}: {
  reason: ErrorReason;
  message: string | null;
  onRetry: () => void;
}) {
  const rate = reason === "rate_limit";
  const Icon = rate ? Timer : CloudOff;
  const heading = rate ? "Demo request limit reached" : "The live model isn't available right now";
  const fallbackBody = rate
    ? "This public demo caps requests per visitor to stay within a free-tier quota. Give it a moment and try again."
    : "The hosted model that answers here is temporarily unreachable. This isn't a bug in the demo — the model is a shared, free-tier backend.";

  return (
    <div className="rounded-token border border-line bg-field px-3.5 py-3">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">
        <Icon size={12} aria-hidden />
        {rate ? "Rate limited" : "Model offline"}
      </span>
      <p className="mt-1.5 text-[13px] font-medium text-ink">{heading}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{message ?? fallbackBody}</p>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
        Countersign is a demo of governed AI actions — reads run freely, single
        writes can be undone, and destructive changes stop at a human gate. That
        design is intact whether or not the model is answering.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <RotateCcw size={11} />
        Try again
      </button>
    </div>
  );
}
