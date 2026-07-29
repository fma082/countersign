"use client";

import { Package } from "lucide-react";
import {
  PRODUCTS,
  effectivePrice,
  marginPct,
  saleExpired,
  type Product,
} from "@/lib/scenario/seed-products";
import type { PublicProduct } from "@/lib/scenario/catalog";
import type { GatePreview, ToolEvent } from "@/lib/engine/types";
import { ProductTable, type TableView } from "@/components/product-table";
import { StatusBadge } from "@/components/copilot/status-badge";
import { ToolCard } from "@/components/copilot/tool-card";
import { GateCard } from "@/components/copilot/gate-card";

/**
 * A STATIC app-shot of the split view, frozen at the gate moment. It reuses the
 * real table, tool card, and gate card — but mounts no engine, calls no model,
 * and is inert (pointer-events off). The live demo lives at /scenario; the home
 * must not spin up the engine or spend quota.
 */
const money = (n: number) => `$${n.toFixed(2)}`;

const rows: PublicProduct[] = PRODUCTS.map(({ cost: _c, ...p }) => {
  void _c;
  return p;
});

const expired: Product[] = PRODUCTS.filter((p) => saleExpired(p));
const targetIds = expired.map((p) => p.sku);

const gate: GatePreview = {
  id: "shot",
  tool: "clear_expired_sales",
  title: `Clear ${expired.length} expired sale prices`,
  description:
    "Removes the sale price from products whose sale has ended, reverting each to its regular price. Sales that have not ended are left untouched — including one with no end date on record, which this sweep cannot evaluate at all.",
  targetIds,
  items: expired.map((p) => ({
    sku: p.sku,
    name: p.name,
    detail: `${money(p.salePrice as number)} → ${money(p.price)}`,
    warn: marginPct(p) < 0,
  })),
  effect: { filter: { skus: null } },
};

const toolEvent: ToolEvent = {
  id: "shot-tool",
  name: "clear_expired_sales",
  decision: "gate",
  badge: "pending",
  summary: `${expired.length} products would revert to their regular price.`,
  args: {},
  targetIds,
};

const view: TableView = {
  filterSkus: null,
  revealMargin: false,
  margins: {},
  targetIds,
  changedIds: [],
  priceWas: {},
};

function WindowChrome() {
  return (
    <div className="flex items-center gap-2 border-b border-line bg-page px-3.5 py-2.5">
      <span className="flex gap-1.5">
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
      </span>
      <span className="ml-1 font-mono text-[10px] text-ink-3">northbase — products</span>
    </div>
  );
}

function ShotCopilot() {
  return (
    <>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[13px] font-medium text-ink">Copilot</span>
        <StatusBadge status="awaitingApproval" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3.5">
        <p className="max-w-[85%] self-end rounded-token bg-sub px-3 py-2 text-[12px] text-ink">
          Clean up the expired sale prices.
        </p>
        <ToolCard event={toolEvent} />
        <GateCard gate={gate} resolved="pending" onApprove={() => {}} onReject={() => {}} />
      </div>
    </>
  );
}

const FRAME =
  "pointer-events-none select-none overflow-hidden rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.18)]";

/** Full split view — the hero shot on wider screens. */
export function AppShot() {
  return (
    <div aria-hidden className={FRAME}>
      <WindowChrome />
      <div className="grid h-[440px] grid-cols-[44px_minmax(0,1fr)_320px]">
        <div className="flex flex-col items-center gap-1 border-r border-line bg-page py-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-action text-on-action">
            <Package size={15} />
          </span>
          <span className="size-8 rounded-lg" />
          <span className="size-8 rounded-lg" />
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="border-b border-line px-5 pb-3 pt-3.5">
            <p className="text-[11px] text-ink-3">
              Northbase <span className="text-ink-3">/</span>{" "}
              <span className="font-medium text-ink">Products</span>
            </p>
            <h2 className="mt-0.5 text-[16px] font-medium tracking-[-0.015em] text-ink">Products</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ProductTable rows={rows} view={view} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col border-l border-line">
          <ShotCopilot />
        </div>
      </div>
    </div>
  );
}

/** Copilot-only shot — the gate is the wedge, so it's what mobile leads with. */
export function AppShotMobile() {
  return (
    <div aria-hidden className={FRAME}>
      <WindowChrome />
      <div className="flex h-[440px] flex-col">
        <ShotCopilot />
      </div>
    </div>
  );
}
