"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight, Undo2 } from "lucide-react";
import type { ResultBadge, ToolEvent } from "@/lib/engine/types";
import type { UndoState } from "./use-copilot";
import { cn } from "@/lib/cn";

/**
 * A tool call as an event card: mono name + result badge + effect summary +
 * collapsible args. The badge tells the truth — "invalid" is never dressed as
 * "ok". A reversible write also carries an Undo control that lives HERE, on the
 * action itself — no toast, no countdown. When the window closes the card keeps
 * the record and loses only the control.
 */
export function ToolCard({
  event,
  undoState,
  undoNote,
  undoDisabled,
  onUndo,
}: {
  event: ToolEvent;
  undoState?: UndoState;
  undoNote?: string;
  undoDisabled?: boolean;
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasArgs = Object.keys(event.args).length > 0;

  return (
    <div className="rounded-token border border-line bg-field px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11.5px] text-ink">{event.name}</span>
        <ResultChip badge={event.badge} />
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{event.summary}</p>

      {typeof event.excluded !== "undefined" && event.excluded.length > 0 && (
        <p className="mt-1 text-[10.5px] text-ink-3">
          Excluded: {event.excluded.join(", ")}
        </p>
      )}

      {hasArgs && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] text-ink-3 transition-colors hover:text-ink-2"
            aria-expanded={open}
          >
            <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
            arguments
          </button>
          {open && (
            <pre className="mt-1.5 overflow-x-auto rounded-[6px] bg-sub px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
              {JSON.stringify(event.args, null, 2)}
            </pre>
          )}
        </>
      )}

      {undoState === "active" ? (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2">
          <span className="text-[10.5px] leading-tight text-ink-3">
            Reversible until the next write
          </span>
          <button
            type="button"
            onClick={onUndo}
            disabled={undoDisabled}
            className="inline-flex flex-none items-center gap-1.5 rounded-[6px] border border-action px-2.5 py-1 text-[11.5px] font-medium text-ink transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            <Undo2 size={12} />
            Undo
          </button>
        </div>
      ) : (
        undoNote && (
          <p className="mt-2.5 border-t border-line pt-2 text-[10.5px] text-ink-3">{undoNote}</p>
        )
      )}
    </div>
  );
}

function ResultChip({ badge }: { badge: ResultBadge }) {
  const alert = badge === "invalid" || badge === "error";
  const label = badge;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px]",
        alert ? "border-error text-error" : "border-line text-ink-2",
      )}
    >
      {alert && <AlertTriangle size={10} aria-hidden />}
      {label}
    </span>
  );
}
