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
  allProducts,
  applyClearExpiredSales,
  applyDiscontinue,
  findProduct,
  getField,
  previewClearExpiredSales,
  REFERENCE_DATE,
  setField,
  setFieldBatch,
  type WriteField,
} from "@/lib/scenario/catalog";
import { effectivePrice, marginPct, type Product } from "@/lib/scenario/seed-products";
import {
  COMPARE_FIELDS,
  COMPARE_OPS,
  FILTER_PRESETS,
  NO_FILTER,
  filterToken,
  money,
} from "./filter-spec";
import {
  filterCriterion,
  filterEffect,
  measuredRows,
  presetPhrase,
  type Criterion,
} from "./filter";
import { subtitleIntent } from "./intent-subtitle";
import { buildProviderTools, parseArgs, toolSpecs, type ParsedArgs } from "./tool-args";
import type {
  ColumnKey,
  CompareField,
  CompareOp,
  DetailField,
  FilterPreset,
  FilterState,
  GateItem,
  GatePreview,
  ProductDetail,
  ProviderTool,
  RowMutation,
  ToolEvent,
  ToolOutcome,
  UndoSpec,
  ViewEffect,
} from "./types";

// ── Read vocabulary ─────────────────────────────────────────────────────────
/**
 * `query_products`'s metrics are the FILTER PRESETS plus `all`, and that is the
 * whole list — the same one a write selector picks from.
 *
 * They are the same list on purpose. A preset is a named group; a read metric
 * is a named group; there is no reason for the model to learn two names for
 * "products below their reorder point" depending on whether it wants to count
 * them or look at them. Sharing the list also means a preset added to the bar
 * is answerable by a count on the same day, with no second table to remember.
 *
 * There was briefly a THIRD kind here — a metric carrying its own number, so
 * that "less than 50 in stock" had a metric to land in. It could not be offered
 * as a write selector, because a selector resolves from a bare string with
 * nowhere to put a number, and a DESTRUCTIVE tool must never be handed a target
 * set that is undefined until an argument it cannot carry arrives. So the two
 * lists had to differ, and the model had two names on one axis to choose
 * between. Both problems were the same problem: a number does not belong in a
 * name. It belongs in `filter_compare`, which states its field, its operator
 * and its value as three declared arguments. Every name in this list resolves
 * to a set of rows on its own, so reads and writes share one vocabulary and a
 * selector cannot arrive half-specified.
 *
 * Read metrics live on distinct AXES, and keeping the names axis-explicit stops
 * a small model from crossing them ("active products" is a STATUS, not a sale).
 * The axis grouping is in the system prompt's vocabulary block.
 */
type Metric = FilterPreset | "all";

const METRICS: readonly Metric[] = [...FILTER_PRESETS, "all"];
const isMetric = (v: unknown): v is Metric =>
  typeof v === "string" && (METRICS as readonly string[]).includes(v);

const ALL_PHRASE = "products in the catalog";

/**
 * The metric vocabulary in the server's own words — what the system prompt
 * shows the model. The preset entries come from `PRESET_SPEC`, so the phrase
 * the model is told a metric MEANS and the phrase it is handed back after
 * running it are the same string by construction rather than by two people
 * remembering to match.
 *
 * They were not, once: the prompt's only mapping from "selling below cost" to
 * `negative_margin` lived inside an unrelated formatting example, and editing
 * that example silently sent the metric routing somewhere else.
 */
export const METRIC_PHRASE: Record<Metric, string> = {
  ...(Object.fromEntries(FILTER_PRESETS.map((p) => [p, presetPhrase(p)])) as Record<
    FilterPreset,
    string
  >),
  all: ALL_PHRASE,
};

/**
 * A metric, as a criterion: its rows, its wording and what its rows measure.
 *
 * Every preset routes through `filterCriterion` — the SAME assembly the filter
 * bar and the filter tools use — so a count and a filter over one name can
 * never disagree about what that name selects or how its rows are measured.
 * Only `all`, which has no preset, is built here.
 */
