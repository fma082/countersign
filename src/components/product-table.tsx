import { Ban, TrendingDown } from "lucide-react";
import type { PublicProduct } from "@/lib/scenario/catalog";
import { cn } from "@/lib/cn";

export interface TableView {
  /** null → show all rows. */
  filterSkus: string[] | null;
  revealMargin: boolean;
  margins: Record<string, number>;
  /** Gate targets — "could pass". Side bar + subtle fill. */
  targetIds: string[];
  /** SKUs that just changed (or were reverted) — "passed". Full fill, transient. */
  changedIds: string[];
  /** Prior displayed price per SKU, for a strikethrough on changed rows. */
  priceWas: Record<string, number>;
}

const effective = (p: PublicProduct): number => p.salePrice ?? p.price;

const COLS = ["SKU", "Name", "Category", "Price", "Stock", "Status"] as const;

export function ProductTable({
  rows,
  view,
}: {
  rows: PublicProduct[];
  view: TableView;
}) {
  const filter = view.filterSkus ? new Set(view.filterSkus) : null;
  const targets = new Set(view.targetIds);
  const changed = new Set(view.changedIds);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c}
                className={cn(
                  "sticky top-0 z-10 border-b border-line bg-panel px-2 pb-2 pt-3 text-left text-[10px] font-normal uppercase tracking-[0.09em] text-ink-3",
                  (c === "Price" || c === "Stock") && "text-right",
                )}
              >
                {c}
              </th>
            ))}
            {view.revealMargin && (
              <th className="sticky top-0 z-10 border-b border-line bg-panel px-2 pb-2 pt-3 text-right text-[10px] font-normal uppercase tracking-[0.09em] text-ink-3">
                Margin
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const hidden = filter ? !filter.has(p.sku) : false;
            if (hidden) return null;

            const isTarget = targets.has(p.sku);
            const isChanged = changed.has(p.sku);
            const wasPrice = view.priceWas[p.sku];
            const onSale = p.salePrice !== null;
            const margin = view.margins[p.sku];

            return (
              <tr
                key={p.sku}
                className={cn(
                  "transition-colors duration-300",
                  isChanged && "bg-sub",
                  isTarget && !isChanged && "bg-sub/60",
                )}
              >
                <td
                  className="whitespace-nowrap border-b border-line px-2 py-2 font-mono text-[12px] text-ink-2"
                  style={
                    isTarget && !isChanged
                      ? { boxShadow: "inset 2px 0 0 var(--interactive-primary)" }
                      : undefined
                  }
                >
                  {p.sku}
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-2 text-ink">
                  {p.name}
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-2 text-ink-2">
                  {p.category}
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right tabular-nums text-ink-2">
                  {wasPrice !== undefined ? (
                    <span className="mr-1.5 text-ink-3 line-through">${wasPrice.toFixed(2)}</span>
                  ) : (
                    onSale && (
                      <span className="mr-1.5 text-ink-3 line-through">${p.price.toFixed(2)}</span>
                    )
                  )}
                  <span className={cn(onSale && wasPrice === undefined && "text-ink")}>
                    ${effective(p).toFixed(2)}
                  </span>
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right tabular-nums text-ink-2">
                  {p.stock}
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-2">
                  <StatusPill status={p.status} />
                </td>
                {view.revealMargin && (
                  <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right tabular-nums">
                    {margin === undefined ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center justify-end gap-1",
                          margin < 0 ? "text-error" : "text-ink-2",
                        )}
                      >
                        {margin < 0 && <TrendingDown size={12} aria-hidden />}
                        {margin.toFixed(1)}%
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: PublicProduct["status"] }) {
  const off = status === "discontinued";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] capitalize",
        // Warning state — amber, never color alone: paired with the Ban icon.
        off ? "border-warning text-warning" : "border-line text-ink-2",
      )}
    >
      {off && <Ban size={11} aria-hidden />}
      {status}
    </span>
  );
}
