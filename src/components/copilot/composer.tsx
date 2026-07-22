"use client";

import { ArrowUp, RotateCcw, Square } from "lucide-react";
import type { CopilotStatus } from "@/lib/copilot-statechart";
import { canCancel, canType, isGateOpen } from "@/lib/copilot-statechart";
import { MODEL_LABEL, PROVIDER_LABEL } from "@/lib/engine/provider-info";

export function Composer({
  status,
  draft,
  onDraft,
  onSubmit,
  onCancel,
  locked,
  lockedPlaceholder,
  onReset,
}: {
  status: CopilotStatus;
  draft: string;
  onDraft: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Free input is held shut during the guided flow. */
  locked?: boolean;
  lockedPlaceholder?: string;
  onReset?: () => void;
}) {
  const gateOpen = isGateOpen(status);
  const showCancel = canCancel(status);
  const typeable = canType(status) && !locked;

  const placeholder = gateOpen
    ? "Waiting for your decision…"
    : locked
      ? (lockedPlaceholder ?? "Complete the steps above to unlock free input.")
      : "Ask anything…";

  return (
    <div className="border-t border-line px-4 py-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!locked) onSubmit();
        }}
        className="flex items-center gap-2"
      >
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          disabled={!typeable}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-full border border-line bg-field px-4 py-2 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none disabled:opacity-70"
        />
        {showCancel ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Stop"
            className="flex size-8 flex-none items-center justify-center rounded-full border border-line text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            <Square size={12} />
          </button>
        ) : (
          // No cancel button at the gate — the engine is already stopped.
          !gateOpen && (
            <button
              type="submit"
              disabled={locked || draft.trim().length === 0}
              aria-label="Send"
              className="flex size-8 flex-none items-center justify-center rounded-full bg-action text-on-action transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          )
        )}
      </form>
      <div className="mt-2 flex items-center justify-center gap-3 text-[10px] text-ink-3">
        <span>
          {PROVIDER_LABEL} · {MODEL_LABEL}
        </span>
        {onReset && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1 transition-colors hover:text-ink-2"
            >
              <RotateCcw size={10} />
              Reset scenario
            </button>
          </>
        )}
      </div>
    </div>
  );
}
