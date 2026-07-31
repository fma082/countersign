/**
 * The filter resolver — the ONE place a filter predicate is evaluated.
 *
 * Its counterpart, `filter-spec.ts`, is the one place a criterion is described.
 * Descriptions are pure and client-safe; predicates read the catalog and stay
 * here, on the server, next to `cost`.
 *
 * Everything that changes the table's visible set goes through `resolveFilter`:
 * the human clicking a chip, the model calling `filter_view`, the model calling
 * `filter_compare`, a gate clearing the view, and a mutation re-resolving it
 * afterwards. Five callers, one evaluation. That is what makes the human's
 * filter and the agent's filter the same object rather than two channels that
 * happen to agree — and it is why the agent has no way to put the table into a
 * state the human cannot see named in the bar and cannot clear with one click.
 */

import {
  activeProducts,
  activeSales,
  allProducts,
  belowReorderProducts,
  discontinuedProducts,
  expiredSales,
  hiddenActiveProducts,
  negativeMargin,
  toPublic,
  type PublicProduct,
} from "@/lib/scenario/catalog";
import { REFERENCE_DATE, effectivePrice, marginPct, type Product } from "@/lib/scenario/seed-products";
import { PRESET_SPEC, describeFilter, filterMeasure, filterReveal } from "./filter-spec";
import type {
  CompareField,
  CompareOp,
  FilterPreset,
  FilterState,
  Measured,
  MeasureKind,
  ResolvedFilter,
  RowMeasure,
  ViewEffect,
} from "./types";

// ── Predicates ─────────────────────────────────────────────────────────────
/**
 * Keyed by the same union as `PRESET_SPEC`, so a preset that gains a
 * description without gaining a predicate does not compile. The two tables are
 * the two halves of one definition, kept apart only because one of them may
 * reach the browser.
 */
const PRESET_ROWS: Record<FilterPreset, () => Product[]> = {
  below_reorder: belowReorderProducts,
  negative_margin: negativeMargin,
  expired_sale: () => expiredSales(),
  on_sale: () => activeSales(),
  hidden: hiddenActiveProducts,
  active: activeProducts,
  discontinued: discontinuedProducts,
};

const FIELD_READ: Record<CompareField, (p: Product) => number> = {
  stock: (p) => p.stock,
  effective_price: effectivePrice,
};

const OP_TEST: Record<CompareOp, (a: number, b: number) => boolean> = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  eq: (a, b) => a === b,
};

/** The rows a criterion selects. THE only filter predicate evaluation there is. */
export function filterProducts(state: FilterState): Product[] {
  switch (state.kind) {
    case "none":
      return allProducts();
    case "preset":
      return PRESET_ROWS[state.preset]();
    case "compare": {
      const read = FIELD_READ[state.field];
      const test = OP_TEST[state.op];
      return allProducts().filter((p) => test(read(p), state.value));
    }
  }
}

/**
 * A criterion, run. Re-runs the predicate every time it is called — which is
 * the whole reason the state is a criterion: after a write lands, resolving the
 * SAME state yields the NEW rows, so a filtered view cannot go on displaying a
 * membership the catalog no longer agrees with.
 *
 * `skus` ships in the criterion's OWN order, not the catalog's. A table filtered
 * by a criterion is sorted by that criterion — the oldest expired sale at the
 * top, the deepest stock deficit at the top — for the same reason the rendered
 * list is: the order is part of what the criterion says, and re-deriving it in
 * the browser would be the client ranking rows the server selected. Catalog
 * order is what an UNFILTERED table shows, and `null` still means exactly that.
 */
export function resolveFilter(state: FilterState): ResolvedFilter {
  const c = filterCriterion(state);
  return {
    state,
    // `null` only for the empty criterion. Every other criterion ships its
    // rows, including the empty result — "0 products match" is an answer, and
    // `null` would silently redraw all 30 in its place.
    skus: state.kind === "none" ? null : orderedSkus(c),
    label: c.label,
    count: c.rows.length,
    // Whole set, recomputed here. Nothing downstream merges this with a
    // previous one — that merge is what let a column outlive its criterion.
    reveal: filterReveal(state),
  };
}

/**
 * The criterion's rows in the criterion's order, as SKUs — the table's row
 * order, decided by the same `sortByMeasure` that orders a rendered list.
 *
 * It ranks a projection rather than the products themselves: only `sku` and
 * `status` are needed to order, and building the ranking out of whole `Product`s
 * would put `cost` inside a value on its way to a client payload. Nothing here
 * spreads a product.
 */
const orderedSkus = (c: Criterion): string[] =>
  sortByMeasure(
    c.rows.map((p) => ({ sku: p.sku, status: p.status, measure: measureOf(c, p) })),
  ).map((r) => r.sku);

// ── What a filter does to the view ─────────────────────────────────────────
const marginsFor = (rows: Product[]): Record<string, number> =>
  Object.fromEntries(rows.map((p) => [p.sku, Math.round(marginPct(p) * 10) / 10]));

export { marginsFor };

/**
 * The complete effect of putting the table into a filter state. Both the human
 * clicking a chip and the model calling a filter tool land here, so they cannot
 * produce different views from the same criterion.
 *
 * The margin column comes with the `negative_margin` criterion and is not an
 * argument. It used to be `reveal_margin: boolean` on `filter_view`, which let
 * the model reveal margin alongside a filter that had nothing to do with
 * margin — margin exposure decided by a model's spare boolean rather than by
 * the question being asked. Now the criterion that is ABOUT margin reveals it,
 * everything else does not, and there is no argument to get wrong.
 */