function metricCriterion(metric: Metric): Criterion {
  if (metric === "all") return { rows: allProducts(), label: ALL_PHRASE, measure: "none" };
  return filterCriterion({ kind: "preset", preset: metric });
}

/** Every metric resolves from its bare name, so every metric is a selector. */
function resolveSelector(where: string): { rows: Product[]; phrase: string } | null {
  if (!isMetric(where)) return null;
  const c = metricCriterion(where);
  return { rows: c.rows, phrase: c.label };
}

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

// ── Provider tool schemas ──────────────────────────────────────────────────
/**
 * The specs, and the schemas generated from them. `TOOL_SPECS` is the single
 * declaration: what the model is shown and what the server enforces are two
 * views of this one object, so a schema cannot promise a contract the parser
 * does not keep. See `tool-args.ts`.
 */
export const TOOL_SPECS = toolSpecs(METRICS, FILTER_PRESETS, COMPARE_FIELDS, COMPARE_OPS);
export const TOOLS: ProviderTool[] = buildProviderTools(TOOL_SPECS);

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

/**
 * THE EDGE. Every tool call the model makes enters here and nowhere else, so
 * this is where raw arguments stop being raw.
 *
 * `parseArgs` runs BEFORE the dispatch, and no tool body ever sees a
 * `Record<string, unknown>` again. A body cannot re-derive a type, cannot
 * accept an argument its tool never declared, and cannot fall back to a default
 * for something that failed to parse — the value is either well-formed or the
 * call never reached the body.
 *
 * The refusal keeps the RAW arguments in its event, deliberately. The badge
 * says `invalid` and the disclosure shows what the model actually sent, not a
 * cleaned-up version of it: the record is of the call that was made.
 *
 * `turnMessage` is the human's message that triggered THIS turn, passed down by
 * the route. It is the only source of the read subtitle: the model has no say
 * in it and no argument to carry it in. See `cleanIntent`.
 */
