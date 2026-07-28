/**
 * Tools + governance (server-side).
 *
 * Where "the server resolves, the client reflects" lives, now across three
 * tiers. The model asks for a tool; here we resolve the target, decide the tier
 * by RADIUS (how many rows) and WINDOW (has the effect escaped the system?),
 * compute real counts, and build the exact effect the client will apply.
 *
 *   safe        reads. no writes.
 *   reversible  radius-1 writes with an open window. run now, undoable.
 *   gate        radius-N writes, or writes whose window closes on their own.
 *               wait for human approval; support partial approval.
 *   invalid     discarded for bad arguments. never dressed as "ok".
 *
 * The RADIUS is decided by the SERVER after resolving, never by the model at
 * call time: the same field-write tool is reversible at radius 1 and gated at
 * radius N.
 */

import {
  activeProducts,
  activeSales,
  allProducts,
  applyClearExpiredSales,
  applyDiscontinue,
  belowReorderProducts,
  expiredSales,
  findProduct,
  discontinuedProducts,
  getField,
  hiddenActiveProducts,
  negativeMargin,
  previewClearExpiredSales,
  REFERENCE_DATE,
  setField,
  setFieldBatch,
  stockBelowProducts as stockBelow,
  toPublic,
  type WriteField,
} from "@/lib/scenario/catalog";
import { effectivePrice, marginPct, type Product } from "@/lib/scenario/seed-products";
import { subtitleIntent } from "./intent-subtitle";
import type {
  GateItem,
  GatePreview,
  ProviderTool,
  RowMutation,
  ToolEvent,
  ToolOutcome,
  UndoSpec,
  ViewEffect,
} from "./types";

// ── Selector vocabulary ─────────────────────────────────────────────────────
// Read metrics live on distinct AXES. Keeping the names axis-explicit stops a
// small model from crossing them (e.g. "active products" is a STATUS, not a sale).
//
// BARE metrics name a group on their own: the string IS the whole criterion.
// That is what lets them double as write selectors.
const BARE_METRICS = [
  // sale axis — is there a promo, and is it still valid?
  "on_sale", // a live, valid promo right now
  "expired_sale", // a promo whose end date has passed, not yet cleared
  // status axis — active vs discontinued
  "active",
  "discontinued",
  // other axes
  "below_reorder",
  "negative_margin",
  "all",
] as const;

/**
 * Metrics that name a group only once a NUMBER is supplied. They extend the
 * read vocabulary and stop there — deliberately.
 *
 * `stock_below` is not in `SELECTORS`, so it never reaches `set_web_visible`'s
 * `where` or `discontinue_products`'s `filter`. Those resolve through
 * `resolveSelector(where: string)`, a bare string with nowhere to put a
 * threshold: listing `stock_below` there would offer a DESTRUCTIVE tool a
 * selector whose target set is undefined until an argument it cannot carry
 * arrives. A read can refuse a missing threshold and cost the human a
 * re-ask; a discontinue that resolves "stock below undefined" cannot.
 */
const THRESHOLD_METRICS = ["stock_below"] as const;

/** The full read vocabulary: what `query_products` and `filter_view` accept. */
const METRICS = [...BARE_METRICS, ...THRESHOLD_METRICS] as const;
type Metric = (typeof METRICS)[number];
type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];
const isMetric = (v: unknown): v is Metric =>
  typeof v === "string" && (METRICS as readonly string[]).includes(v);
const needsThreshold = (m: Metric): m is ThresholdMetric =>
  (THRESHOLD_METRICS as readonly string[]).includes(m);

// Write selectors: the bare metrics, plus "hidden" (active + not web-visible).
// A threshold metric is absent by construction — see THRESHOLD_METRICS.
const SELECTORS = [...BARE_METRICS, "hidden"] as const;

interface Resolved {
  rows: Product[];
  phrase: string;
}