export function filterEffect(state: FilterState): ViewEffect {
  const filter = resolveFilter(state);
  return {
    filter,
    // Margin VALUES ride along only when the criterion revealed the margin
    // COLUMN — the two are decided by the same fact, so there is no state in
    // which the column is up and the numbers behind it are missing (the case
    // that used to print a dash), and none in which margins are broadcast for
    // a criterion that never asked about margin.
    ...(filter.reveal.includes("margin")
      ? { margins: marginsFor(filterProducts(state)) }
      : {}),
  };
}

// ── The measure: resolved from the criterion, never inferred from the data ──
/**
 * A criterion together with what its rows measure.
 *
 * The union is load-bearing: a `ratio` measure cannot be assembled without
 * saying what the value is and what it was compared against, so there is no way
 * to ship a bar with nothing behind it. `below_reorder` compares stock to the
 * product's own reorder point; `stock lt 50` compares it to the human's number;
 * `negative_margin` has no reference at all and gets no bar.
 */
export type Criterion = { rows: Product[]; label: string } & (
  | { measure: "ratio"; value: (p: Product) => number; reference: (p: Product) => number }
  | { measure: "magnitude" | "recency" | "none" }
);

/** Assemble the criterion a `FilterState` names, rows and measure together. */
export function filterCriterion(state: FilterState): Criterion {
  const rows = filterProducts(state);
  const label = describeFilter(state);
  const measure = filterMeasure(state);

  if (measure !== "ratio") return { rows, label, measure };

  // The two ratio criteria differ only in what they compared against, and each
  // knows its own reference: the product's reorder point, or the constant the
  // human typed.
  const reference: (p: Product) => number =
    state.kind === "compare" ? () => state.value : (p) => p.reorderPoint;
  return { rows, label, measure, value: (p) => p.stock, reference };
}

/** One row's measure, from the criterion — never from the shape of the data. */
export function measureOf(c: Criterion, p: Product): RowMeasure {
  switch (c.measure) {
    case "ratio":
      return { kind: "ratio", value: c.value(p), reference: c.reference(p) };
    case "magnitude": {
      // Margin reaches the client only under a criterion that is ABOUT margin —
      // the same call that reveals the column. `cost` never travels.
      const value = Math.round(marginPct(p) * 10) / 10;
      return { kind: "magnitude", value, unit: "%", sign: value < 0 ? "negative" : "positive" };
    }
    case "recency": {
      // `expired_sale` resolves through `saleExpired`, which is false when
      // `saleEnds` is null — the date is guaranteed by the predicate that
      // selected the row, not by an assertion here.
      const date = p.saleEnds ?? REFERENCE_DATE;
      return { kind: "recency", endedDaysAgo: daysSince(date), date };
    }
    case "none":
      return { kind: "none" };
  }
}

const DAY_MS = 86_400_000;
const daysSince = (iso: string, today = REFERENCE_DATE): number =>
  Math.max(0, Math.round((Date.parse(today) - Date.parse(iso)) / DAY_MS));

/** The rows a criterion will render, each with its measure already computed. */
export function measuredRows(c: Criterion): Measured<PublicProduct>[] {
  return sortByMeasure(c.rows.map((p) => ({ ...toPublic(p), measure: measureOf(c, p) })));
}

/**
 * Worst first — and what "worst" means is a property of the measure, so the
 * order ships from here rather than being re-derived downstream.
 *
 *   ratio      lowest value/reference first (the deepest deficit)
 *   magnitude  largest absolute value first (the most negative margin)
 *   recency    oldest first (the sale that has been wrong the longest)
 *   none       nothing to rank — alphabetical by SKU
 *
 * Discontinued rows sink to the bottom under every kind: they are not
 * restocked, repriced or re-listed, so putting them on top would point the eye
 * at the one group not to act on. SKU breaks every tie, so the order is stable
 * between renders.
 *
 * Generic over the row, because the order has two consumers that carry
 * different amounts of the product: the rendered list ranks whole public rows,
 * and the table's filter ranks a `{ sku, status }` projection. One ranking
 * function either way — the table and the panel cannot order one criterion two
 * ways.
 */
export function sortByMeasure<T extends { sku: string; status: Product["status"] }>(
  rows: Measured<T>[],
): Measured<T>[] {
  return [...rows].sort((a, b) => {
    const aOut = a.status === "discontinued";
    const bOut = b.status === "discontinued";
    if (aOut !== bOut) return aOut ? 1 : -1;
    const d = severity(a.measure) - severity(b.measure);
    if (d !== 0) return d;
    return a.sku.localeCompare(b.sku);
  });
}

/** Ascending = worst first, whatever the kind. */
function severity(m: RowMeasure): number {
  switch (m.kind) {
    case "ratio":
      // A reference of 0 makes the deficit uncomputable, not infinite: the row
      // sinks within its group rather than dividing by zero.
      return m.reference > 0 ? m.value / m.reference : Number.POSITIVE_INFINITY;
    case "magnitude":
      return -Math.abs(m.value);
    case "recency":
      return -m.endedDaysAgo;
    case "none":
      return 0;
  }
}

/** Re-export so tool bodies get the preset phrase without a second import. */
export const presetPhrase = (p: FilterPreset): string => PRESET_SPEC[p].phrase;
export const presetMeasure = (p: FilterPreset): MeasureKind => PRESET_SPEC[p].measure;
