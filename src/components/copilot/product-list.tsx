"use client";

import type { RenderPayload } from "@/lib/engine/types";
import type { PublicProduct } from "@/lib/scenario/catalog";

/**
 * `product_list` — the first generative-UI component: the render half of
 * `query_products`, the rows the model was deliberately never given.
 *
 * Monochrome, like the rest of the system. Being below a reorder point is a
 * condition of the DATA, not a fault of the system, so it gets no red — red and
 * green belong to error and success and nothing else. Severity is carried by
 * ORDER (worst deficit first) and by a neutral ratio bar. The only strong
 * treatment in the list is "out of stock", because that one is binary and
 * admits no degrees; a deficit does.
 *
 * The header states the criterion the SERVER executed, never the user's
 * phrasing. `userIntent` appears under it as an attribution when it is present,
 * and its absence degrades nothing — it selects no rows and computes no number.
 *
 * The row is TWO lines by design. This component lives inside the copilot
 * panel, so ~380px is the primary width, not the degraded one; on one line the
 * name was squeezed to nothing by the badges and rendered without even an
 * ellipsis — a row taking up space to promise a datum it never delivered.
 */

/** How much of the reorder point is still on the shelf. */
function ratios(p: PublicProduct): { sort: number; bar: number } {
  // A reorder point of 0 makes the deficit uncomputable, not infinite. The bar
  // reads full (nothing is missing against no target) and the row sinks to the
  // bottom of its group rather than dividing by zero.
  if (p.reorderPoint <= 0) return { sort: Number.POSITIVE_INFINITY, bar: 1 };
  const r = p.stock / p.reorderPoint;
  return { sort: r, bar: Math.min(Math.max(r, 0), 1) };
}

/**
 * Worst deficit first, discontinued last. Discontinued rows are not restocked,
 * so putting them at the top would point the eye at the one thing not to act
 * on. Ties break on SKU so the order is stable between renders.
 */
export function sortProductRows(rows: readonly PublicProduct[]): PublicProduct[] {
  return [...rows].sort((a, b) => {
    const aOut = a.status === "discontinued";
    const bOut = b.status === "discontinued";
    if (aOut !== bOut) return aOut ? 1 : -1;
    const d = ratios(a).sort - ratios(b).sort;
    if (d !== 0) return d;
    return a.sku.localeCompare(b.sku);
  });
}

export function ProductList({ payload }: { payload: RenderPayload }) {
  const rows = Array.isArray(payload.data) ? (payload.data as PublicProduct[]) : [];
  const sorted = sortProductRows(rows);

  return (
    <div className="overflow-hidden rounded-token border border-line bg-panel">
      <header className="border-b border-line px-3.5 py-3">
        <h3 className="text-[14px] font-medium text-ink">
          {payload.count} {payload.criterionLabel}
        </h3>
        {payload.userIntent && (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
            interpreted from: “{payload.userIntent}”
          </p>
        )}
      </header>

      {sorted.length === 0 ? (
        // Zero results is a valid answer, not a failure. No error token, no icon.
        <p className="px-3.5 py-4 text-[12.5px] text-ink-2">No products match this criterion.</p>
      ) : (
        <ul>
          {sorted.map((p) => (
            <ProductRow key={p.sku} product={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductRow({ product: p }: { product: PublicProduct }) {
  const { bar } = ratios(p);
  const outOfStock = p.stock <= 0;
  const discontinued = p.status === "discontinued";

  return (
    <li className="border-t border-line px-3.5 py-2.5 transition-colors first:border-t-0 hover:bg-sub">
      {/* Line 1 — identity. Name + badges share this line because the badges
          qualify the PRODUCT, not the number. The name is the only thing that
          gives way, and it gives way to an ellipsis, never to zero. */}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{p.name}</span>
        {outOfStock && (
          <span className="flex-none whitespace-nowrap rounded-full bg-action px-1.5 py-0.5 text-[10px] leading-tight text-on-action">
            out of stock
          </span>
        )}
        {discontinued && (
          <span className="flex-none whitespace-nowrap rounded-full border border-line px-1.5 py-0.5 text-[10px] leading-tight text-ink-2">
            discontinued
          </span>
        )}
      </div>

      {/* Line 2 — the measurement, and it is a fixed structure. The SKU absorbs
          the slack on the left so the bar and the numbers stay in a hard column
          that aligns across every row: the whole point of the list is comparing
          those thirteen deficits down the page, and a column that shifts per
          row cannot be compared. */}
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">{p.sku}</span>

        {/* The relative deficit, made visual. Neutral on purpose. */}
        <span
          className="h-1 w-14 flex-none overflow-hidden rounded-full bg-sub"
          role="img"
          aria-label={`${p.stock} of ${p.reorderPoint} reorder point`}
        >
          <span className="block h-full rounded-full bg-ink-3" style={{ width: `${bar * 100}%` }} />
        </span>
        <span className="w-[56px] flex-none text-right font-mono text-[11.5px] text-ink-2">
          <span className="text-ink">{p.stock}</span> / {p.reorderPoint}
        </span>
      </div>
    </li>
  );
}
