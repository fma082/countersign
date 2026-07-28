/**
 * Server-side scenario catalog.
 *
 * The invariant that governs the whole project: the server resolves, the
 * client reflects. Every count, every margin, every resolved target is
 * computed here — never in the browser. `cost` and `margin` never leave this
 * module in a shape the client can read; the public projection strips `cost`.
 *
 * A single mutable session catalog backs the demo. For a single-instance
 * `next dev` / `next start` this is exactly what we want: `clear_expired_sales`
 * mutates it, and later queries see the mutation.
 */

import {
  PRODUCTS,
  REFERENCE_DATE,
  belowReorder,
  effectivePrice,
  marginPct,
  saleExpired,
  type Product,
} from "./seed-products";

export { REFERENCE_DATE };

/** What the client is allowed to see. `cost` (and derived `margin`) never appear. */
export type PublicProduct = Omit<Product, "cost">;

export const toPublic = (p: Product): PublicProduct => {
  // Structural omit — never spread `cost` into a client payload.
  const { cost: _cost, ...pub } = p;
  void _cost;
  return pub;
};

// ── Mutable session catalog ─────────────────────────────────────────────
// Deep-ish clone so mutations never touch the immutable seed.
let catalog: Product[] = PRODUCTS.map((p) => ({ ...p }));

export const resetCatalog = (): void => {
  catalog = PRODUCTS.map((p) => ({ ...p }));
};

export const allProducts = (): Product[] => catalog;

export const publicProducts = (): PublicProduct[] => catalog.map(toPublic);

// ── Read-side aggregations (drive query_products labels with real counts) ─

export const expiredSales = (today = REFERENCE_DATE): Product[] =>
  catalog.filter((p) => saleExpired(p, today));

export const activeSales = (today = REFERENCE_DATE): Product[] =>
  catalog.filter((p) => p.salePrice !== null && !saleExpired(p, today));

export const belowReorderProducts = (): Product[] =>
  catalog.filter(belowReorder);

/**
 * Stock under an ABSOLUTE number — a different question from `belowReorder`,
 * which compares each product against its OWN reorder point. On the seed the
 * two are worlds apart: 13 products are below their reorder point, 20 are below
 * 50 units, and NB-AU-1001 (42 in stock, reorder 15) is in the second set only.
 * Answering one with the other is how "less than 50 in stock" came back as 13.
 */
export const stockBelowProducts = (threshold: number): Product[] =>
  catalog.filter((p) => p.stock < threshold);

export const negativeMargin = (): Product[] =>
  catalog.filter((p) => marginPct(p) < 0);

export const activeProducts = (): Product[] =>
  catalog.filter((p) => p.status === "active");

/** Products already marked discontinued — the READ counterpart to the
 *  destructive `discontinue_products`, so "list discontinued" resolves to a
 *  safe read instead of forcing the model toward the write. */
export const discontinuedProducts = (): Product[] =>
  catalog.filter((p) => p.status === "discontinued");

/** Active products hidden from the web store — natural discontinue candidates. */
export const hiddenActiveProducts = (): Product[] =>
  catalog.filter((p) => p.status === "active" && !p.webVisible);

export const findProduct = (sku: string): Product | undefined =>
  catalog.find((p) => p.sku === sku);

/** A margin readout the client may display *only* when a tool reveals it. */
export interface MarginRow {
  sku: string;
  effectivePrice: number;
  marginPct: number;
}

export const marginRow = (p: Product): MarginRow => ({
  sku: p.sku,
  effectivePrice: effectivePrice(p),
  marginPct: Math.round(marginPct(p) * 10) / 10,
});

// ── Reversible field writes (radius 1) ───────────────────────────────────
// Single row, single field, window still open. The server reads the prior
// value so the write can be undone, then mutates.

export type WriteField = "price" | "stock" | "webVisible";

export const getField = (sku: string, field: WriteField): number | boolean | undefined => {
  const p = findProduct(sku);
  if (!p) return undefined;
  return field === "price" ? p.price : field === "stock" ? p.stock : p.webVisible;
};

/** Set one field on one row. Returns false if the SKU does not exist. */
export const setField = (sku: string, field: WriteField, value: number | boolean): boolean => {
  const p = findProduct(sku);
  if (!p) return false;
  if (field === "price") p.price = value as number;
  else if (field === "stock") p.stock = value as number;
  else p.webVisible = value as boolean;
  p.lastUpdated = REFERENCE_DATE;
  return true;
};

/** Set one field across many rows (a radius-N write, only reached via the gate). */
export const setFieldBatch = (
  skus: string[],
  field: WriteField,
  value: number | boolean,
): Product[] => {
  const set = new Set(skus);
  const changed: Product[] = [];
  for (const p of catalog) {
    if (set.has(p.sku)) {
      setField(p.sku, field, value);
      changed.push(p);
    }
  }
  return changed;
};

// ── Destructive writes ────────────────────────────────────────────────────

export interface ClearedSale {
  sku: string;
  name: string;
  wasSalePrice: number;
  revertsTo: number; // regular price the row falls back to
  marginBefore: number;
}

/** Resolve which rows an expired-sale sweep would touch — WITHOUT mutating. */
export const previewClearExpiredSales = (today = REFERENCE_DATE): ClearedSale[] =>
  expiredSales(today).map((p) => ({
    sku: p.sku,
    name: p.name,
    wasSalePrice: p.salePrice as number,
    revertsTo: p.price,
    marginBefore: Math.round(marginPct(p) * 10) / 10,
  }));

/**
 * Execute the sweep. Clears salePrice + saleEnds on expired-sale rows only, and
 * only within `allowed` when a subset was approved. The active control sale
 * (NB-LT-2004) is never matched. Returns what changed.
 */
export const applyClearExpiredSales = (
  allowed?: string[],
  today = REFERENCE_DATE,
): ClearedSale[] => {
  const allow = allowed ? new Set(allowed) : null;
  const cleared = previewClearExpiredSales(today).filter((c) => !allow || allow.has(c.sku));
  const skus = new Set(cleared.map((c) => c.sku));
  for (const p of catalog) {
    if (skus.has(p.sku)) {
      p.salePrice = null;
      p.saleEnds = null;
      p.lastUpdated = today;
    }
  }
  return cleared;
};

/** Discontinue products (and drop them from the web store). Subset-aware. */
export const applyDiscontinue = (skus: string[]): Product[] => {
  const set = new Set(skus);
  const changed: Product[] = [];
  for (const p of catalog) {
    if (set.has(p.sku) && p.status === "active") {
      p.status = "discontinued";
      p.webVisible = false;
      p.lastUpdated = REFERENCE_DATE;
      changed.push(p);
    }
  }
  return changed;
};
