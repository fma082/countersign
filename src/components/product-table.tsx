import { Ban, TrendingDown } from "lucide-react";
import type { PublicProduct } from "@/lib/scenario/catalog";
import type { ColumnKey } from "@/lib/engine/types";
import { cn } from "@/lib/cn";

export interface TableView {
  /** null → show all rows. */
  filterSkus: string[] | null;
  /**
   * Columns beyond the base set, for the criterion currently applied. The whole
   * set, resolved server-side — this component never adds to it, so a column
   * cannot outlive the criterion that put it there.
   */
  reveal: ColumnKey[];
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

/**
 * The revealable columns, in the order they append to the base set.
 *
 * Each exists because some criterion selects rows on a dimension the base
 * columns do not show. `expired_sale` picks six products whose only shared
 * property is a date the table never displayed — without the column the human
 * sees six ordinary rows and has to take the filter label's word for it.
 *
 * Which of these appear is not this component's decision, and not a preference
 * the human sets. It arrives in `view.reveal`, derived server-side from the
 * active criterion, whole, every time. That is what keeps Margin from being
 * reachable by any route other than a margin question.
 */
const REVEALABLE: Record<ColumnKey, { label: string }> = {
  saleEnds: { label: "Sale ends" },
  margin: { label: "Margin" },
};
const REVEAL_ORDER: ColumnKey[] = ["saleEnds", "margin"];

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
  const shown = new Set(view.reveal);
  const extra = REVEAL_ORDER.filter((c) => shown.has(c));

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
            {extra.map((c) => (
              <th
                key={c}
                className="sticky top-0 z-10 border-b border-line bg-panel px-2 pb-2 pt-3 text-right text-[10px] font-normal uppercase tracking-[0.09em] text-ink-3"
              >
                {REVEALABLE[c].label}
              </th>
            ))}
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
                {extra.map((c) => (
                  <td
                    key={c}
                    className="whitespace-nowrap border-b border-line px-2 py-2 text-right tabular-nums"
                  >
                    {c === "margin" ? <Margin value={margin} /> : <SaleEnds date={p.saleEnds} />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A margin, or nothing. The column only appears under a criterion that shipped
 * margins for the rows it selected, so `undefined` should not occur — it is
 * still rendered as an explicit gap rather than a blank cell, because a silent
 * blank in a money column reads as zero.
 */
function Margin({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-ink-3">not available</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-end gap-1",
        value < 0 ? "text-error" : "text-ink-2",
      )}
    >
      {value < 0 && <TrendingDown size={12} aria-hidden />}
      {value.toFixed(1)}%
    </span>
  );
}

/**
 * A sale's end date — and the absence of one, which is a different fact.
 *
 * This column is only up under a sale criterion, so every row here HAS a sale;
 * a null date therefore means the date is missing, not that the field does not
 * apply. That is the one row this catalog cannot reason about: a promo running
 * with nothing recording when it should stop, which no sweep of expired sales
 * will ever surface. Printing a dash would file it under the same "no value" as
 * everything else. It says so instead.
 */
function SaleEnds({ date }: { date: string | null }) {
  return date ? (
    <span className="font-mono text-[11.5px] text-ink-2">{date}</span>
  ) : (
    <span className="text-ink-3">no end date</span>
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
