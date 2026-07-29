"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, PauseCircle } from "lucide-react";
import { isBusy, isGateOpen } from "@/lib/copilot-statechart";
import type { StaleUndo } from "@/lib/engine/types";
import type { useCopilot } from "./use-copilot";
import { RichText } from "./guided";
import { StatusBadge } from "./status-badge";
import { ToolCard } from "./tool-card";
import { GateCard } from "./gate-card";
import { ProductDetail } from "./product-detail";
import { ProductList } from "./product-list";
import { Composer } from "./composer";
import { ResponseError, ResponsePaused, ResponseRateLimit, ThinkingDots } from "./response-loading";

type Copilot = ReturnType<typeof useCopilot>;

/** Presentational copilot panel. All state lives in the useCopilot instance the
 *  scenario shell owns (so table effects and the transcript stay in sync). */
export function CopilotPanel({
  copilot,
  guidedSlot,
  locked,
  lockedPlaceholder,
  onReset,
}: {
  copilot: Copilot;
  /** The interactive guided block, rendered at the foot of the log. */
  guidedSlot?: ReactNode;
  /** Free input is held shut while the guided flow runs. */
  locked?: boolean;
  lockedPlaceholder?: string;
  onReset?: () => void;
}) {
  const { state, status, draft, log, gate, stale, errorReason, setDraft, submit, cancel, retry, approve, reject, undo, confirmStale, cancelStale } = copilot;
  const logRef = useRef<HTMLDivElement>(null);
  const undoDisabled = isBusy(status) || isGateOpen(status);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, stale, guidedSlot, status]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <span className="text-[14px] font-medium text-ink">Copilot</span>
        <StatusBadge status={status} errorReason={errorReason} />
      </header>

      <div ref={logRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {log.length === 0 && <EmptyState />}
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
                  onUndo={undo}
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
            case "render":
              // Generative UI: the resolved rows, rendered where they landed in
              // the turn. The model's prose stays — they are two halves of one
              // answer, not alternatives.
              //
              // The vocabulary is closed on purpose. A `component` the client
              // does not know renders NOTHING rather than guessing a fallback:
              // a payload shaped for a component that does not exist here is a
              // server/client version skew, and half-drawing it would put a
              // partial record on screen with the same authority as a whole one.
              switch (item.render.component) {
                case "product_list":
                  return <ProductList key={item.id} payload={item.render} />;
                case "product_detail":
                  return <ProductDetail key={item.id} payload={item.render} />;
                default:
                  return null;
              }
            case "note":
              return (
                <p
                  key={item.id}
                  className="border-l-2 border-line-strong pl-3 text-[11.5px] leading-relaxed text-ink-3"
                >
                  <RichText text={item.text} />
                </p>
              );
            case "closing":
              return (
                <p
                  key={item.id}
                  className="rounded-token border border-line bg-field px-3.5 py-3 text-[13px] leading-relaxed text-ink"
                >
                  {item.text}
                </p>
              );
            case "paused":
              // The model is paused; the real tool effect lands right after this.
              // Borrows the gate's action accent — an expected pause, not a fault.
              return (
                <div
                  key={item.id}
                  className="rounded-token border border-action/60 bg-panel px-3 py-2.5"
                >
                  <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">
                    <span className="size-1.5 rounded-full bg-action" aria-hidden />
                    <PauseCircle size={11} aria-hidden />
                    Model paused
                  </span>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{item.text}</p>
                </div>
              );
          }
        })}

        {/* Transitory response-loading state, in the answer's own slot. Tied to
            the statechart — the dots vanish the instant the first token lands. */}
        {status === "thinking" && <ThinkingDots />}
        {status === "error" &&
          (errorReason === "model_paused" ? (
            // Expected pause — reframed, not an error surface.
            <ResponsePaused message={state.error} onRetry={retry} />
          ) : errorReason === "rate_limit" ? (
            <ResponseRateLimit message={state.error} onRetry={retry} />
          ) : (
            // provider_error (a real fault) or a client-side interruption.
            <ResponseError message={state.error} onRetry={retry} />
          ))}

        {stale && <StaleConfirm stale={stale} onConfirm={confirmStale} onCancel={cancelStale} />}
        {guidedSlot}
      </div>

      <Composer
        status={status}
        draft={draft}
        onDraft={setDraft}
        onSubmit={submit}
        onCancel={cancel}
        locked={locked}
        lockedPlaceholder={lockedPlaceholder}
        onReset={onReset}
      />
    </div>
  );
}

function StaleConfirm({
  stale,
  onConfirm,
  onCancel,
}: {
  stale: StaleUndo;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-[10px] border-2 border-action bg-panel p-3.5">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">
        <AlertTriangle size={11} /> State changed
      </span>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
        <span className="text-ink">{stale.spec.name}</span> has changed since that action
        — its {stale.field} is now{" "}
        <span className="font-mono text-ink">{String(stale.actual)}</span>, not{" "}
        <span className="font-mono">{String(stale.expected)}</span>. Undo anyway and restore{" "}
        <span className="font-mono text-ink">{String(stale.spec.from)}</span>?
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-[6px] bg-action px-3.5 py-2 text-[12.5px] font-medium text-on-action transition-opacity hover:opacity-90"
        >
          Undo anyway
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[6px] border border-line px-3.5 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          Keep the current value
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-2 rounded-token border border-dashed border-line-strong p-4">
      <p className="text-[13px] font-medium text-ink">Ask the copilot</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        Reads run on their own. A single-product change runs and can be undone.
        “Discontinue the hidden products” stops at the gate — approve all, a
        subset, or reject.
      </p>
    </div>
  );
}
