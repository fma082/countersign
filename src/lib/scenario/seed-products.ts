/**
 * Northbase — product catalog seed (fictional).
 * 30 rows across 6 categories and 4 suppliers.
 *
 * Conflicts are planted on purpose so the agent can *discover* problems
 * instead of being told about them: expired sale prices, some of them selling
 * below cost, stock under the reorder point, rows hidden from the web store,
 * a status column that is not uniform, and one valid sale as a control case
 * that must NOT be swept up.
 *
 * The rosters and the counts live in `PLANTED` / `SEED_COUNTS` at the foot of
 * this file, derived from the catalog and asserted against it at import. They
 * are deliberately NOT restated here: this header used to carry its own copy of
 * the numbers, and that copy went stale.
 *
 * Reference date for the scenario: 2026-07-21
 */

export type ProductStatus = "active" | "discontinued";

export interface Product {
  sku: string;
  name: string;
  category: string;
  supplier: string;
  status: ProductStatus;
  price: number;
  cost: number;
  stock: number;
  reorderPoint: number;
  salePrice: number | null;
  saleEnds: string | null; // ISO date
  webVisible: boolean;
  lastUpdated: string; // ISO date
}

export const REFERENCE_DATE = "2026-07-21";

export const PRODUCTS: Product[] = [
  // ── Audio ────────────────────────────────────────────────────────────
  { sku: "NB-AU-1001", name: "Studio Monitor Stand, Pair", category: "Audio", supplier: "Meridian Supply", status: "active", price: 129.00, cost: 71.50, stock: 42, reorderPoint: 15, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-06-14" },
  { sku: "NB-AU-1002", name: "Desktop Mic Boom Arm", category: "Audio", supplier: "Ardent Components", status: "active", price: 64.00, cost: 39.00, stock: 8, reorderPoint: 20, salePrice: 44.90, saleEnds: "2025-11-30", webVisible: true, lastUpdated: "2025-11-02" },
  { sku: "NB-AU-1003", name: "In-Line Headphone Amp", category: "Audio", supplier: "Kestrel Trading", status: "active", price: 89.00, cost: 58.00, stock: 61, reorderPoint: 20, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-05-30" },
  { sku: "NB-AU-1004", name: "XLR Patch Bay, 24-Channel", category: "Audio", supplier: "Meridian Supply", status: "active", price: 219.00, cost: 168.00, stock: 5, reorderPoint: 10, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-03-11" },
  { sku: "NB-AU-1005", name: "Acoustic Panel Set, 12-Pack", category: "Audio", supplier: "Northwind Parts", status: "discontinued", price: 149.00, cost: 96.00, stock: 0, reorderPoint: 10, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2025-09-08" },

  // ── Lighting ─────────────────────────────────────────────────────────
  { sku: "NB-LT-2001", name: "Bi-Color LED Panel", category: "Lighting", supplier: "Ardent Components", status: "active", price: 189.00, cost: 142.00, stock: 27, reorderPoint: 12, salePrice: 139.00, saleEnds: "2026-01-31", webVisible: true, lastUpdated: "2026-01-04" },
  { sku: "NB-LT-2002", name: "Softbox Kit, 60cm", category: "Lighting", supplier: "Kestrel Trading", status: "active", price: 112.00, cost: 74.00, stock: 33, reorderPoint: 12, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-06-02" },
  { sku: "NB-LT-2003", name: "Adjustable Clamp Light", category: "Lighting", supplier: "Meridian Supply", status: "active", price: 34.00, cost: 26.50, stock: 11, reorderPoint: 25, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-04-19" },
  { sku: "NB-LT-2004", name: "RGB Strip Controller", category: "Lighting", supplier: "Northwind Parts", status: "active", price: 47.00, cost: 29.00, stock: 88, reorderPoint: 20, salePrice: 39.00, saleEnds: "2026-08-31", webVisible: true, lastUpdated: "2026-07-05" },
  { sku: "NB-LT-2005", name: "Gel Filter Pack", category: "Lighting", supplier: "Ardent Components", status: "active", price: 22.00, cost: 18.50, stock: 140, reorderPoint: 30, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2025-12-15" },

  // ── Cables ───────────────────────────────────────────────────────────
  { sku: "NB-CB-3001", name: "USB-C Braided Cable, 2m", category: "Cables", supplier: "Kestrel Trading", status: "active", price: 18.00, cost: 12.00, stock: 310, reorderPoint: 80, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-07-01" },
  { sku: "NB-CB-3002", name: "HDMI 2.1 Cable, 3m", category: "Cables", supplier: "Kestrel Trading", status: "active", price: 29.00, cost: 21.00, stock: 46, reorderPoint: 60, salePrice: 19.90, saleEnds: "2026-02-14", webVisible: true, lastUpdated: "2026-02-01" },
  { sku: "NB-CB-3003", name: "Optical Audio Cable, 1.5m", category: "Cables", supplier: "Meridian Supply", status: "active", price: 15.00, cost: 9.50, stock: 122, reorderPoint: 40, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-05-21" },
  { sku: "NB-CB-3004", name: "Cat6 Patch Cable 5m, 10-Pack", category: "Cables", supplier: "Northwind Parts", status: "active", price: 41.00, cost: 27.00, stock: 19, reorderPoint: 25, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-06-28" },
  { sku: "NB-CB-3005", name: "Cable Management Sleeve", category: "Cables", supplier: "Ardent Components", status: "discontinued", price: 12.00, cost: 8.00, stock: 3, reorderPoint: 20, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2025-10-04" },

  // ── Power ────────────────────────────────────────────────────────────
  { sku: "NB-PW-4001", name: "Surge Strip, 8-Outlet", category: "Power", supplier: "Meridian Supply", status: "active", price: 54.00, cost: 38.00, stock: 74, reorderPoint: 25, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-06-11" },
  { sku: "NB-PW-4002", name: "USB-C Charger, 100W", category: "Power", supplier: "Ardent Components", status: "active", price: 69.00, cost: 52.00, stock: 12, reorderPoint: 30, salePrice: 49.00, saleEnds: "2025-12-31", webVisible: true, lastUpdated: "2025-12-03" },
  { sku: "NB-PW-4003", name: "Portable Power Bank, 20k mAh", category: "Power", supplier: "Kestrel Trading", status: "active", price: 79.00, cost: 51.00, stock: 55, reorderPoint: 20, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-07-08" },
  { sku: "NB-PW-4004", name: "Rack PDU, 1U", category: "Power", supplier: "Northwind Parts", status: "active", price: 245.00, cost: 191.00, stock: 7, reorderPoint: 8, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-02-27" },
  { sku: "NB-PW-4005", name: "Inline Voltage Meter", category: "Power", supplier: "Meridian Supply", status: "active", price: 31.00, cost: 24.00, stock: 96, reorderPoint: 25, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2026-01-16" },

  // ── Mounts ───────────────────────────────────────────────────────────
  { sku: "NB-MT-5001", name: "Single Monitor Arm", category: "Mounts", supplier: "Kestrel Trading", status: "active", price: 96.00, cost: 61.00, stock: 38, reorderPoint: 15, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-06-20" },
  { sku: "NB-MT-5002", name: "Dual Monitor Arm", category: "Mounts", supplier: "Kestrel Trading", status: "active", price: 149.00, cost: 98.00, stock: 9, reorderPoint: 12, salePrice: 119.00, saleEnds: "2026-03-15", webVisible: true, lastUpdated: "2026-03-02" },
  { sku: "NB-MT-5003", name: "VESA Adapter Plate", category: "Mounts", supplier: "Ardent Components", status: "active", price: 24.00, cost: 15.00, stock: 130, reorderPoint: 30, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-05-09" },
  { sku: "NB-MT-5004", name: "Aluminum Laptop Riser", category: "Mounts", supplier: "Northwind Parts", status: "active", price: 58.00, cost: 44.00, stock: 21, reorderPoint: 20, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-04-02" },
  { sku: "NB-MT-5005", name: "Full-Motion Wall Mount", category: "Mounts", supplier: "Meridian Supply", status: "discontinued", price: 134.00, cost: 89.00, stock: 0, reorderPoint: 10, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2025-08-22" },

  // ── Storage ──────────────────────────────────────────────────────────
  { sku: "NB-ST-6001", name: "NVMe Enclosure, USB4", category: "Storage", supplier: "Ardent Components", status: "active", price: 88.00, cost: 64.00, stock: 44, reorderPoint: 18, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-07-12" },
  { sku: "NB-ST-6002", name: "SD Card Case, 12-Slot", category: "Storage", supplier: "Northwind Parts", status: "active", price: 16.00, cost: 13.50, stock: 6, reorderPoint: 25, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-03-29" },
  { sku: "NB-ST-6003", name: "2-Bay Drive Dock", category: "Storage", supplier: "Kestrel Trading", status: "active", price: 119.00, cost: 87.00, stock: 29, reorderPoint: 12, salePrice: 92.00, saleEnds: "2026-04-30", webVisible: true, lastUpdated: "2026-04-08" },
  { sku: "NB-ST-6004", name: "Archival Disc Spindle", category: "Storage", supplier: "Meridian Supply", status: "active", price: 27.00, cost: 22.00, stock: 158, reorderPoint: 40, salePrice: null, saleEnds: null, webVisible: false, lastUpdated: "2025-11-20" },
  { sku: "NB-ST-6005", name: "Rugged Portable SSD, 2TB", category: "Storage", supplier: "Ardent Components", status: "active", price: 199.00, cost: 148.00, stock: 16, reorderPoint: 20, salePrice: null, saleEnds: null, webVisible: true, lastUpdated: "2026-07-16" },
];

// ── Derived helpers (server-side only — the UI never recomputes these) ──

/** Price a customer actually pays today. Note the bug the scenario exposes:
 *  an expired saleEnds does NOT clear salePrice in this fictional legacy system. */
export const effectivePrice = (p: Product): number => p.salePrice ?? p.price;

export const saleExpired = (p: Product, today = REFERENCE_DATE): boolean =>
  p.saleEnds !== null && p.saleEnds < today;

export const marginPct = (p: Product): number =>
  ((effectivePrice(p) - p.cost) / effectivePrice(p)) * 100;

export const belowReorder = (p: Product): boolean => p.stock < p.reorderPoint;

// ── Planted conflicts, for reference when writing the guided flow ──────────

/**
 * One seeded conflict: the SKU roster you read when writing a guided step, next
 * to the predicate the engine actually runs over the catalog.
 */
interface PlantedGroup {
  /** How the group reads in prose. */
  label: string;
  /** The roster. Order is irrelevant — it is compared as a set. */
  skus: readonly string[];
  /** What the engine runs. The roster must be exactly this, or the build fails. */
  match: (p: Product) => boolean;
}

/**
 * The conflicts, as data instead of as a paragraph.
 *
 * No count is written down here, because a written count drifts: the
 * below-reorder figure was typed as 11, went stale when the seed grew to 13,
 * and was then corrected by hand TWICE — once in this block, and once, days
 * later, in this file's own header, which had gone on saying 11 in the
 * meantime. A number that has to be maintained in two places is a number that
 * will be wrong in one of them.
 *
 * So the roster is the only thing authored, the count is derived from it
 * (`SEED_COUNTS`), and `assertPlanted` re-runs every predicate against
 * `PRODUCTS` at import. A roster that stops describing the catalog stops the
 * build.
 */
const PLANTED: Record<PlantedKey, PlantedGroup> = {
  expiredSale: {
    label: "expired sale still applied",
    skus: ["NB-AU-1002", "NB-LT-2001", "NB-CB-3002", "NB-PW-4002", "NB-MT-5002", "NB-ST-6003"],
    match: (p) => p.salePrice !== null && saleExpired(p),
  },
  belowCost: {
    // All three only because of an expired sale:
    //   NB-LT-2001  139.00 vs cost 142.00  →  -2.2%
    //   NB-CB-3002   19.90 vs cost  21.00  →  -5.5%
    //   NB-PW-4002   49.00 vs cost  52.00  →  -6.1%
    label: "selling below cost right now",
    skus: ["NB-LT-2001", "NB-CB-3002", "NB-PW-4002"],
    match: (p) => effectivePrice(p) < p.cost,
  },
  activeSale: {
    // The control case that must survive any sweep. NB-LT-2004 ends 2026-08-31.
    label: "on a valid, unexpired sale",
    skus: ["NB-LT-2004"],
    match: (p) => p.salePrice !== null && !saleExpired(p),
  },
  belowReorder: {
    // `belowReorder` is stock < reorderPoint and knows nothing about status, so
    // the two discontinued rows sitting at stock 0 match too (NB-AU-1005,
    // NB-MT-5005). That is deliberate, not an oversight.
    label: "below reorder point",
    skus: [
      "NB-AU-1002", "NB-AU-1004", "NB-AU-1005", "NB-LT-2003", "NB-CB-3002",
      "NB-CB-3004", "NB-CB-3005", "NB-PW-4002", "NB-PW-4004", "NB-MT-5002",
      "NB-MT-5005", "NB-ST-6002", "NB-ST-6005",
    ],
    match: belowReorder,
  },
  hidden: {
    label: "hidden from the web store",
    skus: ["NB-AU-1005", "NB-LT-2005", "NB-CB-3005", "NB-PW-4005", "NB-MT-5005", "NB-ST-6004"],
    match: (p) => !p.webVisible,
  },
  discontinued: {
    label: "already discontinued",
    skus: ["NB-AU-1005", "NB-CB-3005", "NB-MT-5005"],
    match: (p) => p.status === "discontinued",
  },
};

type PlantedKey =
  | "expiredSale"
  | "belowCost"
  | "activeSale"
  | "belowReorder"
  | "hidden"
  | "discontinued";

/** Every seeded count, derived. Read these; never write one down. */
export const SEED_COUNTS = Object.fromEntries(
  (Object.entries(PLANTED) as [PlantedKey, PlantedGroup][]).map(([k, g]) => [k, g.skus.length]),
) as Record<PlantedKey, number>;

/** Throws if any roster above has stopped describing the catalog below it. */
function assertPlanted(): void {
  const drifted = (Object.entries(PLANTED) as [PlantedKey, PlantedGroup][]).flatMap(([key, g]) => {
    const actual = PRODUCTS.filter(g.match).map((p) => p.sku).sort();
    const listed = [...g.skus].sort();
    if (actual.join() === listed.join()) return [];
    return [
      `  ${key} (${g.label}): documented ${listed.length} [${listed.join(" ")}], ` +
        `catalog has ${actual.length} [${actual.join(" ")}]`,
    ];
  });
  if (drifted.length)
    throw new Error(
      `seed-products: the planted-conflict roster no longer describes PRODUCTS.\n${drifted.join("\n")}`,
    );
}

// Runs at import, and every route reaches this module through `catalog`, so a
// drifted roster fails `next build` and `next dev` the same way. `PRODUCTS` is a
// literal, so this is a check over compile-time constants: if it passes the
// build it cannot begin failing in production.
assertPlanted();