export function govern(
  id: string,
  name: string,
  rawArgs: Record<string, unknown>,
  turnMessage?: string,
): Governed {
  const parsed = parseArgs(name, TOOL_SPECS, rawArgs);
  if ("error" in parsed) return invalid(id, name, rawArgs, parsed.error);
  const args = parsed.args;

  switch (name) {
    case "query_products":
      return governQuery(id, args, turnMessage);
    case "inspect_product":
      return governInspect(id, args);
    case "filter_view":
    case "filter_compare":
      return governFilter(id, name, args);
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
      // Unreachable: `parseArgs` refuses a name with no spec. Kept so adding a
      // spec without a case here is a compile-time hole, not a silent one.
      return invalid(id, name, rawArgs, `Unknown tool "${name}".`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────
/** How much of the human's message the subtitle will quote. */
const INTENT_MAX = 120;

/**
 * The human's phrasing, tidied for display. `raw` is the message that triggered
 * THIS turn, handed down by the route — not a tool argument.
 *
 * It used to be a tool argument, and the model dragged a previous turn's
 * question into the current one: an `expired_sale` render captioned
 * `interpreted from: "products selling below cost"`, which is a question the
 * human had asked one turn earlier and was not asking now. The subtitle exists
 * to mark the gap between what was asked and what was run; filled with the
 * wrong sentence it attributes to the human a question they never asked, which
 * is worse than having no subtitle at all. A mark of transparency that lies is
 * not a weaker guarantee — it is a false one.
 *
 * Asking the model to stop dragging it would be the same class of fix this
 * project argues against everywhere else. The server has the turn's message, so
 * the server takes it from there and the argument is gone from the schema.
 *
 * An over-long message is cut at a word boundary and ELLIPSED. A silent
 * truncation would put a sentence in quotation marks that the human did not
 * finish saying — a smaller version of the same lie.
 */
function cleanIntent(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= INTENT_MAX) return text;
  const cut = text.slice(0, INTENT_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}…`;
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
 *
 * The subtitle's TEXT is the turn's own message, never `args` — the model does
 * not choose which question gets attributed to the human.
 */
function governQuery(id: string, args: ParsedArgs, turnMessage?: string): Governed {
  if (!isMetric(args.metric))
    return invalid(id, "query_products", args, `Unknown metric "${String(args.metric)}".`);
  const read = metricCriterion(args.metric);
  const { rows, label: phrase } = read;
  const targetIds = rows.map((p) => p.sku);
  // A margin question narrows the table to the rows it is about, and it does so
  // by setting the `negative_margin` FilterState — the same criterion the bar's
  // chip sets, which is also what reveals the Margin column. One fact decides
  // the rows, the label, the chip and the column, and the human can clear all
  // four with the one ✕ in the bar.
  const effect: ViewEffect =
    args.metric === "negative_margin"
      ? filterEffect({ kind: "preset", preset: "negative_margin" })
      : {};
  // Kept only if it differs from what we ran. A subtitle that repeats the
  // header teaches the human to stop reading the subtitle.
  const userIntent = subtitleIntent(cleanIntent(turnMessage), phrase);
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
      // The public product objects (cost stripped by `toPublic`), each carrying
      // the measure this criterion produced and already in the order this
      // criterion ranks them by. The client renders the list it is handed: it
      // computes no ratio, chooses no bar and re-sorts nothing.
      // `userIntent` rides here too: it is the component's subtitle, and the
      // client is its only reader.
      renderPayload: {
        component: "product_list",
        count: rows.length,
        criterionLabel: phrase,
        data: measuredRows(read),
        ...(userIntent ? { userIntent } : {}),
      },
    },
  };
}

// ── The single-product record ──────────────────────────────────────────────
const field = (key: string, label: string, value: string): DetailField => ({
  key,
  label,
  state: "present",
  value,
});
const notApplicable = (key: string, label: string): DetailField => ({ key, label, state: "not-applicable" });
const missing = (key: string, label: string): DetailField => ({ key, label, state: "missing" });

/**
 * One product's record, each field CLASSIFIED, each value already formatted.
 *
 * Both decisions belong here rather than in the component, for the same reason:
 * the component cannot make them correctly. It cannot tell "this product has no
 * sale" from "this product's sale price did not arrive" — both are the absence
 * of a number — and it cannot know that `28.9` is a percentage rather than an
 * amount of money. That second one is not hypothetical: the model, handed the
 * bare number, reported a 28.9% margin as "$28.90". A consumer that receives a
 * quantity without its unit will eventually pick the wrong one.
 *
 * So `margin` leaves here as the string "28.9%" and never as 28.9. See
 * `FieldState` for the two-kinds-of-absent rule this table applies.
 *
 * Every `not-applicable` field is still SHIPPED, not dropped. The frame is the
 * record of what the server decided about each field, and "decided this one
 * does not apply" is a decision. The component drops the row; the payload keeps
 * the reasoning.
 */
function productDetail(p: Product): ProductDetail {
  const onSale = p.salePrice !== null;
  const m = marginPct(p);

  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    status: p.status,
    fields: [
      field("price", "Price", money(p.price)),

      // NOT-APPLICABLE, not missing: a product without a sale is not a product
      // whose sale price went astray. There is nothing to report, so the row
      // does not exist — 23 of the 30 products in this catalog are in this case,
      // and a dash on each would be 23 invented gaps.
      onSale ? field("salePrice", "Sale price", money(p.salePrice as number)) : notApplicable("salePrice", "Sale price"),

      // The end date follows the sale's existence, then splits: with a sale but
      // no date, the field APPLIES and is absent — a real `missing`, and the one
      // this catalog's shape allows.
      !onSale
        ? notApplicable("saleEnds", "Sale ends")
        : p.saleEnds
          ? field("saleEnds", "Sale ends", p.saleEnds)
          : missing("saleEnds", "Sale ends"),

      // Margin is derived from cost, so it exists whenever cost and an
      // effective price do. When it cannot be computed it is MISSING, never a
      // zero and never omitted: the row stays and says the number is not
      // available, because a margin the human silently does not see is the same
      // as a margin they assume is fine.
      Number.isFinite(m) ? field("margin", "Margin", `${Math.round(m * 10) / 10}%`) : missing("margin", "Margin"),

      field("stock", "Stock / reorder", `${p.stock} / ${p.reorderPoint}`),
      field("status", "Status", p.status),
      field("webVisible", "Web store", p.webVisible ? "yes" : "no"),
      field("lastUpdated", "Last updated", p.lastUpdated),
    ],
  };
}

/**
 * Read a single product by sku. Safe — runs on its own.
 *
 * Split across the same two channels as `governQuery`, and for a sharper
 * version of the same reason. This tool used to hand the model eleven raw
 * fields and ask it to narrate them; it narrated `margin: 28.9` as "$28.90" —
 * a percentage restated as an amount of money, about the one number in this
 * system the human is least able to check. Nothing in the prose said which it
 * was, and there was no second surface to contradict it.
 *
 * Now the record goes to the client, already formatted and already classified,
 * and the model gets the product's IDENTITY and nothing to quantify. It cannot
 * misreport a margin it was not given. If it invents one anyway, the correct
 * value is on screen beside the sentence — the failure becomes visible instead
 * of authoritative.
 *
 * Margin reaches the client only here and in a margin-revealing filter,
 * deliberately. `cost` still never leaves the server: what ships is the
 * percentage, not the number it was derived from.
 */
function governInspect(id: string, args: ParsedArgs): Governed {
  const sku = typeof args.sku === "string" ? args.sku : "";
  const p = sku ? findProduct(sku) : undefined;
  if (!p)
    return invalid(id, "inspect_product", args, sku ? `No product with SKU "${sku}".` : "Pass a sku to inspect.");

  const detail = productDetail(p);
  return {
    kind: "safe",
    // The tool card stays a log line: what ran, on what. The record itself is
    // the card below it, so the summary does not restate the numbers.
    event: mk(id, "inspect_product", "safe", "ok", `${p.name} (${p.sku}) — ${p.status}.`, args, [p.sku]),
    effect: {},
    outcome: {
      // Identity only. No price, no stock, no margin — the model has nothing to
      // convert into the wrong unit, and `rendered` tells it the record is
      // already on screen so it writes context rather than a list.
      modelPayload: { sku: p.sku, name: p.name, status: p.status, rendered: true },
      renderPayload: {
        component: "product_detail",
        count: 1,
        criterionLabel: `the stored record for ${p.sku}`,
        data: detail,
      },
    },
  };
}

/**
 * The two filter tools, governed as one — because they set ONE thing.
 *
 * `filter_view` names a group; `filter_compare` states a threshold. They differ
 * only in how the `FilterState` is spelled, and after that line they are the
 * same operation: resolve the criterion, ship the effect, hand the model a
 * count and a label. There is no second code path for the model, and no code
 * path here at all that the human's own filter bar does not also take — the bar
 * posts a `FilterState` and the server runs `filterEffect` over it, exactly as
 * this does. Neither party has a channel the other lacks.
 *
 * The label ships and the SKUs do not. This tool used to return
 * `{ filtered, count, skus }`: a raw enum token, a number, and thirteen SKUs.
 * The model had to turn `below_reorder` into English on its own, and with no
 * wording to copy it reached for the nearest phrasing it had — the example in
 * the system prompt — and answered "13 products are selling below cost" over a
 * run of `below_reorder`.
 */
// No `turnMessage`, and nothing to do with one. The read subtitle
// ("interpreted from: …") belongs to a rendered list, attributing a set of rows
// to the sentence that produced them. A filter renders no list — the table is
// the answer, and it carries the criterion in the bar's chip, which is the
// server's own wording rather than a quote of the human.
function governFilter(id: string, tool: string, args: ParsedArgs): Governed {
  const state = filterStateFrom(tool, args);
  const effect = filterEffect(state);
  const resolved = effect.filter!;
  const cleared = state.kind === "none";

  const columns = resolved.reveal.length ? `, ${resolved.reveal.map(columnLabel).join(" + ")} revealed` : "";
  const summary = cleared
    ? `Cleared the filter — showing all ${resolved.count} products.`
    : `Filtered to ${resolved.count} ${resolved.label}${columns}.`;

  return {
    kind: "safe",
    event: mk(id, tool, "safe", "ok", summary, args, resolved.skus ?? []),
    effect,
    // NO renderPayload. Filtering changes the table, and the filtered table is
    // the answer — listing the same rows again in the copilot panel would put
    // one question on two surfaces that can then disagree, which is the failure
    // the single render slot was built to prevent, one level up.
    //
    // The panel used to be where a filter's extra dimension went: `expired_sale`
    // shipped a list carrying each sale's end date, a fact with no column in the
    // table. That is now a REVEALED COLUMN instead (`ResolvedFilter.reveal`), so
    // the rows and the reason they were selected sit together, and nothing has
    // to be read off a second surface to make sense of the first.
    //
    // `query_products` still renders. Asking and filtering are different
    // intents: one answers in the panel, one changes the table.
    outcome: modelOnly({
      count: resolved.count,
      criterion: filterToken(state),
      criterionLabel: resolved.label,
      // The table below IS the render, so the model still writes context rather
      // than a list.
      rendered: true,
    }),
  };
}

/** A revealed column's name, for the tool card's summary line. */
const columnLabel = (c: ColumnKey): string => (c === "margin" ? "Margin" : "Sale ends");

/**
 * The tool's arguments as a `FilterState`.
 *
 * No validation and no refusal branch, deliberately: `parseArgs` has already
 * run against the spec, so `preset` is a member of its enum, `field` and `op`
 * are members of theirs, and `value` is a number at or above zero. There is
 * nothing left for this function to reject — which is the point of validating
 * at the edge instead of in eight tool bodies.
 */
function filterStateFrom(tool: string, args: ParsedArgs): FilterState {
  if (tool === "filter_compare")
    return {
      kind: "compare",
      field: args.field as CompareField,
      op: args.op as CompareOp,
      value: args.value as number,
    };
  return args.preset === "none"
    ? NO_FILTER
    : { kind: "preset", preset: args.preset as FilterPreset };
}

// ── Reversible field writes (radius decides the tier) ─────────────────────
/**
 * WHO a write touches. The one question a write must never get wrong, so it
 * fails on ambiguity instead of resolving through it.
 *
 * This used to degrade: a `sku` that did not resolve fell through to `where`
 * and the write executed on the SELECTOR's rows instead. With `on_sale`
 * matching exactly one product in this catalog, that was a radius-1 write —
 * immediate, ungated, badged `ok`, on a product the model had not named. A
 * mistyped SKU did not produce an error; it produced a change somewhere else.
 *
 * Two rules now:
 *   - A `sku` that does not resolve is an ERROR. Always. There is no second
 *     target to fall back to, because a fallback target is a guess.
 *   - A real `sku` AND a `where` together is a REFUSAL. They are two different
 *     answers to "which products", and picking one by precedence is the server
 *     deciding what the model meant. Cheaper to ask again.
 *
 * The placeholder guard stays: a model filling an unused `sku` with "none" or
 * "all" is a shape slip, not a second target, so it is read as absent — the
 * same stance `set_web_visible` takes on a missing direction.
 */
function resolveTargets(args: ParsedArgs): { rows: Product[]; error?: string } {
  const skuRaw = typeof args.sku === "string" ? args.sku : "";
  const where = typeof args.where === "string" ? args.where : "";
  const sku = skuRaw && !["none", "all", "null", "any"].includes(skuRaw.toLowerCase()) ? skuRaw : "";

  if (sku && where)
    return {
      rows: [],
      error: `Two targets: sku "${sku}" and where "${where}". Pass one — refusing to guess which set you meant.`,
    };

  if (sku) {
    const p = findProduct(sku);
    return p ? { rows: [p] } : { rows: [], error: `No product with SKU "${sku}".` };
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
  args: ParsedArgs,
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
function governDestructive(id: string, tool: string, args: ParsedArgs): Governed {
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
      "Removes the sale price from products whose sale has ended, reverting each to its regular price. Sales that have not ended are left untouched — including one with no end date on record, which this sweep cannot evaluate at all.",
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

function planDiscontinue(args: ParsedArgs): Plan | { error: string } {
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
  args: ParsedArgs,
  plan: Plan,
  pendingSummary: string,
): Governed {
  // `targetIds` is the whole of what the client needs to open a gate: the rows
  // to spotlight. The view it suspends to show them is the client's own doing
  // and is undone from the approval — there is no pre-computed effect here,
  // because a gate's real effect does not exist until `executeGate` resolves it
  // against the exclusions. A field describing what "will" run, resolved before
  // the human has decided anything, could only be a guess dressed as a promise.
  const gate: GatePreview = {
    id: `gate_${++gateSeq}`,
    tool,
    title: plan.title,
    description: plan.description,
    targetIds: plan.targetIds,
    items: plan.items,
  };
  return {
    kind: "gate",
    event: mk(id, tool, "gate", "pending", pendingSummary, args, plan.targetIds),
    gate,
  };
}

/**
 * Re-plan for a stored gate, intersect with the human's exclusions, execute.
 *
 * The stored `args` are the model's RAW arguments, so they are re-parsed here
 * rather than trusted: approval is a second execution point, and an execution
 * point that skipped the edge would be a way around it. The parse is
 * deterministic, so a gate that was offered still approves — but the path
 * cannot be entered with anything the edge would have refused.
 *
 * A refusal REFUSES. It used to be impossible for the re-plan to fail (govern
 * validates before storing the gate), and the code said so by defaulting a
 * failed value to `0` — which, had it ever been reachable, would have set the
 * price of every approved product to zero, silently, on the human's own click.
 * "Can't happen" is not a reason to write the dangerous branch.
 */
export function executeGate(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  excludedIds: string[],
):
  | { kind: "ran"; event: ToolEvent; effect: ViewEffect; outcome: ToolOutcome }
  | { kind: "refused"; event: ToolEvent } {
  const parsedArgs = parseArgs(tool, TOOL_SPECS, args);
  if ("error" in parsedArgs)
    return {
      kind: "refused",
      event: mk(callId, tool, "invalid", "invalid", parsedArgs.error, args, []),
    };

  const plan =
    tool === "clear_expired_sales"
      ? planClear()
      : tool === "discontinue_products"
        ? planDiscontinue(parsedArgs.args)
        : replanFieldBatch(tool, parsedArgs.args);

  // `planDiscontinue` and `replanFieldBatch` both carry a real error branch.
  // The union is honoured instead of cast away.
  if ("error" in plan)
    return {
      kind: "refused",
      event: mk(callId, tool, "invalid", "invalid", plan.error, args, []),
    };

  // The client can only SHRINK the server's own preview. An excluded ID that
  // was never in the preview is meaningless and dropped.
  const preview = new Set(plan.targetIds);
  const excluded = excludedIds.filter((eid) => preview.has(eid));
  const excludedSet = new Set(excluded);
  const allowed = plan.targetIds.filter((sku) => !excludedSet.has(sku));

  const { mutations, okSummary } = plan.execute(allowed);
  const suffix = excluded.length ? ` ${excluded.length} excluded by you.` : "";
  return {
    kind: "ran",
    event: {
      ...mk(callId, tool, "gate", "ok", okSummary + suffix, parsedArgs.args, allowed),
      excluded,
    },
    effect: { mutations, margins: marginPatch(allowed) },
    outcome: modelOnly({ approved: allowed.length, excluded: excluded.length, skus: allowed }),
  };
}

function replanFieldBatch(tool: string, args: ParsedArgs): Plan | { error: string } {
  const field: WriteField = tool === "update_price" ? "price" : tool === "adjust_stock" ? "stock" : "webVisible";
  const { rows, error } = resolveTargets(args);
  if (error) return { error };
  const parsed = writeValue(tool, args);
  if ("error" in parsed) return parsed;
  return planFieldBatch(tool, field, parsed.value, rows);
}

// ── Undo (human-only, still server-resolved) ────────────────────────────────
/**
 * The undo spec, validated before it can touch anything.
 *
 * `body.undo` arrives from the client and was cast straight to `UndoSpec` — a
 * compile-time claim about a runtime value, which is the same mistake as
 * trusting a tool schema. It was the least guarded write in the system: `field`
 * is typed to three names but nothing checked it, and `setField`'s ternary
 * sends anything unrecognised to the `webVisible` branch, so an unknown field
 * wrote `webVisible = { … }` and reported `undone`. Worse with a known field
 * and a bad value: `{ field: "price", from: "free" }` assigned the string into
 * the catalog and only THEN threw formatting the summary — the mutation landed,
 * and the human was shown a generic engine failure that named nothing.
 *
 * So the value is checked against the field it claims to restore, before any
 * write. An undo is the one operation whose whole promise is putting things
 * back; it cannot be the way something breaks.
 */
export function parseUndo(raw: unknown): UndoSpec | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Nothing to undo." };
  const u = raw as Record<string, unknown>;

  const sku = typeof u.sku === "string" ? u.sku.trim() : "";
  const product = sku ? findProduct(sku) : undefined;
  if (!product) return { error: `Cannot undo — no product with SKU "${sku}".` };

  const field = u.field;
  if (field !== "price" && field !== "stock" && field !== "webVisible")
    return { error: `Cannot undo — "${String(field)}" is not a writable field.` };

  // The value must fit the field, both for the restore and for the staleness
  // check that compares `to` against what is on the record now.
  const fits = (v: unknown): boolean =>
    field === "webVisible"
      ? typeof v === "boolean"
      : typeof v === "number" && Number.isFinite(v) && v >= 0 && (field !== "stock" || Number.isInteger(v));
  if (!fits(u.from) || !fits(u.to))
    return { error: `Cannot undo — ${field} values must be ${field === "webVisible" ? "true or false" : "numbers"}.` };

  return {
    actionId: typeof u.actionId === "string" ? u.actionId : "",
    tool: typeof u.tool === "string" ? u.tool : "update_price",
    sku: product.sku,
    name: product.name, // from the record, not from the client
    field,
    from: u.from as number | boolean,
    to: u.to as number | boolean,
  };
}

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
/**
 * WHAT a write sets. Range and type are already settled — the spec declares
 * `price` as a number above 0 and `stock` as a whole number at or above 0, and
 * nothing that failed those reached this function. What is left is the domain
 * shaping the spec cannot express: money rounds to cents.
 *
 * `set_web_visible` keeps its refusal for the case the spec cannot see either —
 * a value that parsed as a boolean is a direction, but the ARGUMENT missing
 * entirely is the one the model kept producing, and that message is authored
 * for it (`refusal` on the spec carries the same sentence).
 */
function writeValue(
  tool: string,
  args: ParsedArgs,
): { value: number | boolean } | { error: string } {
  if (tool === "update_price") return { value: Math.round((args.price as number) * 100) / 100 };
  if (tool === "adjust_stock") return { value: args.stock as number };
  if (typeof args.visible === "boolean") return { value: args.visible };
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
  args: ParsedArgs | Record<string, unknown>,
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