/**
 * The one place a metric is put into words. `criterionLabel` is read from here,
 * and so is the metric vocabulary in the system prompt — so the phrase the model
 * is told a metric MEANS and the phrase it is handed back after running it are
 * the same string by construction, not by two people remembering to match.
 *
 * They were not, once: the prompt's only mapping from "selling below cost" to
 * `negative_margin` lived inside an unrelated formatting example, and editing
 * that example silently sent the metric routing somewhere else.
 *
 * A THRESHOLD metric keeps its wording here too, as a template with an `{n}`
 * the server substitutes with the number it actually ran. The map stays one
 * map of plain strings — the parameter rides in the phrase, not in the type —
 * so there is still exactly one place a criterion is put into words.
 */
export const METRIC_PHRASES: Record<Metric, string> = {
  // sale axis
  on_sale: "products on an active, valid sale",
  expired_sale: "products still on an expired sale price",
  // status axis
  active: "products with active status",
  discontinued: "products that are discontinued",
  // other axes
  below_reorder: "products below their reorder point",
  negative_margin: "products selling below cost",
  all: "products in the catalog",
  // threshold axis — {n} is filled from the executed argument, never by the model
  stock_below: "products with stock below {n}",
};

function metricRows(metric: Metric, threshold: number): Product[] {
  switch (metric) {
    case "on_sale":
      return activeSales();
    case "expired_sale":
      return expiredSales();
    case "active":
      return activeProducts();
    case "discontinued":
      return discontinuedProducts();
    case "below_reorder":
      return belowReorderProducts();
    case "negative_margin":
      return negativeMargin();
    case "all":
      return allProducts();
    case "stock_below":
      return stockBelow(threshold);
  }
}

/** The criterion in words, with the executed number substituted in. */
function metricPhrase(metric: Metric, threshold: number): string {
  return METRIC_PHRASES[metric].replace("{n}", String(threshold));
}

/**
 * A read metric's rows and its wording. `threshold` is meaningful only for a
 * threshold metric; the bare ones ignore it.
 *
 * Callers reach this through `readMetric`, which validates the argument first.
 */
function resolveMetric(metric: Metric, threshold = 0): Resolved {
  return { rows: metricRows(metric, threshold), phrase: metricPhrase(metric, threshold) };
}

/**
 * Validate a read before it resolves anything. A threshold metric without a
 * usable number is INVALID — the same stance `set_web_visible` takes on a
 * missing direction. A default of 50 here would be the server inventing the
 * criterion it then reports as executed, which is the one thing this layer
 * exists to prevent.
 */
function readMetric(metric: Metric, raw: unknown): Resolved | { error: string } {
  if (!needsThreshold(metric)) return resolveMetric(metric);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    return {
      error: `${metric} needs a positive numeric threshold — got "${String(raw)}". Pass the number from the question (e.g. threshold: 50); the server will not pick one.`,
    };
  return resolveMetric(metric, Math.floor(n));
}

/** Write selectors resolve from a bare string, so only bare metrics qualify. */
function resolveSelector(where: string): Resolved | null {
  if (where === "hidden")
    return { rows: hiddenActiveProducts(), phrase: "products hidden from the web store" };
  if (isMetric(where) && !needsThreshold(where)) return resolveMetric(where);
  return null;
}

const marginsFor = (rows: Product[]): Record<string, number> =>
  Object.fromEntries(rows.map((p) => [p.sku, Math.round(marginPct(p) * 10) / 10]));

/** Fresh margins for SKUs after a write, so a revealed Margin column never goes
 *  stale (a cleared sale flips a negative margin positive). Server-computed. */
const marginPatch = (skus: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const sku of skus) {
    const p = findProduct(sku);
    if (p) out[sku] = Math.round(marginPct(p) * 10) / 10;
  }
  return out;
};

const money = (n: number) => `$${n.toFixed(2)}`;

// ── Provider tool schemas ──────────────────────────────────────────────────
const selectorEnum = [...SELECTORS];

