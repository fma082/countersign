/**
 * Engine types — the wire contract between the three layers.
 *
 *   provider  ──RawFrame──▶  governance (server)  ──StreamFrame──▶  client
 *
 * RawFrame is what the adapter emits: provider-shaped, ignorant of governance.
 * StreamFrame is what the client receives: already resolved, already labelled,
 * already safe to reflect. The client never re-interprets a RawFrame.
 */

// ── Provider-agnostic chat message (what we send upstream) ─────────────────
export interface ToolCall {
  /** Provider-assigned call id. OpenAI-style backends (Groq) require it so a
   *  tool result can be tied back to its call; Ollama omits it and ignores it. */
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  /** On a `role:"tool"` message — the id of the call this result answers. Groq
   *  rejects a tool message without it (400); Ollama neither needs nor reads it.
   *  Each adapter honours its own backend's contract. */
  tool_call_id?: string;
}

/**
 * A tool definition in the provider's expected shape (JSON-schema function).
 * OpenAI-compatible, which is also what Ollama's /api/chat accepts — so both
 * adapters send `TOOLS` upstream verbatim. Lives here, in the shared contract,
 * because it is not owned by any single adapter.
 */
export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Why a stream failed — drives both the server's retry decision and the client's
 * surface. The three failure modes are deliberately distinct:
 *
 *   rate_limit     — OUR per-IP throttle. Not the model; "try again in a bit".
 *   model_paused   — the model backend is transiently unavailable (out of
 *                    capacity, 5xx, a network blip). TRANSIENT: the server
 *                    retries before surfacing it, and when it does surface it is
 *                    an EXPECTED pause, not a fault — the system's guarantees
 *                    hold without the model.
 *   provider_error — a permanent provider fault (contract 400, auth). A real bug
 *                    to report, NOT capacity: never retried, shown as an error.
 *   generic        — a client-side interruption (the stream dropped).
 */
export type ErrorReason = "rate_limit" | "model_paused" | "provider_error" | "generic";

// ── Layer 1 output: raw frames from the adapter ────────────────────────────
export type RawFrame =
  | { type: "token"; text: string }
  | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | { type: "done" }
  | { type: "error"; message: string; reason?: ErrorReason };

// ── Governance vocabulary ──────────────────────────────────────────────────

/**
 * How the server decided to treat a tool call, by tier:
 *   safe       — a read. No writes, no window to close.
 *   reversible — a radius-1 write with an open window. Runs, then can be undone.
 *   gate       — a destructive write (radius N, or a window that closes on its
 *                own). Waits for human approval before it runs.
 *   invalid    — discarded for bad arguments. Never surfaces as "ok".
 */
export type ToolDecision = "safe" | "reversible" | "gate" | "invalid";

/**
 * Result badge shown on a tool card. "invalid" is first-class: a call discarded
 * for bad arguments shows "invalid", NEVER "ok". Showing "ok" over a discarded
 * call would be lying in the UI of a project whose subject is trust. "undone" is
 * the badge on the NEW entry an undo appends — never an edit of the original.
 */
export type ResultBadge = "ok" | "invalid" | "pending" | "rejected" | "error" | "undone";

/**
 * How to reverse a reversible (radius-1) write. Carried on the write's tool
 * event so the client can offer Undo. The undo still goes through server-side
 * resolution — this is what it resolves against, not a client-side rollback.
 */
export interface UndoSpec {
  actionId: string;
  tool: string;
  sku: string;
  name: string;
  field: "price" | "stock" | "webVisible";
  from: number | boolean; // the prior value to restore
  to: number | boolean; // the value the write set (for the staleness check)
}

/** Returned when an undo target has drifted since the original write. */
export interface StaleUndo {
  spec: UndoSpec;
  field: string;
  expected: number | boolean; // what the write left behind
  actual: number | boolean; // what the value is now
}

/** Columns the table hides until a tool reveals them. */
export type ColumnKey = "margin";

