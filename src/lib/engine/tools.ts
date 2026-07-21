/**
 * Tools + governance (server-side).
 *
 * This is where "the server resolves, the client reflects" lives. The model
 * asks for a tool; here we decide whether it is safe, gated, or invalid,
 * compute the real counts, resolve targets by name, and build the exact effect
 * the client will apply. The model never gets to label its own result.
 */

import {
  activeSales,
  allProducts,
  applyClearExpiredSales,
  belowReorderProducts,
  expiredSales,
  negativeMargin,
  previewClearExpiredSales,
  REFERENCE_DATE,
} from "@/lib/scenario/catalog";
import {
  effectivePrice,
  marginPct,
  type Product,
} from "@/lib/scenario/seed-products";
import type { ProviderTool } from "./ollama";
import type {
  GateItem,
  GatePreview,
  ToolEvent,
  ViewEffect,
} from "./types";

// ── Metric vocabulary (shared by query_products and filter_view) ───────────
const METRICS = [
  "expired_sales",
  "active_sales",
  "below_reorder",
  "negative_margin",
  "all",
] as const;
type Metric = (typeof METRICS)[number];

const isMetric = (v: unknown): v is Metric =>
  typeof v === "string" && (METRICS as readonly string[]).includes(v);

interface Resolved {
  rows: Product[];
  phrase: string; // "products on an expired sale price"
}

function resolveMetric(metric: Metric): Resolved {
  switch (metric) {
    case "expired_sales":
      return { rows: expiredSales(), phrase: "products still on an expired sale price" };
    case "active_sales":
      return { rows: activeSales(), phrase: "products on an active, valid sale" };
    case "below_reorder":
      return { rows: belowReorderProducts(), phrase: "products below their reorder point" };
    case "negative_margin":
      return { rows: negativeMargin(), phrase: "products selling below cost" };
    case "all":
      return { rows: allProducts(), phrase: "products in the catalog" };
  }
}

const marginsFor = (rows: Product[]): Record<string, number> =>
  Object.fromEntries(rows.map((p) => [p.sku, Math.round(marginPct(p) * 10) / 10]));

// ── Provider tool schemas ──────────────────────────────────────────────────
export const TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "query_products",
      description:
        "Count and inspect products by a business metric. Read-only. Use for questions like how many items are on an expired sale, below reorder point, or selling below cost.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [...METRICS],
            description:
              "expired_sales | active_sales | below_reorder | negative_margin | all",
          },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_view",
      description:
        "Filter the product table to a metric so the human can see the rows. Read-only. Can also reveal the hidden Margin column.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: [...METRICS, "none"],
            description: "Metric to filter by, or 'none' to clear the filter.",
          },
          reveal_margin: {
            type: "boolean",
            description: "Reveal the Margin column for the filtered rows.",
          },
        },
        required: ["filter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_expired_sales",
      description:
        "Remove the sale price from every product whose sale end date has passed, reverting them to their regular price. DESTRUCTIVE and irreversible — requires human approval before it runs.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ── Governance results ─────────────────────────────────────────────────────
export type Governed =
  | { kind: "safe"; event: ToolEvent; effect: ViewEffect; toolResult: string }
  | { kind: "gate"; event: ToolEvent; gate: GatePreview }
  | { kind: "invalid"; event: ToolEvent; toolResult: string };

let gateSeq = 0;

/** Decide how to treat one tool call. Never executes a destructive op here. */
export function govern(id: string, name: string, args: Record<string, unknown>): Governed {
  switch (name) {
    case "query_products":
      return governQuery(id, args);
    case "filter_view":
      return governFilter(id, args);
    case "clear_expired_sales":
      return governClear(id, args);
    default:
      return invalid(id, name, args, `Unknown tool "${name}".`);
  }
}

function governQuery(id: string, args: Record<string, unknown>): Governed {
  if (!isMetric(args.metric)) {
    return invalid(id, "query_products", args, `Unknown metric "${String(args.metric)}".`);
  }
  const { rows, phrase } = resolveMetric(args.metric);
  const targetIds = rows.map((p) => p.sku);
  const summary = `${rows.length} ${phrase}.`;
  const revealMargin = args.metric === "negative_margin";
  const effect: ViewEffect = revealMargin
    ? { reveal: ["margin"], margins: marginsFor(rows), filter: { skus: targetIds } }
    : {};
  return {
    kind: "safe",
    event: event(id, "query_products", "safe", "ok", summary, args, targetIds),
    effect,
    toolResult: JSON.stringify({
      count: rows.length,
      metric: args.metric,
      skus: targetIds,
      ...(revealMargin ? { margins: marginsFor(rows) } : {}),
    }),
  };
}

function governFilter(id: string, args: Record<string, unknown>): Governed {
  const filter = args.filter;
  const revealMargin = args.reveal_margin === true;

  if (filter === "none") {
    return {
      kind: "safe",
      event: event(id, "filter_view", "safe", "ok", "Cleared the filter — showing all 30 products.", args, []),
      effect: { filter: { skus: null }, ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(allProducts()) } : {}) },
      toolResult: JSON.stringify({ filtered: "none", count: 30 }),
    };
  }
  if (!isMetric(filter)) {
    return invalid(id, "filter_view", args, `Unknown filter "${String(filter)}".`);
  }
  const { rows, phrase } = resolveMetric(filter);
  const targetIds = rows.map((p) => p.sku);
  const summary = `Filtered to ${rows.length} ${phrase}${revealMargin ? ", Margin revealed" : ""}.`;
  return {
    kind: "safe",
    event: event(id, "filter_view", "safe", "ok", summary, args, targetIds),
    effect: {
      filter: { skus: targetIds },
      ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(rows) } : {}),
    },
    toolResult: JSON.stringify({ filtered: filter, count: rows.length, skus: targetIds }),
  };
}