export const TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "query_products",
      description:
        "Count products by a business metric and show the matching rows to the human. Read-only. You get the count and the criterion back, not the rows — the rows are displayed directly.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", enum: [...METRICS] },
          threshold: {
            type: "number",
            description:
              "Required when metric is stock_below: the number from the question (\"less than 50 in stock\" → 50). Copy it; never round it, never supply one the human did not give.",
          },
          userIntent: {
            type: "string",
            description:
              "Optional. The user's own words for what they asked, verbatim. Used only as a subtitle above the results; it selects nothing.",
          },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_product",
      description:
        "Look up ONE product by its sku and report its real status, stock, reorder point, margin, and sale. Read-only. Use this for any question about a single product (e.g. \"what is the status of NB-AU-1005?\") instead of a metric count.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "The product SKU, e.g. NB-AU-1005." },
        },
        required: ["sku"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_view",
      description:
        "Filter the product table to a metric so the human can see the rows. Read-only. Can reveal the hidden Margin column. You get the count and the criterion back, not the rows — the rows are displayed directly.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: [...METRICS, "none"] },
          threshold: {
            type: "number",
            description:
              "Required when filter is stock_below: the number from the question. Copy it; never supply one the human did not give.",
          },
          reveal_margin: { type: "boolean" },
          userIntent: {
            type: "string",
            description:
              "Optional. The user's own words for what they asked, verbatim. Used only as a subtitle above the results; it selects nothing.",
          },
        },
        required: ["filter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_price",
      description:
        "Set the regular price of ONE product (pass its sku). Reversible — runs immediately and can be undone until the next write.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "The product SKU, e.g. NB-ST-6002." },
          price: { type: "number" },
        },
        required: ["sku", "price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "adjust_stock",
      description:
        "Set the stock level of ONE product (pass its sku). Reversible — runs immediately and can be undone until the next write.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          stock: { type: "number" },
        },
        required: ["sku", "stock"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_web_visible",
      description:
        "Set the web-store visibility of ONE product (pass its sku) to an EXPLICIT value. `visible` is required: true shows it, false hides it. There is no toggle — a call without an explicit direction is rejected, never guessed. Reversible. A `where` selector matching many products becomes a batch and requires approval.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          where: { type: "string", enum: selectorEnum },
          visible: { type: "boolean", description: "Required. true = show, false = hide." },
        },
        required: ["visible"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_expired_sales",
      description:
        "Remove the sale price from every product whose sale has ended. DESTRUCTIVE — requires human approval.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "discontinue_products",
      description:
        "Mark a set of products as discontinued (also hides them from the web store). DESTRUCTIVE — the status propagates downstream, so it requires human approval regardless of how many products match. Pass a `filter`.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: selectorEnum },
        },
        required: ["filter"],
      },
    },
  },
];

// ── Governance results ─────────────────────────────────────────────────────
// Every non-gate decision carries a `ToolOutcome`: what the model gets, and
// (optionally) what only the client gets. `modelPayload` is an object here —
// serialization belongs to the layer that writes the `role:"tool"` message.
export type Governed =
  | { kind: "safe"; event: ToolEvent; effect: ViewEffect; outcome: ToolOutcome }
  | { kind: "reversible"; event: ToolEvent; effect: ViewEffect; outcome: ToolOutcome }
  | { kind: "gate"; event: ToolEvent; gate: GatePreview }
  | { kind: "invalid"; event: ToolEvent; outcome: ToolOutcome };

/** The common case: one channel, nothing withheld and nothing rendered. */
const modelOnly = (modelPayload: unknown): ToolOutcome => ({ modelPayload });

let gateSeq = 0;
let actionSeq = 0;

