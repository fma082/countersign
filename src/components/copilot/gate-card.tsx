"use client";

import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import type { GatePreview } from "@/lib/engine/types";
import { cn } from "@/lib/cn";

/**
 * The approval checkpoint — the visually strongest element in the whole UI.
 * Now with three exits: approve all, approve a subset, reject. Each target has a
 * checkbox (all checked by default). Unchecking excludes it by human judgment —
 * NOT because the resolver was wrong, but because the human holds context the
 * system doesn't (a running campaign, a customer's request). The exclusion is
 * sent as IDs; the server re-intersects against its own preview before running.
 */
export function GateCard({
  gate,
  resolved,
  excluded,
  onApprove,
  onReject,
}: {
  gate: GatePreview;
  resolved: "pending" | "approved" | "rejected";
  excluded?: number;
  onApprove: (excludedIds: string[]) => void;
  onReject: () => void;
}) {
  const [excludedSet, setExcludedSet] = useState<Set<string>>(new Set());

  if (resolved !== "pending") {
    return (
      <div className="rounded-token border border-line bg-field px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
        <span className="text-ink">{gate.title}</span> —{" "}
        {resolved === "approved"
          ? excluded
            ? `approved, ${excluded} excluded.`
            : "approved and applied."
          : "rejected. Nothing changed."}
      </div>
    );
  }

  const total = gate.items.length;
  const approveCount = total - excludedSet.size;

  const toggle = (sku: string) =>
    setExcludedSet((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });

  return (
    <div className="rounded-[10px] border-2 border-action bg-panel p-3.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-ink-3">Approval required</span>
      <h3 className="mt-1.5 text-[14px] font-medium text-ink">{gate.title}</h3>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{gate.description}</p>

      <ul className="mt-2.5 flex flex-col gap-0.5 border-t border-line pt-2">
        {gate.items.map((it) => {
          const isExcluded = excludedSet.has(it.sku);
          return (
            <li key={it.sku}>
              <label
                className={cn(
                  "flex cursor-pointer items-baseline justify-between gap-2 rounded-[6px] px-1.5 py-1 text-[11.5px] transition-opacity hover:bg-sub",
                  isExcluded && "opacity-40",
                  it.warn && !isExcluded ? "text-ink" : "text-ink-2",
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <input
                    type="checkbox"
                    checked={!isExcluded}
                    onChange={() => toggle(it.sku)}
                    className="size-3 flex-none translate-y-0.5 accent-[var(--interactive-primary)]"
                  />
                  <span className="truncate">{it.name}</span>
                </span>
                <span
                  className={cn(
                    "inline-flex flex-none items-center gap-1 font-mono text-[10.5px]",
                    it.warn && !isExcluded ? "text-error" : "text-ink-3",
                  )}
                >
                  {it.warn && !isExcluded && <AlertTriangle size={10} aria-hidden />}
                  {it.detail}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => onApprove([...excludedSet])}
          disabled={approveCount === 0}
          className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-action px-3.5 py-2 text-[12.5px] font-medium text-on-action transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Check size={13} />
          {excludedSet.size === 0 ? `Approve all ${total}` : `Approve ${approveCount} of ${total}`}
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
