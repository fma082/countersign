/**
 * Copilot chat-panel statechart — the shared contract between design and code.
 *
 * PURE. No React, no provider, no I/O. Given a state and a typed signal it
 * returns the next state. Every effect (calling the engine, opening a stream,
 * running a timer) lives in the caller; this file only decides *what is true*.
 *
 * The prose contract lives in docs/statechart-copilot-chat-panel.md. If the two
 * disagree, they are both bugs — keep them in sync.
 */

// ── States ────────────────────────────────────────────────────────────────
export type CopilotStatus =
  | "empty" //            no turn has ever started; input is pristine
  | "idle" //            a turn finished earlier; input is empty, panel ready
  | "typing" //          user has text in the composer, not yet submitted
  | "thinking" //        request sent, no token has come back yet
  | "streaming" //       tokens / tool events are arriving
  | "complete" //        the turn ended (naturally or by cancel)
  | "awaitingApproval" // a destructive tool is parked at the human gate
  | "error"; //          the engine process failed; retry is available

// ── Signals, classified by origin ───────────────────────────────────────────
// The origin is part of the contract: only `user` signals may leave the gate.

/** Fired by the person at the keyboard. */
export type UserSignal =
  | { kind: "input"; value: string } //                 composer content changed
  | { kind: "submit" } //                               send the current composer text
  | { kind: "cancel" } //                               stop an in-flight turn
  | { kind: "approve" } //                              clear the gate, run the whole effect
  | { kind: "approvePartial"; excludedIds: string[] } // clear the gate, run a subset
  | { kind: "reject" } //                               clear the gate, discard the effect
  | { kind: "undo" }; //                                reverse the last reversible write

/** Fired by the engine (the server-side StreamFrame reader). */
export type EngineSignal =
  | { kind: "firstToken" } //          first byte of the response
  | { kind: "delta"; text: string } // a streamed chunk of assistant text
  | { kind: "toolCall" } //            a resolved tool event was emitted
  | { kind: "invalidToolCall" } //     args rejected — discarded, NOT a state change
  | { kind: "awaitApproval" } //       a destructive tool reached the gate
  | { kind: "done" } //                the turn finished cleanly
  | { kind: "error"; message: string }; // the engine process failed

/** Fired by the machine itself / the shell (derived, not by a human or model). */
export type AutoSignal =
  | { kind: "reset" }; //              return the panel to a pristine ready state

export type CopilotSignal = UserSignal | EngineSignal | AutoSignal;

export type SignalOrigin = "user" | "engine" | "auto";

/** Origin lookup — used by the docs generator and by tests, and it makes the
 *  "only a human leaves the gate" rule enforceable rather than aspirational. */
export const SIGNAL_ORIGIN: Record<CopilotSignal["kind"], SignalOrigin> = {
  input: "user",
  submit: "user",
  cancel: "user",
  approve: "user",
  approvePartial: "user",
  reject: "user",
  undo: "user",
  firstToken: "engine",
  delta: "engine",
  toolCall: "engine",
  invalidToolCall: "engine",
  awaitApproval: "engine",
  done: "engine",
  error: "engine",
  reset: "auto",
};

// ── State shape ─────────────────────────────────────────────────────────────
export interface CopilotState {
  status: CopilotStatus;
  /** Composer text. Distinct from the streamed response. */
  draft: string;
  /** Accumulated assistant text for the *current* turn. Cancel preserves it. */
  partial: string;
  /** Present only in `error`. */
  error: string | null;
}

export const initialState: CopilotState = {
  status: "empty",
  draft: "",
  partial: "",
  error: null,
};

// ── Transition ──────────────────────────────────────────────────────────────
/**
 * The reducer. Returns the SAME object reference when a signal is a no-op in
 * the current state, so callers can cheaply detect "nothing happened" (e.g. an
 * invalid tool call, or an engine signal that arrives while the gate is open).
 */
