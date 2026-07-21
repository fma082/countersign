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

export const negativeMargin = (): Product[] =>
  catalog.filter((p) => marginPct(p) < 0);

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

// ── Write-side: the one destructive operation this iteration ships ────────

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

/** Execute the sweep. Clears salePrice + saleEnds on expired-sale rows only.
 *  The active control sale (NB-LT-2004) is never matched. Returns what changed. */
export const applyClearExpiredSales = (today = REFERENCE_DATE): ClearedSale[] => {
  const cleared = previewClearExpiredSales(today);
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
