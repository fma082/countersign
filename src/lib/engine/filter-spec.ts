/**
 * The filter vocabulary — the one place a filter criterion is DESCRIBED.
 *
 * Split from `filter.ts` along a seam that matters:
 *
 *   filter-spec.ts   what a criterion MEANS      pure. no catalog, no I/O.
 *   filter.ts        what a criterion SELECTS    predicates over the catalog.
 *
 * The split is not tidiness. The filter bar has to print the criterion the
 * human applied, and the bar is a client component — so if the descriptions
 * lived next to the predicates, importing a label would pull `catalog.ts` into
 * the browser bundle, and `catalog.ts` re-exports `PRODUCTS`, which carries
 * `cost`. The rule that `cost` never reaches the client is enforced by
 * `toPublic` at the payload boundary; this file keeps a second path from
 * opening behind it.
 *
 * Both halves are keyed by the same unions (`Record<FilterPreset, …>`), so
 * adding a preset that one half knows about and the other does not is a
 * compile error, not a drift.
 *
 * `describeFilter` is the function referred to everywhere else as "the label
 * function". Three consumers, one string:
 *
 *   - the applied-filter chip in the table's filter bar,
 *   - the "N of 30" readout beside it,
 *   - the `Current view:` line injected into the model's prompt each turn.
 *
 * A human reading the chip and a model reading its prompt are looking at the
 * same sentence about the same table. That is the point. The moment those are
 * two functions, one of them starts describing a view that isn't on screen —
 * which is the exact failure (`criterionLabel`) this codebase already closed
 * once on the read path.
 */

import type {
  ColumnKey,
  CompareField,
  CompareOp,
  FilterPreset,
  FilterState,
  MeasureKind,
  ResolvedFilter,
} from "./types";

/** The empty criterion. A value, not a description — safe to write anywhere. */
export const NO_FILTER: FilterState = { kind: "none" };

export const money = (n: number): string => `$${n.toFixed(2)}`;

// ── Presets ────────────────────────────────────────────────────────────────
/**
 * A preset is a predicate that CANNOT be written as "field · operator · value",
 * which is precisely why it needs a name of its own.
 *
 * `expressibleAs` records why, and it is documentation with a job: it is the
 * test for whether something belongs here or in the comparison control. A
 * predicate comparing two fields (`stock < reorderPoint`) has no constant to
 * put in the value box. A compound one (`salePrice !== null && !expired`) is
 * two predicates. A predicate whose constant is the SERVER'S clock, not the
 * human's number, has nothing for them to type.
 *
 * `active` and `discontinued` are the two that ARE expressible — as a
 * comparison over an enum. They stay chips anyway: the comparison control takes
 * a free NUMBER, so admitting them would mean a third closed enum for the
 * value, i.e. a different control. For a two-valued axis a chip is also simply
 * better than three dropdowns.
 */
interface PresetSpec {
  /** The criterion in the server's own words. The only wording there is. */
  phrase: string;
  /** Short form for the chip. The bar has no room for the full phrase. */
  chip: string;
  /** What a row of this criterion measures, in a rendered list. */
  measure: MeasureKind;
  /** Why this is a preset and not a comparison. */
  expressibleAs: "field-vs-field" | "compound" | "server-constant" | "enum-shortcut";
  /**
   * Columns the table must show while this criterion is active, because the
   * criterion selected its rows on a dimension the table does not show by
   * default. Six rows that share an invisible property look arbitrary.
   *
   * This is the whole reveal rule, and it is a property of the criterion — so
   * only a criterion ABOUT margin can put margin on screen, and no sequence of
   * other filters can accumulate its way there.
   */
  reveal?: ColumnKey[];
}

export const PRESET_SPEC: Record<FilterPreset, PresetSpec> = {
  below_reorder: {
    phrase: "products below their reorder point",
    chip: "below reorder",
    measure: "ratio",
    expressibleAs: "field-vs-field", // stock < reorderPoint
  },
  negative_margin: {
    phrase: "products selling below cost",
    chip: "negative margin",
    measure: "magnitude",
    expressibleAs: "field-vs-field", // effectivePrice < cost, and cost is server-only
    reveal: ["margin"],
  },
  expired_sale: {
    phrase: "products still on an expired sale price",
    chip: "expired sale",
    measure: "recency",
    expressibleAs: "server-constant", // saleEnds < today, and today is ours
    // The date is the reason these rows are here. Without it the table shows
    // six ordinary products and the human has to take the label's word for it.
    reveal: ["saleEnds"],
  },
  on_sale: {
    phrase: "products on a sale that has not expired",
    chip: "on sale",
    measure: "none",
    expressibleAs: "compound", // salePrice !== null AND not expired
    // Same axis, same column — and here it also exposes the sale with no end
    // date at all, which is the one row this catalog cannot reason about.
    reveal: ["saleEnds"],
  },
  hidden: {
    phrase: "products hidden from the web store",
    chip: "hidden",
    measure: "none",
    expressibleAs: "compound", // active AND !webVisible
  },
  active: {
    phrase: "products with active status",
    chip: "active",
    measure: "none",
    expressibleAs: "enum-shortcut",
  },
  discontinued: {
    phrase: "products that are discontinued",
    chip: "discontinued",
    measure: "none",
    expressibleAs: "enum-shortcut",
  },
};

/** Chip order in the bar, and the enum order the model is shown. */
export const FILTER_PRESETS = Object.keys(PRESET_SPEC) as FilterPreset[];

// ── The free comparison ────────────────────────────────────────────────────
interface FieldSpec {
  /** How the field reads inside a label: "products with <noun> below 50". */
  noun: string;
  /** The dropdown's label. */
  chip: string;
  format: (n: number) => string;
  measure: MeasureKind;
}

