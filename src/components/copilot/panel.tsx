"use client";

import { useEffect, useRef } from "react";
import type { useCopilot } from "./use-copilot";
import { StatusBadge } from "./status-badge";
import { ToolCard } from "./tool-card";
import { GateCard } from "./gate-card";
import { Composer } from "./composer";

type Copilot = ReturnType<typeof useCopilot>;

/** Presentational copilot panel. All state lives in the useCopilot instance the
 *  scenario shell owns (so table effects and the transcript stay in sync). */
export function CopilotPanel({ copilot }: { copilot: Copilot }) {
  const { status, draft, log, setDraft, submit, cancel, approve, reject } = copilot;
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="flex min-h-0 flex-col bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <span className="text-[14px] font-medium text-ink">Copilot</span>
        <StatusBadge status={status} />
      </header>

      <div ref={logRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {log.length === 0 && <EmptyState />}
        {log.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <p
                  key={item.id}
                  className="max-w-[88%] self-end rounded-token bg-sub px-3 py-2 text-[12.5px] text-ink"
                >
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
              return <ToolCard key={item.id} event={item.event} />;
            case "gate":
              return (
                <GateCard
                  key={item.id}
                  gate={item.gate}
                  resolved={item.resolved}
                  onApprove={approve}
                  onReject={reject}
                />
              );
          }
        })}
      </div>

      <Composer
        status={status}
        draft={draft}
        onDraft={setDraft}
        onSubmit={submit}
        onCancel={cancel}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-2 rounded-token border border-dashed border-line-strong p-4">
      <p className="text-[13px] font-medium text-ink">Ask the copilot</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        Try “how many products are on an expired sale?”, “filter to the ones below
        cost and show margin”, or “clean up the expired sales”.
      </p>
    </div>
  );
}
