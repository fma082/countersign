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
   * The user's own phrasing for what they asked, as the model reported it —
   * the component's subtitle ("interpreted from: …"). It rides this channel and
   * not the model's on purpose: fed back to the model it gets narrated as the
   * DEFINITION of the criterion, which is false. See `governQuery`.
   */
  userIntent?: string;
}

export interface ToolOutcome<T = unknown> {
  modelPayload: unknown;
  renderPayload?: RenderPayload<T>;
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
  /** Set the visible-row filter. `null` clears it (show all 30). Absent = leave as-is. */
  filter?: { skus: string[] | null };
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
