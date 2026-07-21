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
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
}

// ── Layer 1 output: raw frames from the adapter ────────────────────────────
export type RawFrame =
  | { type: "token"; text: string }
  | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | { type: "done" }
  | { type: "error"; message: string };

// ── Governance vocabulary ──────────────────────────────────────────────────

/** How the server decided to treat a tool call. */
export type ToolDecision = "safe" | "gate" | "invalid";

/**
 * Result badge shown on a tool card. "invalid" is first-class: a call discarded
 * for bad arguments shows "invalid", NEVER "ok". Showing "ok" over a discarded
 * call would be lying in the UI of a project whose subject is trust.
 */
export type ResultBadge = "ok" | "invalid" | "pending" | "rejected" | "error";

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
}

/** What the client applies to the table. Fields are additive/idempotent. */
export interface RowMutation {
  sku: string;
  price: number;
  salePrice: number | null;
  saleEnds: string | null;
  lastUpdated: string;
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
  | { type: "gate"; gate: GatePreview }
  | { type: "done" }
  | { type: "error"; message: string };
