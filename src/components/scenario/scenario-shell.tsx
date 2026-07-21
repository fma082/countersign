"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import type { PublicProduct } from "@/lib/scenario/catalog";
import type { ColumnKey, ViewEffect } from "@/lib/engine/types";
import { NavRail } from "@/components/nav-rail";
import { ProductTable, type TableView } from "@/components/product-table";
import { ThemeToggle } from "@/components/theme-toggle";
import { CopilotPanel } from "@/components/copilot/panel";
import { useCopilot, type CopilotCallbacks } from "@/components/copilot/use-copilot";
import { cn } from "@/lib/cn";

const effective = (p: PublicProduct): number => p.salePrice ?? p.price;
const CHANGED_MS = 6000;

export function ScenarioShell({ initialRows }: { initialRows: PublicProduct[] }) {
  const [rows, setRows] = useState<PublicProduct[]>(initialRows);
  const [filterSkus, setFilterSkus] = useState<string[] | null>(null);
  const [reveal, setReveal] = useState<Set<ColumnKey>>(new Set());
  const [margins, setMargins] = useState<Record<string, number>>({});
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [changed, setChanged] = useState<Record<string, number>>({});
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
      // A destructive op just ran. Record each row's prior effective price so
      // the table can strike it through, then apply the mutation.
      setRows((prev) => {
        const byId = new Map(prev.map((p) => [p.sku, p]));
        const fresh: Record<string, number> = {};
        for (const m of effect.mutations!) {
          const row = byId.get(m.sku);
          if (row) fresh[m.sku] = effective(row);
        }
        setChanged((c) => ({ ...c, ...fresh }));
        return prev.map((p) => {
          const m = effect.mutations!.find((x) => x.sku === p.sku);
          return m
            ? { ...p, price: m.price, salePrice: m.salePrice, saleEnds: m.saleEnds, lastUpdated: m.lastUpdated }
            : p;
        });
      });
      // "Recently changed" is transient — distinct from the gate's "could pass".
      if (changedTimer.current) clearTimeout(changedTimer.current);
      changedTimer.current = setTimeout(() => setChanged({}), CHANGED_MS);
    }
  }, []);

  const callbacks = useMemo<CopilotCallbacks>(
    () => ({
      onEffect: applyEffect,
      onGateOpen: (ids) => setTargetIds(ids),
      onGateClose: () => setTargetIds([]),
    }),
    [applyEffect],
  );

  const copilot = useCopilot(callbacks);

  const view: TableView = {
    filterSkus,
    revealMargin: reveal.has("margin"),
    margins,
    targetIds,
    changed,
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
        <CopilotPanel copilot={copilot} />
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
            <CopilotPanel copilot={copilot} />
          </div>
        </div>
      )}
    </div>
  );
}
