"use client";

import type { Measured, RenderPayload, RowMeasure } from "@/lib/engine/types";
import type { PublicProduct } from "@/lib/scenario/catalog";

/**
 * `product_list` — the first generative-UI component: the render half of
 * `query_products`, the rows the model was deliberately never given.
 *
 * Monochrome, like the rest of the system. Being below a reorder point is a
 * condition of the DATA, not a fault of the system, so it gets no red — red and
 * green belong to error and success and nothing else. Severity is carried by
 * ORDER (worst first) and by a neutral bar. The only strong treatments in the
 * list are "out of stock", because that one is binary and admits no degrees,
 * and a negative margin, because money lost per sale is a real business state
 * rather than a neutral condition of the data.
 *
 * The header states the criterion the SERVER executed, never the user's
 * phrasing. `userIntent` appears under it as an attribution when it is present,
 * and its absence degrades nothing — it selects no rows and computes no number.
 *
 * The row is TWO lines by design. This component lives inside the copilot
 * panel, so ~380px is the primary width, not the degraded one; on one line the
 * name was squeezed to nothing by the badges and rendered without even an
 * ellipsis — a row taking up space to promise a datum it never delivered.
 *
 * WHAT LINE 2 SHOWS IS NOT THIS COMPONENT'S DECISION. It renders `measure`,
 * which the server resolved from the criterion it ran. Every row of a render
 * carries the same kind, so line 2 is one column and not a per-row guess. The
 * component reads no `stock` and no `reorderPoint`: it could only compare them
 * under a criterion that never asked the question.
 */

export function ProductList({ payload }: { payload: RenderPayload }) {
  const rows = Array.isArray(payload.data) ? (payload.data as Measured<PublicProduct>[]) : [];

  return (
    // `shrink-0` is load-bearing, not tidying. The copilot log is a flex column
    // (`flex flex-col overflow-y-auto`), and a flex item's automatic minimum
    // size — the thing that stops content being squashed — applies only while
    // its own `overflow` is `visible`. This card sets `overflow-hidden` to clip
    // the row borders under the rounded corners, which forfeits that protection
    // and made it the ONE log item flex-shrink could crush: in the live panel it
    // rendered 2px tall (both borders, no content) against a natural 859px,
    // present in the DOM and invisible on screen. Every sibling survives only
    // because it never sets `overflow`.
    <div className="shrink-0 overflow-hidden rounded-token border border-line bg-panel">
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

      {rows.length === 0 ? (
        // Zero results is a valid answer, not a failure. No error token, no icon.
        <p className="px-3.5 py-4 text-[12.5px] text-ink-2">No products match this criterion.</p>
      ) : (
        <ul>
          {/* Rendered in the order the server ranked them. Worst first means
              something different under each measure, and the criterion is what
              knows which — so the ordering ships with the rows. */}
          {rows.map((p) => (
            <ProductRow key={p.sku} product={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductRow({ product: p }: { product: Measured<PublicProduct> }) {
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

      {/* Line 2 — the measure, and it is a fixed structure. The SKU absorbs the
          slack on the left so whatever the measure renders stays in a hard
          column that aligns across every row: the whole point of the list is
          comparing those values down the page, and a column that shifts per row
          cannot be compared. */}
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">
          {p.sku}
          {p.measure.kind === "none" && (
            // With no measure the row collapses to identity, and the space the
            // column would have held goes to the one other fact worth having.
            <span className="text-ink-3"> · {p.category}</span>
          )}
        </span>
        <Measure measure={p.measure} />
      </div>
    </li>
  );
}

/**
 * One switch, four branches, and no fallthrough: a kind the server can send is
 * a kind that has a rendering. The bar exists in exactly one of them.
 */
function Measure({ measure }: { measure: RowMeasure }) {
  switch (measure.kind) {
    case "ratio": {
      // Clamped for the FILL only — a stock above its reference is a full bar,
      // not an overflowing one. The number beside it stays unclamped and true.
      const fill = Math.min(Math.max(measure.value / (measure.reference || 1), 0), 1);
      return (
        <>
          <span
            className="h-1 w-14 flex-none overflow-hidden rounded-full bg-sub"
            role="img"
            aria-label={`${measure.value} of ${measure.reference}`}
          >
            <span className="block h-full rounded-full bg-ink-3" style={{ width: `${fill * 100}%` }} />
          </span>
          <span className="w-[56px] flex-none text-right font-mono text-[11.5px] text-ink-2">
            <span className="text-ink">{measure.value}</span> / {measure.reference}
          </span>
        </>
      );
    }

    case "magnitude":
      // No bar: there is no reference to fill against. The threshold that
      // defines the group is stated once, in the header, so the row carries the
      // value alone instead of repeating "below 0" thirteen times.
      return (
        <span
          className={`flex-none text-right font-mono text-[11.5px] ${
            measure.sign === "negative" ? "text-error" : "text-ink"
          }`}
        >
          {measure.value > 0 ? "+" : ""}
          {measure.value.toFixed(1)}
          {measure.unit}
        </span>
      );

    case "recency":
      // The distance is the measure; the date is the evidence for it, kept
      // quiet so the column reads as one number down the page.
      return (
        <span className="flex-none whitespace-nowrap text-right text-[11.5px] text-ink-2">
          ended {measure.endedDaysAgo}d ago{" "}
          <span className="font-mono text-[10.5px] text-ink-3">{measure.date}</span>
        </span>
      );

    case "none":
      // Nothing measured, so nothing rendered and no reserved gap. A blank
      // column would still be a promise of a number that is not coming.
      return null;
  }
}
