"use client";

import { AlertTriangle, PauseCircle, RotateCcw, Timer } from "lucide-react";

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
 * Model paused — an EXPECTED pause, not a fault. It borrows the approval gate's
 * register (the action-coloured accent, the calm uppercase badge) precisely
 * because both are "the system is holding on purpose", not "something broke". It
 * is deliberately NOT in the error vocabulary — no red, no alarm — and the copy
 * reaffirms the thesis instead of apologising: the guarantees hold without the
 * model. Used when the model's retries are spent (`model_paused`).
 */
export function ResponsePaused({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-[10px] border border-action bg-panel px-3.5 py-3">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">
        <span className="size-1.5 rounded-full bg-action" aria-hidden />
        <PauseCircle size={12} aria-hidden />
        Model paused · system intact
      </span>
      <p className="mt-1.5 text-[13px] font-medium text-ink">
        {message ?? "The model is paused."}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        Countersign&rsquo;s guarantees hold without it — reads, undo, and the
        approval gate are enforced by the system, not the model. What&rsquo;s on
        hold is only the model&rsquo;s spoken reply.
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

/**
 * Rate limited — our OWN per-IP cap, not the model. Also a calm, expected state
 * (the demo protecting a free-tier quota), so it stays out of the error
 * vocabulary too, with its own copy.
 */
export function ResponseRateLimit({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-token border border-line bg-field px-3.5 py-3">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">
        <Timer size={12} aria-hidden />
        Rate limited
      </span>
      <p className="mt-1.5 text-[13px] font-medium text-ink">Demo request limit reached</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        {message ??
          "This public demo caps requests per visitor to stay within a free-tier quota. Give it a moment and try again."}
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
