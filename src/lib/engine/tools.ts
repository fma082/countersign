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
  activeSales,
  allProducts,
  applyClearExpiredSales,
  applyDiscontinue,
  belowReorderProducts,
  expiredSales,
  findProduct,
  getField,
  hiddenActiveProducts,
  negativeMargin,
  previewClearExpiredSales,
  REFERENCE_DATE,
  setField,
  setFieldBatch,
  type WriteField,
} from "@/lib/scenario/catalog";
import { effectivePrice, marginPct, type Product } from "@/lib/scenario/seed-products";
import type { ProviderTool } from "./ollama";
import type {
  GateItem,
  GatePreview,
  RowMutation,
  ToolEvent,
  UndoSpec,
  ViewEffect,
} from "./types";

// ── Selector vocabulary ─────────────────────────────────────────────────────
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

// `where`/`filter` for writes also accepts "hidden" (active + not web-visible).
const SELECTORS = [...METRICS, "hidden"] as const;

interface Resolved {
  rows: Product[];
  phrase: string;
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

function resolveSelector(where: string): Resolved | null {
  if (where === "hidden")
    return { rows: hiddenActiveProducts(), phrase: "products hidden from the web store" };
  if (isMetric(where)) return resolveMetric(where);
  return null;
}

const marginsFor = (rows: Product[]): Record<string, number> =>
  Object.fromEntries(rows.map((p) => [p.sku, Math.round(marginPct(p) * 10) / 10]));

const money = (n: number) => `$${n.toFixed(2)}`;

// ── Provider tool schemas ──────────────────────────────────────────────────
const selectorEnum = [...SELECTORS];

export const TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "query_products",
      description:
        "Count and inspect products by a business metric. Read-only.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", enum: [...METRICS] },
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
        "Filter the product table to a metric so the human can see the rows. Read-only. Can reveal the hidden Margin column.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: [...METRICS, "none"] },
          reveal_margin: { type: "boolean" },
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
      name: "toggle_web_visible",
      description:
        "Show or hide ONE product from the web store (pass its sku). Reversible. If a `where` selector matches many products it becomes a batch and requires approval.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          where: { type: "string", enum: selectorEnum },
          visible: { type: "boolean" },
        },
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
export type Governed =
  | { kind: "safe"; event: ToolEvent; effect: ViewEffect; toolResult: string }
  | { kind: "reversible"; event: ToolEvent; effect: ViewEffect; toolResult: string }
  | { kind: "gate"; event: ToolEvent; gate: GatePreview }
  | { kind: "invalid"; event: ToolEvent; toolResult: string };

let gateSeq = 0;
let actionSeq = 0;

export function govern(id: string, name: string, args: Record<string, unknown>): Governed {
  switch (name) {
    case "query_products":
      return governQuery(id, args);
    case "filter_view":
      return governFilter(id, args);
    case "update_price":
      return governFieldWrite(id, "update_price", "price", args);
    case "adjust_stock":
      return governFieldWrite(id, "adjust_stock", "stock", args);
    case "toggle_web_visible":
      return governFieldWrite(id, "toggle_web_visible", "webVisible", args);
    case "clear_expired_sales":
    case "discontinue_products":
      return governDestructive(id, name, args);
    default:
      return invalid(id, name, args, `Unknown tool "${name}".`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────
function governQuery(id: string, args: Record<string, unknown>): Governed {
  if (!isMetric(args.metric))
    return invalid(id, "query_products", args, `Unknown metric "${String(args.metric)}".`);
  const { rows, phrase } = resolveMetric(args.metric);
  const targetIds = rows.map((p) => p.sku);
  const revealMargin = args.metric === "negative_margin";
  const effect: ViewEffect = revealMargin
    ? { reveal: ["margin"], margins: marginsFor(rows), filter: { skus: targetIds } }
    : {};
  return {
    kind: "safe",
    event: mk(id, "query_products", "safe", "ok", `${rows.length} ${phrase}.`, args, targetIds),
    effect,
    toolResult: JSON.stringify({ count: rows.length, metric: args.metric, skus: targetIds }),
  };
}

function governFilter(id: string, args: Record<string, unknown>): Governed {
  const filter = args.filter;
  const revealMargin = args.reveal_margin === true;
  if (filter === "none") {
    return {
      kind: "safe",
      event: mk(id, "filter_view", "safe", "ok", "Cleared the filter — showing all 30 products.", args, []),
      effect: { filter: { skus: null }, ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(allProducts()) } : {}) },
      toolResult: JSON.stringify({ filtered: "none", count: 30 }),
    };
  }
  if (!isMetric(filter))
    return invalid(id, "filter_view", args, `Unknown filter "${String(filter)}".`);
  const { rows, phrase } = resolveMetric(filter);
  const targetIds = rows.map((p) => p.sku);
  return {
    kind: "safe",
    event: mk(id, "filter_view", "safe", "ok", `Filtered to ${rows.length} ${phrase}${revealMargin ? ", Margin revealed" : ""}.`, args, targetIds),
    effect: { filter: { skus: targetIds }, ...(revealMargin ? { reveal: ["margin"], margins: marginsFor(rows) } : {}) },
    toolResult: JSON.stringify({ filtered: filter, count: rows.length, skus: targetIds }),
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
  const parsed = writeValue(tool, args, rows.length === 1 ? rows[0] : undefined);
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
      effect: { mutations: [fieldMutation(p.sku, field, value)] },
      toolResult: JSON.stringify({ ok: true, sku: p.sku, field, from, to: value }),
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
): { event: ToolEvent; effect: ViewEffect; toolResult: string } {
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
    effect: { mutations, filter: { skus: null } },
    toolResult: JSON.stringify({ approved: allowed.length, excluded: excluded.length, skus: allowed }),
  };
}

function replanFieldBatch(tool: string, args: Record<string, unknown>): Plan {
  const field: WriteField = tool === "update_price" ? "price" : tool === "adjust_stock" ? "stock" : "webVisible";
  const { rows } = resolveTargets(args);
  const parsed = writeValue(tool, args, undefined);
  const value = "value" in parsed ? parsed.value : field === "webVisible" ? false : 0;
  return planFieldBatch(tool, field, value, rows);
}

// ── Undo (human-only, still server-resolved) ────────────────────────────────
export function executeUndo(
  callId: string,
  spec: UndoSpec,
  force: boolean,
):
  | { kind: "undone"; event: ToolEvent; effect: ViewEffect; toolResult: string }
  | { kind: "stale"; field: string; expected: number | boolean; actual: number | boolean } {
  const current = getField(spec.sku, spec.field);
  if (current === undefined)
    return { kind: "undone", event: mk(callId, spec.tool, "safe", "undone", "Nothing to undo — the product is gone.", {}, []), effect: {}, toolResult: "{}" };

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
    effect: { mutations: [fieldMutation(spec.sku, spec.field, spec.from)] },
    toolResult: JSON.stringify({ undone: true, sku: spec.sku, field: spec.field, restoredTo: spec.from }),
  };
}

// ── value + formatting helpers ──────────────────────────────────────────────
function writeValue(
  tool: string,
  args: Record<string, unknown>,
  single: Product | undefined,
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
  // toggle_web_visible: single with no explicit value → flip; batch → the value.
  if (typeof args.visible === "boolean") return { value: args.visible };
  if (args.visible === "true") return { value: true };
  if (args.visible === "false") return { value: false };
  if (single) return { value: !single.webVisible };
  return { value: false }; // batch hide by default
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
    toolResult: JSON.stringify({ error: reason }),
  };
}