export function govern(id: string, name: string, args: Record<string, unknown>): Governed {
  switch (name) {
    case "query_products":
      return governQuery(id, args);
    case "inspect_product":
      return governInspect(id, args);
    case "filter_view":
      return governFilter(id, args);
    case "update_price":
      return governFieldWrite(id, "update_price", "price", args);
    case "adjust_stock":
      return governFieldWrite(id, "adjust_stock", "stock", args);
    case "set_web_visible":
      return governFieldWrite(id, "set_web_visible", "webVisible", args);
    case "clear_expired_sales":
    case "discontinue_products":
      return governDestructive(id, name, args);
    default:
      return invalid(id, name, args, `Unknown tool "${name}".`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────
/**
 * The user's own phrasing, as the model reported it. Model data, therefore
 * untrusted — but it executes nothing: it resolves no target, picks no metric,
 * and only ever feeds a subtitle. So we take it liberally and drop it when it is
 * empty or shaped wrong, rather than refusing the read over it.
 */
function cleanIntent(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return text ? text : undefined;
}

/**
 * A read, split across two channels.
 *
 * The model gets the shape of the answer — how many, and WHICH criterion the
 * server actually ran — and not one row. It cannot enumerate SKUs it was never
 * given, and it cannot relabel the result with the user's phrase when the
 * criterion travels next to the count. The rows go to the client, which shows
 * them. `criterionLabel` is the server's own wording, the same one on the tool
 * card, so prose and card cannot drift apart.
 *
 * `userIntent` goes with the rows, NOT with the count — and only when it says
 * something `criterionLabel` does not (see `subtitleIntent`). The split is
 * measured rather than assumed. llama3.2:3b, temperature 0, three runs each,
 * asked "give me the list of products with less than 50 in stock" (which the
 * model resolves to the `below_reorder` metric):
 *
 *   userIntent in modelPayload   → "There are 13 products that are below their
 *                                   reorder point, meaning they have less than
 *                                   50 units in stock."
 *   userIntent in renderPayload  → "There are 13 products that are below their
 *                                   reorder point."
 *
 * That trailing clause is false — `belowReorder` is `stock < reorderPoint` per
 * product and has no 50 in it anywhere. Handed the user's phrasing back, the
 * model restates it as the DEFINITION of the criterion. A system-prompt rule
 * forbidding exactly that was tried first and the 3b model ignored it, which is
 * the whole argument: the prompt asks, the payload decides. The field has no
 * reader on the model channel anyway — the subtitle it feeds is the client's.
 */
function governQuery(id: string, args: Record<string, unknown>): Governed {
  if (!isMetric(args.metric))
    return invalid(id, "query_products", args, `Unknown metric "${String(args.metric)}".`);
  const read = readMetric(args.metric, args.threshold);
  if ("error" in read) return invalid(id, "query_products", args, read.error);
  const { rows, phrase } = read;
  const targetIds = rows.map((p) => p.sku);
  const revealMargin = args.metric === "negative_margin";
  const effect: ViewEffect = revealMargin
    ? { reveal: ["margin"], margins: marginsFor(rows), filter: { skus: targetIds } }
    : {};
  // Kept only if it differs from what we ran. A subtitle that repeats the
  // header teaches the human to stop reading the subtitle.
  const userIntent = subtitleIntent(cleanIntent(args.userIntent), phrase);
  return {
    kind: "safe",
    event: mk(id, "query_products", "safe", "ok", `${rows.length} ${phrase}.`, args, targetIds),
    effect,
    outcome: {
      // No sku, no name, no row. That absence is the guarantee — not a rule in
      // the system prompt asking the model to please not enumerate.
      modelPayload: {
        count: rows.length,
        criterion: args.metric,
        criterionLabel: phrase,
        rendered: true,
      },
      // The full public product objects (cost stripped by `toPublic`), so the
      // field the metric filters on — `reorderPoint` — travels alongside
      // `stock` and the client can render a row without re-deriving anything.
      // `userIntent` rides here too: it is the component's subtitle, and the
      // client is its only reader.
      renderPayload: {
        component: "product_list",
        count: rows.length,
        criterionLabel: phrase,
        data: rows.map(toPublic),
        ...(userIntent ? { userIntent } : {}),
      },
    },
  };
}

/**
 * Read a single product by sku. Safe — runs on its own. The answer is resolved
 * from the SKU's real record (status, stock, reorder, margin, sale), so the model
 * narrates fact instead of improvising a per-SKU claim from an unrelated count.
 * Margin reaches the client only here, deliberately, and cost is never included.
 */
function governInspect(id: string, args: Record<string, unknown>): Governed {
  const sku = typeof args.sku === "string" ? args.sku.trim() : "";
  const p = sku ? findProduct(sku) : undefined;
  if (!p)
    return invalid(id, "inspect_product", args, sku ? `No product with SKU "${sku}".` : "Pass a sku to inspect.");

  const margin = Math.round(marginPct(p) * 10) / 10;
  const belowReorder = p.stock < p.reorderPoint;
  const onSale = p.salePrice !== null;
  const summary =
    `${p.name} (${p.sku}) — ${p.status}, ${p.stock} in stock` +
    `${belowReorder ? " (below reorder)" : ""}, margin ${margin}%` +
    `${onSale ? `, on sale at ${money(p.salePrice as number)}` : ""}.`;
  return {
    kind: "safe",
    event: mk(id, "inspect_product", "safe", "ok", summary, args, [p.sku]),
    effect: {},
    outcome: modelOnly({
      sku: p.sku,
      name: p.name,
      status: p.status,
      stock: p.stock,
      reorderPoint: p.reorderPoint,
      belowReorder,
      margin,
      onSale,
      salePrice: p.salePrice,
      saleEnds: p.saleEnds,
      price: p.price,
    }),
  };
}

/**
 * Filter the table to a metric. Split across the same two channels as
 * `governQuery`, and for the same reason.
 *
 * This tool used to return `{ filtered, count, skus }`: a raw enum token, a
 * number, and thirteen SKUs. The model had to turn `below_reorder` into English
 * on its own, and with no wording to copy it reached for the nearest phrasing it
 * had — the example in the system prompt — and answered "13 products are selling
 * below cost" over a run of `below_reorder`. Same class of failure the payload
 * split closed for `query_products`, still open here because the label was
 * missing. So the label ships, the SKUs do not, and the rows go to the client.
 */
function governFilter(id: string, args: Record<string, unknown>): Governed {
  const filter = args.filter;
  const revealMargin = args.reveal_margin === true;

  if (filter === "none") {
    // Clearing the filter still resolves a group — everything — and the model
    // still has to name it. No render payload: the point of this branch is
    // removing a selection, not listing one. `rendered` stays true because the
    // table below is what the human is now looking at.
    const all = allProducts();
    return {
      kind: "safe",
      event: mk(id, "filter_view", "safe", "ok", `Cleared the filter — showing all ${all.length} products.`, args, []),
      effect: { filter: { skus: null }, ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(all) } : {}) },
      outcome: modelOnly({
        count: all.length,
        criterion: "none",
        criterionLabel: "products in the catalog, unfiltered",
        rendered: true,
      }),
    };
  }

  if (!isMetric(filter))
    return invalid(id, "filter_view", args, `Unknown filter "${String(filter)}".`);
  const read = readMetric(filter, args.threshold);
  if ("error" in read) return invalid(id, "filter_view", args, read.error);
  const { rows, phrase } = read;
  const targetIds = rows.map((p) => p.sku);
  // Same gate as `governQuery`: only a phrasing that differs from the executed
  // criterion earns the subtitle.
  const userIntent = subtitleIntent(cleanIntent(args.userIntent), phrase);
  return {
    kind: "safe",
    event: mk(id, "filter_view", "safe", "ok", `Filtered to ${rows.length} ${phrase}${revealMargin ? ", Margin revealed" : ""}.`, args, targetIds),
    effect: { filter: { skus: targetIds }, ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(rows) } : {}) },
    outcome: {
      // The criterion in words, built by the server from what it executed. No
      // sku, no row — the same guarantee `query_products` makes.
      modelPayload: {
        count: rows.length,
        criterion: filter,
        criterionLabel: phrase,
        rendered: true,
      },
      // Same shape of data as a query, so the same component reads it.
      renderPayload: {
        component: "product_list",
        count: rows.length,
        criterionLabel: phrase,
        data: rows.map(toPublic),
        ...(userIntent ? { userIntent } : {}),
      },
    },
  };
}

