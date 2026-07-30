"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { isBusy, isGateOpen } from "@/lib/copilot-statechart";
import { useCopilot, type CopilotCallbacks } from "@/components/copilot/use-copilot";
import { StatusBadge } from "@/components/copilot/status-badge";
import { ToolCard } from "@/components/copilot/tool-card";
import { GateCard } from "@/components/copilot/gate-card";
import { ThinkingDots } from "@/components/copilot/response-loading";
import { wedgeReplay, WEDGE_PROMPT } from "@/lib/home/pattern-scripts";
import { cn } from "@/lib/cn";

// Landing demos are scripted: nothing here should touch a table or a live model.
// The landing demo has no table, so there is no view for an effect to change
// and no filter to report. It still has to answer `getFilter` — the panel puts
// it in every request body — and the honest answer is the empty criterion.
const NOOP_CALLBACKS: CopilotCallbacks = {
  onEffect() {},
  onGateOpen() {},
  onGateClose() {},
  getFilter: () => ({ kind: "none" }),
};

/**
 * Pattern 04 — the wedge, replaying a recorded session on the landing page.
 *
 * It drives the REAL `useCopilot` + `GateCard`, just with a scripted transport
 * instead of the engine. The human still makes the actual decision — approve
 * all, a subset, or reject — and the panel reflects exactly what the server
 * recorded. The chrome says "scripted" so the demo never implies a live model.
 */
export function WedgeDemo() {
  const copilot = useCopilot(NOOP_CALLBACKS, { replay: wedgeReplay });
  const { status, log, errorReason, approve, reject, submitPrompt, reset } = copilot;
  const logRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const undoDisabled = isBusy(status) || isGateOpen(status);

  // Auto-play once when the demo mounts (i.e. when the row is expanded).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    submitPrompt(WEDGE_PROMPT);
  }, [submitPrompt]);

  // Keep the newest frame in view as the script plays.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, status]);

  const replay = () => {
    reset();
    // Let the reset flush before seeding the next run.
    setTimeout(() => submitPrompt(WEDGE_PROMPT), 60);
  };

  return (
    <div className="overflow-hidden rounded-token border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[13px] font-medium text-ink">Copilot</span>
        <StatusBadge status={status} errorReason={errorReason} />
      </header>

      <div ref={logRef} className="flex max-h-[440px] min-h-[300px] flex-col gap-3 overflow-y-auto px-4 py-4">
        {log.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <p key={item.id} className="max-w-[88%] self-end rounded-token bg-sub px-3 py-2 text-[12.5px] text-ink">
                  {item.text}
                </p>
              );
            case "assistant":
              return (
                <p key={item.id} className="text-[13px] leading-relaxed text-ink">
                  {item.text}
                  {item.streaming && (
                    <span className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-0.5 animate-pulse bg-ink align-baseline" />
                  )}
                </p>
              );
            case "tool":
              return (
                <ToolCard
                  key={item.id}
                  event={item.event}
                  undoState={item.undoState}
                  undoNote={item.undoNote}
                  undoDisabled={undoDisabled}
                />
              );
            case "gate":
              return (
                <GateCard
                  key={item.id}
                  gate={item.gate}
                  resolved={item.resolved}
                  excluded={item.excluded}
                  onApprove={approve}
                  onReject={reject}
                />
              );
            default:
              return null;
          }
        })}
        {status === "thinking" && <ThinkingDots />}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[10px] text-ink-3">
        <span>Scripted replay of a recorded session — no live model.</span>
        <button
          type="button"
          onClick={replay}
          className="inline-flex flex-none items-center gap-1 transition-colors hover:text-ink-2"
        >
          <RotateCcw size={10} />
          Replay
        </button>
      </div>
    </div>
  );
}

/**
 * One row of the "Interface patterns" index. With a `demo`, the row becomes a
 * disclosure that mounts the interactive example beneath it; without one it is
 * the same static index line as before.
 */
export function PatternRow({
  n,
  name,
  line,
  count,
  wedge,
  demo,
}: {
  n: string;
  name: string;
  line: string;
  count: string;
  wedge?: boolean;
  demo?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (!demo) {
    return (
      <li className="flex items-baseline gap-4 border-b border-line py-4 sm:gap-6">
        <span className="font-mono text-[12px] text-ink-3">{n}</span>
        <div className="min-w-0 flex-1">
          <span className="text-[15px] font-medium text-ink">{name}</span>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{line}</p>
        </div>
        <span className={wedge ? "flex-none text-[11px] font-medium text-ink" : "flex-none text-[11px] text-ink-3"}>
          {count}
        </span>
      </li>
    );
  }

  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-4 py-4 text-left sm:gap-6"
      >
        <span className="font-mono text-[12px] text-ink-3">{n}</span>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1.5 text-[15px] font-medium text-ink">
            {name}
            <ChevronRight
              size={14}
              className={cn("text-ink-3 transition-transform", open && "rotate-90")}
              aria-hidden
            />
          </span>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{line}</p>
        </div>
        <span className={wedge ? "flex-none text-[11px] font-medium text-ink" : "flex-none text-[11px] text-ink-3"}>
          {open ? "try it" : count}
        </span>
      </button>
      {open && <div className="pb-5">{demo}</div>}
    </li>
  );
}
