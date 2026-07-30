"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import {
  COMPARE_FIELDS,
  COMPARE_OPS,
  FIELD_SPEC,
  FILTER_PRESETS,
  NO_FILTER,
  OP_SPEC,
  PRESET_SPEC,
} from "@/lib/engine/filter-spec";
import type { CompareField, CompareOp, FilterState, ResolvedFilter } from "@/lib/engine/types";
import { cn } from "@/lib/cn";

/**
 * The human's filter controls — and the whole point of them is that they are
 * not "the human's".
 *
 * There is no control here for the revealed columns, and that is the design
 * rather than an omission. Margin and Sale ends follow the ACTIVE CRITERION,
 * resolved server-side: the criterion that is about margin puts Margin up, and
 * clearing the filter — one click on the ✕ below — takes it down. A separate
 * toggle would be a second way to reach a column whose whole guarantee is that
 * only one question can reach it.
 *
 * Every control here emits a `FilterState` and posts it to the same endpoint
 * the model's `filter_view` and `filter_compare` reach, which run the same
 * resolver and return the same effect. The agent has no channel to change this
 * table that is missing from this bar, and nothing it sets lands anywhere the ✕
 * below cannot undo. A filter the agent applied and a filter the human applied
 * are the same object; this bar does not say which, because there is nothing to
 * say. The copilot log is where the agent's actions are accounted for.
 *
 * It also does not RESOLVE anything. The chips send a criterion and render the
 * label that comes back — `describeFilter`'s string, verbatim, the same one the
 * model is handed in its `Current view:` line. Nothing here composes a sentence
 * about the view, because two sentences about one table is how a human and a
 * model end up disagreeing about what is on screen.
 */
export function FilterBar({
  filter,
  onApply,
  disabled,
}: {
  /** What the server last resolved. `null` — never filtered this session. */
  filter: ResolvedFilter | null;
  onApply: (next: FilterState) => void;
  /** The engine is mid-turn or parked at a gate; the view is not the human's to
   *  move right now. The controls stay VISIBLE and go inert — removing them
   *  would make the bar flicker out exactly when the table is most in flux. */
  disabled?: boolean;
}) {
  const state = filter?.state ?? NO_FILTER;
  const activePreset = state.kind === "preset" ? state.preset : null;
  const applied = state.kind !== "none" ? filter : null;

  const apply = useCallback(
    (next: FilterState) => {
      if (!disabled) onApply(next);
    },
    [disabled, onApply],
  );

  const clear = useCallback(() => {
    if (applied) apply(NO_FILTER);
  }, [applied, apply]);

  // Escape clears. The ✕ is the visible affordance; this is the one every
  // keyboard user reaches for first, and a filter you cannot leave is the
  // failure this bar exists to fix.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  return (
    <div className="flex flex-col gap-2 border-b border-line px-6 py-2.5">
      {/* Presets — every group the agent can name, so the human can name it too. */}
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {FILTER_PRESETS.map((p) => {
          const on = activePreset === p;
          return (
            <button
              key={p}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => apply(on ? NO_FILTER : { kind: "preset", preset: p })}
              className={cn(
                "inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                "disabled:opacity-40",
                on
                  ? // Filled AND a check. Monochrome throughout, so a fill alone
                    // would be the only signal — and one signal is never enough.
                    "border-action bg-action text-on-action"
                  : "border-line text-ink-2 hover:border-line-strong hover:text-ink",
              )}
            >
              {on && <Check size={11} aria-hidden />}
              {PRESET_SPEC[p].chip}
            </button>
          );
        })}
      </div>

      {/* The free comparison, plus whatever is currently applied. Wraps rather
          than truncates: the applied label is the server's own sentence and
          reading half of it is worse than reading it on a second line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Comparison state={state} disabled={disabled} onApply={apply} />

        {applied && (
          <AppliedChip
            label={applied.label}
            count={applied.count}
            disabled={disabled}
            onClear={clear}
          />
        )}
      </div>
    </div>
  );
}

/** `field · operator · value`. Three closed vocabularies and one free number. */
function Comparison({
  state,
  disabled,
  onApply,
}: {
  state: FilterState;
  disabled?: boolean;
  onApply: (next: FilterState) => void;
}) {
  // A draft, not the applied state: typing a number is not filtering by it.
  // Seeded from the applied comparison so re-opening it shows what ran.
  const [field, setField] = useState<CompareField>(
    state.kind === "compare" ? state.field : "stock",
  );
  const [op, setOp] = useState<CompareOp>(state.kind === "compare" ? state.op : "lt");
  const [value, setValue] = useState<string>(state.kind === "compare" ? String(state.value) : "");

  const n = Number(value);
  const usable = value.trim() !== "" && Number.isFinite(n) && n >= 0;

  const submit = () => {
    if (usable && !disabled) onApply({ kind: "compare", field, op, value: n });
  };

  return (
    <div className="flex flex-none items-center gap-1.5">
      <select
        aria-label="Field to compare"
        disabled={disabled}
        value={field}
        onChange={(e) => setField(e.target.value as CompareField)}
        className={selectClass}
      >
        {COMPARE_FIELDS.map((f) => (
          <option key={f} value={f}>
            {FIELD_SPEC[f].chip}
          </option>
        ))}
      </select>

      <select
        aria-label="Comparison operator"
        disabled={disabled}
        value={op}
        onChange={(e) => setOp(e.target.value as CompareOp)}
        className={cn(selectClass, "text-center font-mono")}
      >
        {COMPARE_OPS.map((o) => (
          // The symbol is the UI's business — the model picks `lt`, the human
          // reads `<`. `OP_SPEC` holds both so neither is a second spelling.
          <option key={o} value={o}>
            {OP_SPEC[o].symbol}
          </option>
        ))}
      </select>

      <input
        type="number"
        min={0}
        inputMode="decimal"
        aria-label="Value to compare against"
        disabled={disabled}
        value={value}
        placeholder="value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className={cn(selectClass, "w-[74px] tabular-nums placeholder:text-ink-3")}
      />

      <button
        type="button"
        disabled={disabled || !usable}
        onClick={submit}
        className={cn(
          "flex-none rounded-[6px] border border-action px-2.5 py-1 text-[11.5px] font-medium text-ink",
          "transition-opacity hover:opacity-80 disabled:opacity-40",
        )}
      >
        Apply
      </button>
    </div>
  );
}

const selectClass =
  "flex-none rounded-[6px] border border-line bg-field px-2 py-1 text-[11.5px] text-ink disabled:opacity-40";

/**
 * What is on screen, and the way off it.
 *
 * The label is printed VERBATIM — it is the server's description of the
 * criterion it ran, the same string in the model's prompt. The count beside it
 * is the server's too. This chip answers both halves of the question a filtered
 * table used to leave open: what am I looking at, and how do I get out.
 */
function AppliedChip({
  label,
  count,
  disabled,
  onClear,
}: {
  label: string;
  count: number;
  disabled?: boolean;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-action bg-sub py-1 pl-2.5 pr-1 text-[11.5px] text-ink">
      <span className="min-w-0">
        <span className="tabular-nums">{count}</span> {label}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        aria-label={`Clear the filter — ${label}`}
        title="Clear the filter (Esc)"
        className="flex size-4 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-panel hover:text-ink disabled:opacity-40"
      >
        <X size={11} aria-hidden />
      </button>
    </span>
  );
}