// ── The filter state: a CRITERION, never a resolved list ───────────────────
/**
 * WHAT THE TABLE IS FILTERED TO — and the whole design is in the fact that this
 * is a criterion rather than a list of SKUs.
 *
 * The view state used to travel as `string[] | null`: the rows the server had
 * resolved, frozen at the moment it resolved them. Three things follow from a
 * frozen list that do not follow from a criterion:
 *
 *   - It goes STALE. Approve a sweep while the table is filtered to
 *     `expired_sale` and the list still names rows whose sale is now cleared.
 *     The system dodged this by wiping the filter on every gate — that is, by
 *     destroying the human's view to avoid lying about it.
 *   - It cannot be RE-RESOLVED, so it cannot be restored after a gate, and the
 *     human's filter is gone for good.
 *   - It cannot be DESCRIBED. A list of thirteen SKUs does not know it means
 *     "below their reorder point", so nothing could tell the human what they
 *     were looking at, and nothing could tell the model either.
 *
 * A criterion survives all three: it is re-resolved on every request, it has a
 * label, and it is small enough to travel on the wire each turn.
 *
 * THE CLIENT NEVER INTERPRETS THIS VALUE. It stores whatever the server last
 * sent and hands it back on the next request, the same way it carries the
 * message history. Every predicate in it is evaluated server-side, exactly once
 * per request, by one resolver — see `filter.ts`. That is not a stylistic
 * preference: `negative_margin` is `effectivePrice < cost`, and `cost` never
 * reaches the browser, so a client-resolved filter is structurally impossible
 * for at least one of these.
 */
export type FilterPreset =
  /** stock < reorderPoint — a field against another FIELD. Irreducible. */
  | "below_reorder"
  /** effectivePrice < cost — field against field, and `cost` is server-only. */
  | "negative_margin"
  /** saleEnds !== null && saleEnds < today. */
  | "expired_sale"
  /** salePrice !== null && the sale has not expired. */
  | "on_sale"
  /** active && !webVisible. */
  | "hidden"
  | "active"
  | "discontinued";

/**
 * The fields a free comparison may address. Both are columns the human can SEE
 * in the table — that is the rule for admitting one, not an accident.
 *
 * `margin` is deliberately absent. A comparison operator with a free numeric
 * value is an ORACLE: `margin < x` over varying x is a binary search on `cost`,
 * to arbitrary precision, through a surface that never names cost once. Margin
 * stays a preset (`negative_margin`), which reveals exactly one bit — the sign.
 *
 * `price` is absent too, in favour of the effective one: the table's Price
 * column already shows `salePrice ?? price`, so a filter on the regular price
 * would select rows by a number the column does not display.
 */
export type CompareField = "stock" | "effective_price";

/**
 * Word tokens, not symbols. The model picks from this list, and a small model
 * choosing between `"<"`, `"&lt;"` and `"less than"` is a coin flip; `lt` is
 * one token with one spelling. The UI paints them `< ≤ > ≥ =` — see
 * `OP_SPEC.symbol`, which the model never sees.
 */
export type CompareOp = "lt" | "lte" | "gt" | "gte" | "eq";

export type FilterState =
  | { kind: "none" }
  | { kind: "preset"; preset: FilterPreset }
  | { kind: "compare"; field: CompareField; op: CompareOp; value: number };

/**
 * A `FilterState` after the server has run it. This is what ships on the wire:
 * the rows to show, the criterion in the server's own words, and the state
 * itself so the client can hand it back next turn.
 *
 * `label` is authored by ONE function over the state (`describeFilter`). The
 * applied-filter chip, the "N of 30" readout and the `Current view:` line the
 * model reads all print this same string. If they ever diverge, the human and
 * the model are being told two different things about one table.
 */
export interface ResolvedFilter {
  state: FilterState;
  /** SKUs to show. `null` — and only for `kind: "none"` — means show them all. */
  skus: string[] | null;
  label: string;
  count: number;
}

