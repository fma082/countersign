"use client";

import { ArrowUp, Square } from "lucide-react";
import type { CopilotStatus } from "@/lib/copilot-statechart";
import { canCancel, canType, isGateOpen } from "@/lib/copilot-statechart";
import { MODEL_LABEL, PROVIDER_LABEL } from "@/lib/engine/provider-info";

export function Composer({
  status,
  draft,
  onDraft,
  onSubmit,
  onCancel,
}: {
  status: CopilotStatus;
  draft: string;
  onDraft: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const gateOpen = isGateOpen(status);
  const typeable = canType(status);
  const showCancel = canCancel(status);

  return (
    <div className="border-t border-line px-4 py-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex items-center gap-2"
      >
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          disabled={!typeable}
          placeholder={gateOpen ? "Waiting for your decision…" : "Ask about the catalog…"}
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
              disabled={draft.trim().length === 0}
              aria-label="Send"
              className="flex size-8 flex-none items-center justify-center rounded-full bg-action text-on-action transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          )
        )}
      </form>
      <p className="mt-2 text-center text-[10px] text-ink-3">
        {PROVIDER_LABEL} · {MODEL_LABEL}
      </p>
    </div>
  );
}