export const FIELD_SPEC: Record<CompareField, FieldSpec> = {
  stock: {
    noun: "stock",
    chip: "stock",
    format: String,
    // The value against the number it was compared to — the same measure
    // `stock_below` produced, now generalised to every operator.
    measure: "ratio",
  },
  effective_price: {
    noun: "an effective price",
    chip: "price",
    format: money,
    // NOTHING measured, deliberately. `magnitude` appends its unit after the
    // number, so a price would render "44.90$"; dropping the unit would render
    // a bare "44.9" — a quantity without its unit, which is the failure
    // `productDetail` exists to prevent (a 28.9% margin narrated as "$28.90").
    // The prices are in the table, already filtered and already formatted. The
    // list does not restate them badly.
    measure: "none",
  },
};

export const COMPARE_FIELDS = Object.keys(FIELD_SPEC) as CompareField[];

interface OpSpec {
  /** How the operator reads inside a label. */
  phrase: string;
  /** How the operator is PAINTED. The model never sees this. */
  symbol: string;
}

export const OP_SPEC: Record<CompareOp, OpSpec> = {
  lt: { phrase: "below", symbol: "<" },
  lte: { phrase: "at or below", symbol: "≤" },
  gt: { phrase: "above", symbol: ">" },
  gte: { phrase: "at or above", symbol: "≥" },
  eq: { phrase: "of exactly", symbol: "=" },
};

export const COMPARE_OPS = Object.keys(OP_SPEC) as CompareOp[];

// ── The label function ─────────────────────────────────────────────────────
/**
 * THE one description of a criterion. Chip, readout and model prompt all print
 * what this returns. See the header.
 */
export function describeFilter(state: FilterState): string {
  switch (state.kind) {
    case "none":
      return "products in the catalog, unfiltered";
    case "preset":
      return PRESET_SPEC[state.preset].phrase;
    case "compare": {
      const field = FIELD_SPEC[state.field];
      return `products with ${field.noun} ${OP_SPEC[state.op].phrase} ${field.format(state.value)}`;
    }
  }
}

/**
 * The columns this criterion needs on screen — the WHOLE set, not a delta.
 *
 * A comparison reveals nothing: both fields it can address (`stock`,
 * `effective_price`) are already columns, so the reason a row was selected is
 * visible without help.
 */
export function filterReveal(state: FilterState): ColumnKey[] {
  return state.kind === "preset" ? (PRESET_SPEC[state.preset].reveal ?? []) : [];
}

/** What a row of this criterion measures. A property of the criterion. */
export function filterMeasure(state: FilterState): MeasureKind {
  switch (state.kind) {
    case "none":
      return "none";
    case "preset":
      return PRESET_SPEC[state.preset].measure;
    case "compare":
      return FIELD_SPEC[state.field].measure;
  }
}

/** A compact token for the model's tool result — the criterion, not the rows. */
export function filterToken(state: FilterState): string {
  switch (state.kind) {
    case "none":
      return "none";
    case "preset":
      return state.preset;
    case "compare":
      return `${state.field} ${state.op} ${state.value}`;
  }
}

/**
 * The line the model is handed at the top of every turn — the answer to R07.
 *
 * The model used to have no way at all to know what the table was showing. The
 * filter lived in a `useState` in the browser and the tool results that
 * produced it were discarded with the turn, so on the turn AFTER filtering, the
 * model was asked about a view it had itself created and had nothing to read.
 * It denied the filter existed. That was the only honest answer available to it.
 *
 * This line is built from the same `FilterState` and the same `describeFilter`
 * that draw the chip, so the sentence in the prompt and the sentence on screen
 * are one string with two readers.
 */
export function currentViewLine(filter: ResolvedFilter, total: number): string {
  return filter.skus === null
    ? `Current view: unfiltered — all ${total} rows.`
    : `Current view: the table is filtered to ${filter.label} (${filter.count} of ${total} rows). The human can clear it at any time.`;
}

// ── Wire parsing ───────────────────────────────────────────────────────────
const isPreset = (v: unknown): v is FilterPreset =>
  typeof v === "string" && v in PRESET_SPEC;
const isField = (v: unknown): v is CompareField =>
  typeof v === "string" && v in FIELD_SPEC;
const isOp = (v: unknown): v is CompareOp => typeof v === "string" && v in OP_SPEC;

/**
 * Read a `FilterState` off the wire. It arrives from the client on EVERY
 * request, so it is untrusted in the same way a tool argument is — and it is
 * read back to the model as fact, which makes a bad one worse than a bad tool
 * argument rather than better.
 *
 * Anything unrecognised degrades to NO FILTER, never to a criterion. The two
 * failure directions are not symmetric: "the table is unfiltered" understates
 * what the human sees and they can look at the screen to correct it, while a
 * criterion invented here would be the server telling the model, with its own
 * authority, that a filter it made up is on screen.
 */
export function parseFilterState(raw: unknown): FilterState {
  if (!raw || typeof raw !== "object") return NO_FILTER;
  const o = raw as Record<string, unknown>;

  if (o.kind === "preset" && isPreset(o.preset)) return { kind: "preset", preset: o.preset };

  if (o.kind === "compare" && isField(o.field) && isOp(o.op)) {
    // No string coercion here, unlike `parseArgs`. That leniency exists because
    // a MODEL writes "50" into a number field; this value is written by our own
    // client, echoing back what this server sent it. A string here means the
    // round trip is broken, and papering over it would hide that.
    const { value } = o;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return { kind: "compare", field: o.field, op: o.op, value };
  }

  return NO_FILTER;
}