/** A tool event as the client should render it — nothing left to parse. */
export interface ToolEvent {
  id: string;
  name: string;
  decision: ToolDecision;
  badge: ResultBadge;
  summary: string; // label with the REAL count, computed server-side
  args: Record<string, unknown>;
  targetIds: string[]; // SKUs the UI can point at without parsing strings
  /** Present on a reversible write — the client offers Undo from this. */
  undo?: UndoSpec;
  /** Present on a partially-approved gate — the IDs the human held back. */
  excluded?: string[];
}

/**
 * What a tool hands back, split into two channels that never mix.
 *
 *   modelPayload  — serialized into the `role:"tool"` message. The model sees
 *                   ONLY this.
 *   renderPayload — streamed to the client. The model never sees it.
 *
 * Same principle as `toPublic` dropping `cost`: a consumer cannot misuse what it
 * never receives. A model handed 13 product rows enumerates them in prose and
 * mislabels the criterion; handed a count and the criterion the server actually
 * ran, it can only write the preamble. The rows still reach the human — they
 * just travel on the channel that renders them.
 */
export interface RenderPayload<T = unknown> {
  /** Which client component owns this data, e.g. "product_list". */
  component: string;
  /**
   * The server's own count of what it resolved — the SAME number the model was
   * given. Rendered as the header, so it can be read against `data.length`: if
   * the two ever disagree the component says so on screen, where a prose answer
   * quoting one number could never expose the other.
   */
  count: number;
  /** The executed criterion, in the server's wording. Never the user's. */
  criterionLabel: string;
  data: T;
  /**
   * The human's own phrasing — the component's subtitle ("interpreted from:
   * …"). Taken from the message that opened THIS turn, server-side; the model
   * neither supplies it nor has an argument to put it in, so it cannot be a
   * question from an earlier turn. See `turnMessage` and `cleanIntent`.
   *
   * It rides this channel and not the model's on purpose: fed back to the model
   * it gets narrated as the DEFINITION of the criterion, which is false. See
   * `governQuery`.
   */
  userIntent?: string;
}

export interface ToolOutcome<T = unknown> {
  modelPayload: unknown;
  renderPayload?: RenderPayload<T>;
}

/**
 * What a row in `product_list` MEASURES — resolved server-side, per row, from
 * the criterion that was executed.
 *
 * The measure is a property of the CRITERION, not of the product. A row is not
 * inherently a stock/reorder ratio; it is a ratio because `below_reorder` ran.
 * `negative_margin` returned the same products and measures a signed
 * percentage; `discontinued` measures nothing at all. The old component drew a
 * stock bar for all three, so a `negative_margin` result carried a bar against
 * a dimension its predicate never touched, and a `stock_below(50)` result drew
 * one against `reorderPoint` — a comparison nobody had run.
 *
 * So the kind travels with the data, and each kind carries ONLY the fields it
 * needs. There are no raw fields here to re-derive from: the client cannot
 * reach for `reorderPoint` when the criterion never compared against it,
 * because a `magnitude` measure does not have one.
 *
 * COLUMN COHERENCE: every row in a single render carries the same `kind`,
 * because one criterion produced them all. A discontinued product inside a
 * `below_reorder` result still gets a ratio bar — the column measures the
 * question, not each row's own biography.
 */
export type RowMeasure =
  /** A value against the reference it was compared to. The only kind with a bar. */
  | { kind: "ratio"; value: number; reference: number }
  /** A signed number that stands alone. The reference lives in the header. */
  | { kind: "magnitude"; value: number; unit: string; sign: "negative" | "positive" }
  /** A distance in time, plus the raw date it is measured from. */
  | { kind: "recency"; endedDaysAgo: number; date: string }
  /** Nothing to measure. The row collapses to identity — no bar, no reserved gap. */
  | { kind: "none" };

export type MeasureKind = RowMeasure["kind"];

/** A row shipped to the client with its measure already resolved. */
export type Measured<T> = T & { measure: RowMeasure };