// ── Reversible field writes (radius decides the tier) ─────────────────────
function resolveTargets(args: Record<string, unknown>): { rows: Product[]; error?: string } {
  const skuRaw = typeof args.sku === "string" ? args.sku.trim() : "";
  const where = typeof args.where === "string" ? args.where.trim() : "";
  // Small models often fill an unused `sku` with a placeholder ("none", "all").
  // A real SKU wins; a junk one is ignored in favour of a `where` selector.
  const sku = skuRaw && !["none", "all", "null", "any"].includes(skuRaw.toLowerCase()) ? skuRaw : "";

  if (sku) {
    const p = findProduct(sku);
    if (p) return { rows: [p] };
    if (!where) return { rows: [], error: `No product with SKU "${sku}".` };
  }
  if (where) {
    const sel = resolveSelector(where);
    return sel ? { rows: sel.rows } : { rows: [], error: `Unknown selector "${where}".` };
  }
  return { rows: [], error: "No target — pass a sku (or a where selector)." };
}

function governFieldWrite(
  id: string,
  tool: string,
  field: WriteField,
  args: Record<string, unknown>,
): Governed {
  const { rows, error } = resolveTargets(args);
  if (error) return invalid(id, tool, args, error);
  if (rows.length === 0) return invalid(id, tool, args, "No products match.");

  // Validate the value BEFORE deciding anything.
  const parsed = writeValue(tool, args);
  if ("error" in parsed) return invalid(id, tool, args, parsed.error);
  const value = parsed.value;

  // RADIUS is the server's call, made here after resolving.
  if (rows.length === 1) {
    // radius 1 + open window → reversible: run now, keep it undoable.
    const p = rows[0];
    const from = getField(p.sku, field)!;
    setField(p.sku, field, value);
    const undo: UndoSpec = {
      actionId: `act_${++actionSeq}`,
      tool,
      sku: p.sku,
      name: p.name,
      field,
      from,
      to: value,
    };
    return {
      kind: "reversible",
      event: {
        ...mk(id, tool, "reversible", "ok", writeSummary(field, p.name, from, value), args, [p.sku]),
        undo,
      },
      effect: { mutations: [fieldMutation(p.sku, field, value)], margins: marginPatch([p.sku]) },
      outcome: modelOnly({ ok: true, sku: p.sku, field, from, to: value }),
    };
  }

  // radius > 1 → too wide to catch a mistake at a glance → gate.
  const plan = planFieldBatch(tool, field, value, rows);
  return gateFrom(id, tool, args, plan, `${rows.length} products would change (${field}). Too many to undo at a glance.`);
}

