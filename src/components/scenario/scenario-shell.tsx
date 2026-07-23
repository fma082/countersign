"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import type { PublicProduct } from "@/lib/scenario/catalog";
import type { ColumnKey, ViewEffect } from "@/lib/engine/types";
import { NavRail } from "@/components/nav-rail";
import { ProductTable, type TableView } from "@/components/product-table";
import { ThemeToggle } from "@/components/theme-toggle";
import { CopilotPanel } from "@/components/copilot/panel";
import { GuidedSteps } from "@/components/copilot/guided";
import { useCopilot, type CopilotCallbacks } from "@/components/copilot/use-copilot";
import { GUIDED_CLOSING, GUIDED_STEPS } from "@/lib/scenario/guided-steps";
import { cn } from "@/lib/cn";

const LOCKED_PLACEHOLDER = "Complete the steps above to unlock free input.";

const effective = (p: PublicProduct): number => p.salePrice ?? p.price;
const CHANGED_MS = 6000;

export function ScenarioShell({ initialRows }: { initialRows: PublicProduct[] }) {
  const [rows, setRows] = useState<PublicProduct[]>(initialRows);
  const [filterSkus, setFilterSkus] = useState<string[] | null>(null);
  const [reveal, setReveal] = useState<Set<ColumnKey>>(new Set());
  const [margins, setMargins] = useState<Record<string, number>>({});
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [changedIds, setChangedIds] = useState<string[]>([]);
  const [priceWas, setPriceWas] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const changedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyEffect = useCallback((effect: ViewEffect) => {
    if (effect.filter !== undefined) setFilterSkus(effect.filter.skus);
    if (effect.reveal?.length) {
      setReveal((prev) => {
        const next = new Set(prev);
        for (const c of effect.reveal!) next.add(c);
        return next;
      });
    }
    if (effect.margins) setMargins((prev) => ({ ...prev, ...effect.margins }));

    if (effect.mutations?.length) {
      // A write (reversible, approved, or undone) just landed. Apply each row
      // patch; where it changes the displayed price, remember the prior value so
      // the table can strike it through. Every touched row gets the transient
      // mark — a reverted row is marked the same way a changed one is.
      const muts = effect.mutations;
      setRows((prev) => {
        const byId = new Map(prev.map((p) => [p.sku, p]));
        const wasFresh: Record<string, number> = {};
        for (const m of muts) {
          const row = byId.get(m.sku);
          if (!row) continue;
          const before = effective(row);
          if (effective({ ...row, ...m }) !== before) wasFresh[m.sku] = before;
        }
        setPriceWas((c) => ({ ...c, ...wasFresh }));
        return prev.map((p) => {
          const m = muts.find((x) => x.sku === p.sku);
          return m ? { ...p, ...m } : p;
        });
      });
      setChangedIds(muts.map((m) => m.sku));
      if (changedTimer.current) clearTimeout(changedTimer.current);
      changedTimer.current = setTimeout(() => {
        setChangedIds([]);
        setPriceWas({});
      }, CHANGED_MS);
    }
  }, []);

  const callbacks = useMemo<CopilotCallbacks>(
    () => ({
      onEffect: applyEffect,
      onGateOpen: (ids) => {
        // Reveal every targeted row while the human decides — clear any filter a
        // prior read left on, so all "could pass" rows are visible at once.
        setFilterSkus(null);
        setTargetIds(ids);
      },
      onGateClose: () => setTargetIds([]),
    }),
    [applyEffect],
  );

  const copilot = useCopilot(callbacks);
  const copilotRef = useRef(copilot);
  copilotRef.current = copilot;

  // ── Guided flow ───────────────────────────────────────────────────────────
  // The order and the prompts are guided; the streaming and tool calls are the
  // real engine. `guidedStep` is the active step (4 = done, free input unlocked);
  // `runningStep` is the step currently executing (its block hides while it runs).
  const [guidedStep, setGuidedStep] = useState(0);
  const [runningStep, setRunningStep] = useState<number | null>(null);
  const note3Shown = useRef(false);
  const prevStatus = useRef(copilot.status);
  const status = copilot.status;

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (runningStep === null) return;

    // Act on the EDGE into a terminal state, not the standing value — otherwise a
    // step would "complete" the instant it starts (status is still complete).
    const enteredComplete = prev !== "complete" && status === "complete";
    const enteredGate = prev !== "awaitingApproval" && status === "awaitingApproval";
    const cp = copilotRef.current;

    if (runningStep < 3) {
      if (enteredComplete) {
        cp.pushNote(GUIDED_STEPS[runningStep].note);
        setGuidedStep(runningStep + 1);
        setRunningStep(null);
      }
      return;
    }

    // Step 04 — the gate. Its note lands when the engine halts (gate opens); the
    // closing lands once the human has decided (any of the three exits).
    if (enteredGate && !note3Shown.current) {
      note3Shown.current = true;
      cp.pushNote(GUIDED_STEPS[3].note);
    }
    if (enteredComplete) {
      cp.pushClosing(GUIDED_CLOSING);
      setGuidedStep(4);
      setRunningStep(null);
    }
  }, [status, runningStep]);

  const onRunStep = useCallback((i: number) => {
    setRunningStep(i);
    // Pass the step's known tool as a fallback: if the model is paused, the
    // server runs it directly so the guided flow always reaches the gate.
    copilotRef.current.submitPrompt(GUIDED_STEPS[i].prompt, GUIDED_STEPS[i].fallback);
  }, []);

  const resetScenario = useCallback(() => {
    copilotRef.current.reset();
    setRows(initialRows);
    setFilterSkus(null);
    setReveal(new Set());
    setMargins({});
    setTargetIds([]);
    setChangedIds([]);
    setPriceWas({});
    if (changedTimer.current) clearTimeout(changedTimer.current);
    setGuidedStep(0);
    setRunningStep(null);
    note3Shown.current = false;
    prevStatus.current = "empty";
  }, [initialRows]);

  const guidedActive = guidedStep < 4;
  const guidedSlot =
    guidedActive && runningStep === null ? (
      <GuidedSteps step={guidedStep} onRun={onRunStep} />
    ) : null;

  const view: TableView = {
    filterSkus,
    revealMargin: reveal.has("margin"),
    margins,
    targetIds,
    changedIds,
    priceWas,
  };

  const shownCount = filterSkus ? filterSkus.length : rows.length;

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden lg:grid-cols-[56px_minmax(0,1fr)_380px]">
      <NavRail />

      {/* Workspace */}
      <main className="flex min-h-0 flex-col bg-panel">
        <header className="border-b border-line px-6 pb-3.5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[12px] text-ink-3">
                Northbase <span className="text-ink-3">/</span>{" "}
                <span className="font-medium text-ink">Products</span>
              </p>
              <h1 className="mt-1 text-[18px] font-medium tracking-[-0.015em] text-ink">
                Products
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {view.revealMargin && (
                <span className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-2">
                  Margin
                </span>
              )}
              <span className="hidden text-[11px] text-ink-3 sm:inline">
                {shownCount} of {rows.length}
              </span>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <ProductTable rows={rows} view={view} />
      </main>

      {/* Copilot — fixed column on desktop */}
      <aside className="hidden min-h-0 border-l border-line lg:flex lg:flex-col">
        <CopilotPanel
          copilot={copilot}
          guidedSlot={guidedSlot}
          locked={guidedActive}
          lockedPlaceholder={LOCKED_PLACEHOLDER}
          onReset={resetScenario}
        />
      </aside>

      {/* Copilot — drawer below lg */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open copilot"
        className="fixed bottom-5 right-5 z-30 flex size-12 items-center justify-center rounded-full bg-action text-on-action shadow-lg lg:hidden"
      >
        <MessageSquare size={18} />
      </button>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close copilot"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <div className="absolute inset-x-0 bottom-0 flex h-[72dvh] flex-col overflow-hidden rounded-t-2xl border-t border-line bg-panel">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close copilot"
              className={cn(
                "absolute right-3 top-3 z-10 flex size-7 items-center justify-center rounded-full text-ink-3",
                "hover:text-ink",
              )}
            >
              <X size={16} />
            </button>
            <CopilotPanel
              copilot={copilot}
              guidedSlot={guidedSlot}
              locked={guidedActive}
              lockedPlaceholder={LOCKED_PLACEHOLDER}
              onReset={resetScenario}
            />
          </div>
        </div>
      )}
    </div>
  );
}