/**
 * WHY a field has no value — and there are two reasons, which are not the same
 * reason and must not look the same on screen.
 *
 *   present         the field has a value.
 *   not-applicable  the field does not exist for this product. A product with
 *                   no sale has no sale price: there is no question to answer,
 *                   so the row is NOT RENDERED. Printing the label with a dash
 *                   would invent an absence — it says "this should have a value
 *                   and does not", about a field that was never going to.
 *   missing         the field applies and did not arrive. The row IS RENDERED,
 *                   and says so in words. A dash reads as the agent being
 *                   careless; "not available" reads as the system telling you
 *                   what it does not know.
 *
 * THE SERVER DECIDES WHICH. This is the same rule as everywhere else here: the
 * component cannot tell the two apart from the data, because both arrive as
 * "no value". Only the code that knows the product's shape knows whether the
 * field was ever going to have one.
 *
 * Generative UI usually collapses this into one empty state, and the collapse
 * is what makes an agent's output feel unreliable: a human cannot tell a fact
 * that does not exist from a fact the system lost.
 */
export type FieldState = "present" | "not-applicable" | "missing";

/** One label/value row of a `product_detail`, already formatted server-side. */
export interface DetailField {
  key: string;
  label: string;
  state: FieldState;
  /** Present only when `state` is "present". The client prints it verbatim. */
  value?: string;
}

/**
 * The record of ONE product, as `inspect_product` resolved it. Every value is
 * a string the server already formatted — a margin is "28.9%" here, never a
 * number for the client to unit-guess and never one for the model to narrate.
 */
export interface ProductDetail {
  sku: string;
  name: string;
  category: string;
  status: "active" | "discontinued";
  fields: DetailField[];
}

/** A row patch the client applies to the table. Only the changed fields appear. */
export interface RowMutation {
  sku: string;
  price?: number;
  salePrice?: number | null;
  saleEnds?: string | null;
  stock?: number;
  webVisible?: boolean;
  status?: "active" | "discontinued";
  lastUpdated?: string;
}

export interface ViewEffect {
  /**
   * Set the view's filter. Carries the resolved rows AND the criterion that
   * produced them, so the client can render the table, label the chip, and hand
   * the state back on the next request without ever evaluating a predicate.
   * Absent = leave the filter as it is.
   */
  filter?: ResolvedFilter;
  /** Columns to reveal (additive). */
  reveal?: ColumnKey[];
  /** Margin values by SKU — the only channel by which margin reaches the client. */
  margins?: Record<string, number>;
  /** Row changes applied after an approved destructive op. */
  mutations?: RowMutation[];
}

/** The human approves exactly this — resolved server-side, by name. */
export interface GateItem {
  sku: string;
  name: string;
  detail: string; // e.g. "$44.90 → $64.00"
  warn: boolean; // was selling below cost while the sale ran
}

export interface GatePreview {
  id: string;
  tool: string;
  title: string; // "Clear 6 expired sale prices"
  description: string;
  targetIds: string[]; // rows to spotlight while the human decides
  items: GateItem[];
  /** What WILL run on approve. The human approves what the server will execute. */
  effect: ViewEffect;
}

// ── Layer 2 output: frames the client receives ─────────────────────────────
export type StreamFrame =
  | { type: "token"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "effect"; effect: ViewEffect }
  /**
   * Rows a tool resolved, on their way to the client and NOWHERE else. This is
   * the second half of `ToolOutcome`: it carries what the model deliberately
   * did not receive, so the data is shown rather than narrated.
   */
  | { type: "render"; render: RenderPayload }
  | { type: "gate"; gate: GatePreview }
  | { type: "staleUndo"; stale: StaleUndo }
  /**
   * The model is paused, but the turn still produced (or is about to produce) a
   * real, server-side tool effect. Carries an honest, server-authored note that
   * takes the place of the missing narration — never fabricated model text. The
   * effect/tool/gate frames around it are the genuine article.
   */
  | { type: "paused"; text: string }
  | { type: "done" }
  | { type: "error"; message: string; reason?: ErrorReason };
