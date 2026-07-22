"use client";

import { cn } from "@/lib/cn";
import { GUIDED_INTRO, GUIDED_STEPS } from "@/lib/scenario/guided-steps";

/**
 * The guided start: a welcome line and the four steps as stacked commands. Only
 * the active step is clickable; done steps are struck through, future steps are
 * dimmed. Steps 03 and 04 announce their tier ("reversible", "destructive")
 * before the click — the tension is built before you press anything.
 */
export function GuidedSteps({
  step,
  onRun,
}: {
  step: number; // the active step index
  onRun: (i: number) => void;
}) {
  return (
    <div className="rounded-token border border-dashed border-line-strong p-3.5">
      <p className="text-[13px] font-medium text-ink">{GUIDED_INTRO.title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{GUIDED_INTRO.sub}</p>

      <div className="mt-3 flex flex-col gap-1.5">
        {GUIDED_STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <button
              key={i}
              type="button"
              disabled={!active}
              onClick={() => onRun(i)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-[6px] border px-3 py-2 text-left transition-colors",
                active
                  ? "border-action text-ink shadow-[inset_0_0_0_1px_var(--interactive-primary)] hover:bg-sub"
                  : "border-line",
                done && "opacity-40",
                !active && !done && "opacity-40",
              )}
            >
              <span className="mt-px w-4 flex-none font-mono text-[10.5px] text-ink-3">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[12.5px] text-ink", done && "line-through")}>
                  {s.label}
                </span>
                <span className="mt-0.5 block text-[10.5px] tracking-[0.02em] text-ink-3">
                  {s.tier}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Split **bold** spans out of a note/closing string. Terse rich text only. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-medium text-ink-2">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