// ── Destructive gates ──────────────────────────────────────────────────────
function governDestructive(id: string, tool: string, args: Record<string, unknown>): Governed {
  const plan = tool === "clear_expired_sales" ? planClear() : planDiscontinue(args);
  if ("error" in plan) return invalid(id, tool, args, plan.error);
  if (plan.targetIds.length === 0) return invalid(id, tool, args, "Nothing matches — nothing to do.");
  return gateFrom(id, tool, args, plan, plan.pendingSummary);
}

// ── Plans: preview + subset execution, per destructive/batch op ─────────────
interface Plan {
  title: string;
  description: string;
  pendingSummary: string;
  targetIds: string[];
  items: GateItem[];
  execute: (allowed: string[]) => { mutations: RowMutation[]; okSummary: string };
}

function planClear(): Plan {
  const preview = previewClearExpiredSales();
  return {
    title: `Clear ${preview.length} expired sale price${preview.length === 1 ? "" : "s"}`,
    description:
      "Removes the sale price from products whose sale has ended, reverting each to its regular price. The one active, valid sale is left untouched.",
    pendingSummary: `${preview.length} products would revert to their regular price.`,
    targetIds: preview.map((c) => c.sku),
    items: preview.map((c) => ({
      sku: c.sku,
      name: c.name,
      detail: `${money(c.wasSalePrice)} → ${money(c.revertsTo)}`,
      warn: c.marginBefore < 0,
    })),
    execute: (allowed) => {
      const cleared = applyClearExpiredSales(allowed);
      return {
        mutations: cleared.map((c) => ({ sku: c.sku, price: c.revertsTo, salePrice: null, saleEnds: null, lastUpdated: REFERENCE_DATE })),
        okSummary: `Cleared ${cleared.length} expired sale price${cleared.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

function planDiscontinue(args: Record<string, unknown>): Plan | { error: string } {
  const where = typeof args.filter === "string" ? args.filter : "";
  const sel = resolveSelector(where);
  if (!sel) return { error: `Unknown filter "${String(args.filter)}".` };
  const rows = sel.rows.filter((p) => p.status === "active"); // can't discontinue twice
  return {
    title: `Discontinue ${rows.length} product${rows.length === 1 ? "" : "s"}`,
    description:
      "Marks each product as discontinued and drops it from the web store. The status propagates downstream, so this is destructive regardless of count.",
    pendingSummary: `${rows.length} products would be discontinued (${sel.phrase}).`,
    targetIds: rows.map((p) => p.sku),
    items: rows.map((p) => ({
      sku: p.sku,
      name: p.name,
      detail: `stock ${p.stock} · ${money(effectivePrice(p))}`,
      warn: p.stock > 0, // discontinuing something you still hold is worth a second look
    })),
    execute: (allowed) => {
      const changed = applyDiscontinue(allowed);
      return {
        mutations: changed.map((p) => ({ sku: p.sku, status: "discontinued" as const, webVisible: false, lastUpdated: REFERENCE_DATE })),
        okSummary: `Discontinued ${changed.length} product${changed.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

function planFieldBatch(tool: string, field: WriteField, value: number | boolean, rows: Product[]): Plan {
  const verb = tool === "update_price" ? "set the price" : tool === "adjust_stock" ? "set stock" : "change web visibility";
  return {
    title: `${cap(verb)} on ${rows.length} products`,
    description: `A radius-${rows.length} write. Applied together, it is too wide to catch a mistake at a glance — so it waits.`,
    pendingSummary: `${rows.length} products would change.`,
    targetIds: rows.map((p) => p.sku),
    items: rows.map((p) => ({ sku: p.sku, name: p.name, detail: fieldDetail(field, p, value), warn: false })),
    execute: (allowed) => {
      const changed = setFieldBatch(allowed, field, value);
      return {
        mutations: changed.map((p) => fieldMutation(p.sku, field, value)),
        okSummary: `Updated ${field} on ${changed.length} product${changed.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

// ── Gate assembly + subset execution ───────────────────────────────────────
function gateFrom(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  plan: Plan,
  pendingSummary: string,
): Governed {
  const gate: GatePreview = {
    id: `gate_${++gateSeq}`,
    tool,
    title: plan.title,
    description: plan.description,
    targetIds: plan.targetIds,
    items: plan.items,
    effect: { filter: { skus: null } },
  };
  return {
    kind: "gate",
    event: mk(id, tool, "gate", "pending", pendingSummary, args, plan.targetIds),
    gate,
  };
}

/** Re-plan for a stored gate, intersect with the human's exclusions, execute. */
export function executeGate(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  excludedIds: string[],
): { event: ToolEvent; effect: ViewEffect; outcome: ToolOutcome } {
  const plan =
    tool === "clear_expired_sales"
      ? planClear()
      : tool === "discontinue_products"
        ? (planDiscontinue(args) as Plan)
        : replanFieldBatch(tool, args);

  // The client can only SHRINK the server's own preview. An excluded ID that
  // was never in the preview is meaningless and dropped.
  const preview = new Set(plan.targetIds);
  const excluded = excludedIds.filter((eid) => preview.has(eid));
  const excludedSet = new Set(excluded);
  const allowed = plan.targetIds.filter((sku) => !excludedSet.has(sku));

  const { mutations, okSummary } = plan.execute(allowed);
  const suffix = excluded.length ? ` ${excluded.length} excluded by you.` : "";
  return {
    event: {
      ...mk(callId, tool, "gate", "ok", okSummary + suffix, args, allowed),
      excluded,
    },
    effect: { mutations, filter: { skus: null }, margins: marginPatch(allowed) },
    outcome: modelOnly({ approved: allowed.length, excluded: excluded.length, skus: allowed }),
  };
}

function replanFieldBatch(tool: string, args: Record<string, unknown>): Plan {
  const field: WriteField = tool === "update_price" ? "price" : tool === "adjust_stock" ? "stock" : "webVisible";
  const { rows } = resolveTargets(args);
  const parsed = writeValue(tool, args);
  const value = "value" in parsed ? parsed.value : field === "webVisible" ? false : 0;
  return planFieldBatch(tool, field, value, rows);
}

// ── Undo (human-only, still server-resolved) ────────────────────────────────
export function executeUndo(
  callId: string,
  spec: UndoSpec,
  force: boolean,
):
  | { kind: "undone"; event: ToolEvent; effect: ViewEffect; outcome: ToolOutcome }
  | { kind: "stale"; field: string; expected: number | boolean; actual: number | boolean } {
  const current = getField(spec.sku, spec.field);
  if (current === undefined)
    return { kind: "undone", event: mk(callId, spec.tool, "safe", "undone", "Nothing to undo — the product is gone.", {}, []), effect: {}, outcome: modelOnly({}) };

  // Stale undo: the value drifted since the original write. Don't restore
  // blindly — surface the drift and let the human confirm.
  if (!force && current !== spec.to) {
    return { kind: "stale", field: spec.field, expected: spec.to, actual: current };
  }

  setField(spec.sku, spec.field, spec.from);
  const summary = writeSummary(spec.field, spec.name, spec.to, spec.from); // reversed
  return {
    kind: "undone",
    event: mk(callId, spec.tool, "safe", "undone", summary, {}, [spec.sku]),
    effect: { mutations: [fieldMutation(spec.sku, spec.field, spec.from)], margins: marginPatch([spec.sku]) },
    outcome: modelOnly({ undone: true, sku: spec.sku, field: spec.field, restoredTo: spec.from }),
  };
}

// ── value + formatting helpers ──────────────────────────────────────────────
function writeValue(
  tool: string,
  args: Record<string, unknown>,
): { value: number | boolean } | { error: string } {
  if (tool === "update_price") {
    const n = Number(args.price);
    if (!Number.isFinite(n) || n <= 0) return { error: `Invalid price "${String(args.price)}".` };
    return { value: Math.round(n * 100) / 100 };
  }
  if (tool === "adjust_stock") {
    const n = Number(args.stock);
    if (!Number.isInteger(n) || n < 0) return { error: `Invalid stock "${String(args.stock)}".` };
    return { value: n };
  }
  // set_web_visible: the direction is MANDATORY and EXPLICIT. A boolean (or its
  // clear string form) is honoured; anything else — omitted, a number, a vague
  // string — is refused. We never infer and never flip the current state. A
  // write without a direction does not execute. ("toggle" invited exactly the
  // ambiguity a small model then exposed; "set" + required arg closes it.)
  if (typeof args.visible === "boolean") return { value: args.visible };
  if (args.visible === "true") return { value: true };
  if (args.visible === "false") return { value: false };
  return {
    error:
      "set_web_visible needs an explicit visible: true or false. It was omitted or unclear — refusing to guess a direction.",
  };
}

function writeSummary(field: WriteField, name: string, from: number | boolean, to: number | boolean): string {
  if (field === "price") return `${name} · ${money(from as number)} → ${money(to as number)}`;
  if (field === "stock") return `${name} · stock ${from} → ${to}`;
  return `${name} · ${to ? "shown on web" : "hidden from web"}`;
}

function fieldDetail(field: WriteField, p: Product, value: number | boolean): string {
  if (field === "price") return `${money(p.price)} → ${money(value as number)}`;
  if (field === "stock") return `stock ${p.stock} → ${value}`;
  return value ? "hide → show" : "show → hide";
}

function fieldMutation(sku: string, field: WriteField, value: number | boolean): RowMutation {
  const base: RowMutation = { sku, lastUpdated: REFERENCE_DATE };
  if (field === "price") base.price = value as number;
  else if (field === "stock") base.stock = value as number;
  else base.webVisible = value as boolean;
  return base;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function mk(
  id: string,
  name: string,
  decision: ToolEvent["decision"],
  badge: ToolEvent["badge"],
  summary: string,
  args: Record<string, unknown>,
  targetIds: string[],
): ToolEvent {
  return { id, name, decision, badge, summary, args, targetIds };
}

function invalid(id: string, name: string, args: Record<string, unknown>, reason: string): Governed {
  return {
    kind: "invalid",
    event: mk(id, name, "invalid", "invalid", reason, args, []),
    outcome: modelOnly({ error: reason }),
  };
}
