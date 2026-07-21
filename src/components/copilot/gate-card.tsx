"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import type { GatePreview } from "@/lib/engine/types";
import { cn } from "@/lib/cn";

/**
 * The approval checkpoint — the visually strongest element in the whole UI.
 * Heavy border, "Approval required" badge, server-side preview resolved by
 * name, Approve / Reject. Once resolved it collapses to a quiet record.
 */
export function GateCard({
  gate,
  resolved,
  onApprove,
  onReject,
}: {
  gate: GatePreview;
  resolved: "pending" | "approved" | "rejected";
  onApprove: () => void;
  onReject: () => void;
}) {
  if (resolved !== "pending") {
    return (
      <div className="rounded-token border border-line bg-field px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
        <span className="text-ink">{gate.title}</span> —{" "}
        {resolved === "approved" ? "approved and applied." : "rejected. Nothing changed."}
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border-2 border-action bg-panel p-3.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-ink-3">
        Approval required
      </span>
      <h3 className="mt-1.5 text-[14px] font-medium text-ink">{gate.title}</h3>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{gate.description}</p>

      <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">
        {gate.items.map((it) => (
          <li
            key={it.sku}
            className={cn(
              "flex items-baseline justify-between gap-2 text-[11.5px]",
              it.warn ? "text-ink" : "text-ink-2",
            )}
          >
            <span className="truncate">{it.name}</span>
            <span
              className={cn(
                "inline-flex flex-none items-center gap-1 font-mono text-[10.5px]",
                it.warn ? "text-error" : "text-ink-3",
              )}
            >
              {it.warn && <AlertTriangle size={10} aria-hidden />}
              {it.detail}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-action px-3.5 py-2 text-[12.5px] font-medium text-on-action transition-opacity hover:opacity-90"
        >
          <Check size={13} />
          Approve
        </button>
        <button
          type="button"
          onClick={onReject}
          className="inline-flex items-center justify-center gap-1.5 rounded-[6px] border border-line px-3.5 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          <X size={13} />
          Reject
        </button>
      </div>
    </div>
  );
}