function governClear(id: string, args: Record<string, unknown>): Governed {
  const cleared = previewClearExpiredSales();
  const targetIds = cleared.map((c) => c.sku);
  const items: GateItem[] = cleared.map((c) => ({
    sku: c.sku,
    name: c.name,
    detail: `$${c.wasSalePrice.toFixed(2)} → $${c.revertsTo.toFixed(2)}`,
    warn: c.marginBefore < 0,
  }));
  const mutations = expiredSales().map((p) => ({
    sku: p.sku,
    price: p.price,
    salePrice: null,
    saleEnds: null,
    lastUpdated: REFERENCE_DATE,
  }));
  const gate: GatePreview = {
    id: `gate_${++gateSeq}`,
    tool: "clear_expired_sales",
    title: `Clear ${cleared.length} expired sale price${cleared.length === 1 ? "" : "s"}`,
    description:
      "Removes the sale price from every product whose sale end date has passed, reverting each to its regular price. The one active, valid sale is left untouched.",
    targetIds,
    items,
    effect: { mutations, filter: { skus: null } },
  };
  return {
    kind: "gate",
    // pending — the effect has NOT run; the badge must never read "ok" yet.
    event: event(id, "clear_expired_sales", "gate", "pending", `${cleared.length} products would revert to their regular price.`, args, targetIds),
    gate,
  };
}

/** The approve path: actually run the sweep and report what changed. */
export function executeApprovedClear(id: string): {
  event: ToolEvent;
  effect: ViewEffect;
  toolResult: string;
} {
  const cleared = applyClearExpiredSales();
  const targetIds = cleared.map((c) => c.sku);
  const mutations = cleared.map((c) => ({
    sku: c.sku,
    price: c.revertsTo,
    salePrice: null,
    saleEnds: null,
    lastUpdated: REFERENCE_DATE,
  }));
  return {
    event: event(id, "clear_expired_sales", "safe", "ok", `Cleared ${cleared.length} expired sale price${cleared.length === 1 ? "" : "s"}.`, {}, targetIds),
    effect: { mutations, filter: { skus: null } },
    toolResult: JSON.stringify({ cleared: cleared.length, skus: targetIds }),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function event(
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

function invalid(
  id: string,
  name: string,
  args: Record<string, unknown>,
  reason: string,
): Governed {
  return {
    kind: "invalid",
    event: event(id, name, "invalid", "invalid", reason, args, []),
    toolResult: JSON.stringify({ error: reason }),
  };
}