export function transition(state: CopilotState, signal: CopilotSignal): CopilotState {
  switch (state.status) {
    case "empty":
    case "idle":
    case "complete":
    case "error": {
      // Ready-ish states: accept new input and new submissions.
      if (signal.kind === "input") {
        return {
          ...state,
          status: signal.value.length > 0 ? "typing" : readyStatus(state),
          draft: signal.value,
          // Starting to type a fresh turn clears the previous error surface.
          error: null,
        };
      }
      if (signal.kind === "submit" && state.draft.trim().length > 0) {
        // From `error`, submit doubles as retry. The composer clears — the text
        // has moved into the transcript.
        return { ...state, status: "thinking", draft: "", partial: "", error: null };
      }
      // Undo is a write. It runs through the engine like any other, but carries
      // no composer text — the draft is left untouched. Human-only signal.
      if (signal.kind === "undo") {
        return { ...state, status: "thinking", partial: "", error: null };
      }
      if (signal.kind === "reset") return initialState;
      return state;
    }

    case "typing": {
      if (signal.kind === "input") {
        return {
          ...state,
          status: signal.value.length > 0 ? "typing" : "idle",
          draft: signal.value,
        };
      }
      if (signal.kind === "submit" && state.draft.trim().length > 0) {
        return { ...state, status: "thinking", draft: "", partial: "", error: null };
      }
      if (signal.kind === "undo") {
        return { ...state, status: "thinking", partial: "", error: null };
      }
      if (signal.kind === "reset") return initialState;
      return state;
    }

    case "thinking": {
      switch (signal.kind) {
        case "firstToken":
          return { ...state, status: "streaming" };
        case "delta":
          // A chunk can precede the explicit firstToken; treat it as the start.
          return { ...state, status: "streaming", partial: state.partial + signal.text };
        case "toolCall":
          return { ...state, status: "streaming" };
        case "awaitApproval":
          return { ...state, status: "awaitingApproval" };
        case "done":
          return { ...state, status: "complete", draft: "" };
        case "error":
          return { ...state, status: "error", error: signal.message };
        case "cancel":
          return { ...state, status: "complete", draft: "" };
        default:
          return state;
      }
    }

    case "streaming": {
      switch (signal.kind) {
        case "delta":
          return { ...state, partial: state.partial + signal.text };
        case "firstToken":
        case "toolCall":
          return state; // already streaming; event is logged by the shell
        case "invalidToolCall":
          // CONTRACT: invalid args do NOT change state. Discarded, handed back
          // to the model. Never surfaces as an "ok" tool result.
          return state;
        case "awaitApproval":
          return { ...state, status: "awaitingApproval" };
        case "done":
          return { ...state, status: "complete", draft: "" };
        case "cancel":
          // CONTRACT: cancel mid-stream keeps the partial text.
          return { ...state, status: "complete", draft: "" };
        case "error":
          return { ...state, status: "error", error: signal.message };
        default:
          return state;
      }
    }

    case "awaitingApproval": {
      // CONTRACT: the gate is left ONLY by a human signal. The model cannot
      // reopen it (awaitApproval) nor skip it (done/delta/toolCall) — those are
      // ignored. The engine is already stopped; there is nothing to cancel.
      switch (signal.kind) {
        case "approve":
        case "approvePartial":
          // Partial approval is a variant of approve, not a new state: the human
          // clears the gate and the server executes what survived.
          return { ...state, status: "thinking", partial: "" };
        case "reject":
          return { ...state, status: "complete", draft: "" };
        default:
          return state;
      }
    }
  }
}

// ── Derived helpers (for the shell; still pure) ─────────────────────────────

/** A state where an idle/empty panel is legitimately "ready and pristine". */
function readyStatus(state: CopilotState): CopilotStatus {
  return state.status === "empty" ? "empty" : "idle";
}

export const isBusy = (s: CopilotStatus): boolean =>
  s === "thinking" || s === "streaming";

export const isGateOpen = (s: CopilotStatus): boolean => s === "awaitingApproval";

/** The composer is live only when the engine is not running and no gate blocks it. */
export const canType = (s: CopilotStatus): boolean =>
  s === "empty" || s === "idle" || s === "typing" || s === "complete" || s === "error";

/** Cancel is offered only while the engine is actually producing. Never at the
 *  gate — the engine is already halted, there is nothing to cancel. */
export const canCancel = (s: CopilotStatus): boolean => isBusy(s);

export const canRetry = (s: CopilotStatus): boolean => s === "error";
