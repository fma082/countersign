"use client";

import { useCallback, useReducer, useRef, useState } from "react";
import {
  initialState,
  transition,
  type CopilotState,
} from "@/lib/copilot-statechart";
import type {
  ErrorReason,
  FilterState,
  GatePreview,
  RenderPayload,
  StaleUndo,
  StreamFrame,
  ToolEvent,
  UndoSpec,
  ViewEffect,
} from "@/lib/engine/types";

// ── What the panel renders ──────────────────────────────────────────────────
export type UndoState = "active" | "closed" | "consumed";

export type LogItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "tool";
      event: ToolEvent;
      undoState?: UndoState; // present only on a reversible write
      undoNote?: string; // shown once the window has closed
    }
  | {
      id: string;
      kind: "gate";
      gate: GatePreview;
      resolved: "pending" | "approved" | "rejected";
      excluded?: number;
    }
  // Rows a tool resolved and handed to the client instead of to the model.
  // It lives in the log, not beside it, so it keeps its place in the turn: the
  // model's preamble above, the resolved rows below, in arrival order.
  | { id: string; kind: "render"; render: RenderPayload }
  // Guided-flow signposts. Not model output — the shell drops these in.
  | { id: string; kind: "note"; text: string }
  | { id: string; kind: "closing"; text: string }
  // Server-authored honest note: the model is paused; the real tool effect
  // around this item is the system's, not a narration.
  | { id: string; kind: "paused"; text: string };

export interface CopilotCallbacks {
  onEffect(effect: ViewEffect): void;
  onGateOpen(targetIds: string[]): void;
  onGateClose(): void;
  /**
   * The `FilterState` currently on screen, read at request time.
   *
   * The panel does not OWN this value — the workspace does, because the filter
   * is the table's, not the copilot's. The panel only needs to put it in the
   * body of every request, so it reads it through a callback instead of keeping
   * a second copy that could disagree with the one the table is rendering.
   *
   * It is an opaque token here in every sense: nothing in this file reads a
   * field of it, branches on it, or counts anything from it. It arrives from
   * the server inside an effect, is stored verbatim, and goes back out
   * unexamined — like the message history beside it.
   */
  getFilter(): FilterState;
}

/**
 * A recorded turn: the exact `StreamFrame`s the governance server emitted, with
 * the pause before each. Keyed by the request body so a replayed session can
 * answer the follow-up calls (`approve`, `undo`) the same way the server would.
 *
 * This is the ONLY seam between the live panel and a scripted one. The frames
 * are the server's own output, recorded — never re-derived on the client — so a
 * replay still honours "the server resolves, the client reflects".
 */
export type ReplayStep = { frame: StreamFrame; delay?: number };
export type ReplayDriver = (body: Record<string, unknown>) => ReplayStep[];

export interface CopilotOptions {
  /** When set, the panel replays scripted frames instead of calling the engine. */
  replay?: ReplayDriver;
}

/** setTimeout as a promise that rejects (AbortError) the instant it's cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

interface Wire {
  role: "user" | "assistant";
  content: string;
}

let uid = 0;
const nextId = () => `it_${++uid}`;

export function useCopilot(callbacks: CopilotCallbacks, options: CopilotOptions = {}) {
  const [state, dispatch] = useReducer(transition, initialState);
  const [log, setLog] = useState<LogItem[]>([]);
  const [gate, setGate] = useState<GatePreview | null>(null);
  const [stale, setStale] = useState<StaleUndo | null>(null);
  // Why the last turn failed — picks the fallback surface. Only read in `error`.
  const [errorReason, setErrorReason] = useState<ErrorReason>("generic");

  const historyRef = useRef<Wire[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef("");
  draftRef.current = state.draft;
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const replayRef = useRef(options.replay);
  replayRef.current = options.replay;

  // The single active undo (there is at most one) and the item being undone.
  const activeUndoRef = useRef<{ itemId: string; spec: UndoSpec } | null>(null);
  const pendingUndoItemRef = useRef<string | null>(null);

  // ── log mutators ──────────────────────────────────────────────────────────
  const stopStreaming = useCallback(() => {
    setLog((prev) =>
      prev.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i)),
    );
  }, []);

  const appendAssistant = useCallback((id: string, text: string) => {
    setLog((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx === -1) return [...prev, { id, kind: "assistant", text, streaming: true }];
      const next = prev.slice();
      const it = next[idx];
      if (it.kind === "assistant") next[idx] = { ...it, text: it.text + text };
      return next;
    });
  }, []);

  /** Close the active undo window (a new write or a gate decision spends it). */
  const closeActiveUndo = useCallback((note: string) => {
    const active = activeUndoRef.current;
    if (!active) return;
    activeUndoRef.current = null;
    setLog((prev) =>
      prev.map((i) =>
        i.id === active.itemId && i.kind === "tool"
          ? { ...i, undoState: "closed", undoNote: note }
          : i,
      ),
    );
  }, []);

  const resolveGateItem = useCallback((resolved: "approved" | "rejected", excluded: number) => {
    setLog((prev) =>
      prev.map((i) =>
        i.kind === "gate" && i.resolved === "pending" ? { ...i, resolved, excluded } : i,
      ),
    );
  }, []);

  // ── the stream consumer (uniform across turn / approve / undo) ──────────────
  const consume = useCallback(
    async (bodyExtra: Record<string, unknown>) => {
      const controller = new AbortController();
      abortRef.current = controller;
      let turnText = "";
      let assistantId: string | null = null;

      const handle = (frame: StreamFrame) => {
        switch (frame.type) {
          case "token": {
            if (!assistantId) assistantId = nextId();
            turnText += frame.text;
            dispatch({ kind: "delta", text: frame.text });
            appendAssistant(assistantId, frame.text);
            break;
          }
          case "tool": {
            assistantId = null;
            stopStreaming();
            dispatch(
              frame.event.decision === "invalid"
                ? { kind: "invalidToolCall" }
                : { kind: "toolCall" },
            );
            const ev = frame.event;
            if (ev.badge === "undone") {
              // The undo's NEW entry. Mark the original consumed; never edit it.
              const originalId = pendingUndoItemRef.current;
              pendingUndoItemRef.current = null;
              setLog((prev) => [
                ...prev.map((i) =>
                  i.id === originalId && i.kind === "tool"
                    ? { ...i, undoState: "consumed" as const, undoNote: "Undone — nothing left to reverse." }
                    : i,
                ),
                { id: ev.id, kind: "tool", event: ev },
              ]);
              activeUndoRef.current = null;
            } else if (ev.undo) {
              // A reversible write. A new write spends the previous window.
              closeActiveUndo("Window closed by the next write.");
              const itemId = ev.id;
              activeUndoRef.current = { itemId, spec: ev.undo };
              setLog((prev) => [...prev, { id: itemId, kind: "tool", event: ev, undoState: "active" }]);
            } else {
              setLog((prev) => [...prev, { id: ev.id, kind: "tool", event: ev }]);
            }
            break;
          }
          case "effect": {
            cbRef.current.onEffect(frame.effect);
            break;
          }
          case "gate": {
            assistantId = null;
            stopStreaming();
            dispatch({ kind: "awaitApproval" });
            setGate(frame.gate);
            setLog((prev) => [
              ...prev,
              { id: frame.gate.id, kind: "gate", gate: frame.gate, resolved: "pending" },
            ]);
            cbRef.current.onGateOpen(frame.gate.targetIds);
            break;
          }
          case "render": {
            // The rows the model was deliberately not given. Appended in place,
            // so the component lands after whatever prose preceded it.
            assistantId = null;
            stopStreaming();
            setLog((prev) => [...prev, { id: nextId(), kind: "render", render: frame.render }]);
            break;
          }
          case "staleUndo": {
            setStale(frame.stale);
            break;
          }
          case "paused": {
            // The model is paused; the real tool effect lands around this note.
            // Stop any streaming cursor and drop the honest signpost in the log.
            assistantId = null;
            stopStreaming();
            setLog((prev) => [...prev, { id: nextId(), kind: "paused", text: frame.text }]);
            break;
          }
          case "done": {
            stopStreaming();
            dispatch({ kind: "done" });
            break;
          }
          case "error": {
            stopStreaming();
            setErrorReason(frame.reason ?? "generic");
            dispatch({ kind: "error", message: frame.message });
            break;
          }
        }
      };

      try {
        // Scripted panel: replay the recorded frames for this request, with
        // their pauses, through the exact same `handle`. No network, same truth.
        if (replayRef.current) {
          for (const step of replayRef.current(bodyExtra)) {
            if (controller.signal.aborted) break;
            if (step.delay) await sleep(step.delay, controller.signal);
            if (controller.signal.aborted) break;
            handle(step.frame);
          }
          return;
        }

        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `filter` rides on EVERY request, beside `messages` and for the same
          // reason: the server is stateless about the view, so the turn has to
          // carry what the human is looking at. It is what the `Current view:`
          // line in the prompt is built from.
          body: JSON.stringify({
            messages: historyRef.current,
            filter: cbRef.current.getFilter(),
            ...bodyExtra,
          }),
          signal: controller.signal,
        });
        // A non-ok status can still carry a typed error frame in its NDJSON body
        // (e.g. a 429 rate limit). Read the body regardless; only a truly empty
        // response falls back to a bare status.
        if (!res.body) {
          setErrorReason("generic");
          dispatch({ kind: "error", message: `Engine returned ${res.status}.` });
          return;
        }
        let sawFrame = false;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) {
              sawFrame = true;
              handle(JSON.parse(line) as StreamFrame);
            }
          }
        }
        // A non-ok response that produced no frame at all (proxy 5xx, empty body).
        if (!res.ok && !sawFrame) {
          setErrorReason("generic");
          dispatch({ kind: "error", message: `Engine returned ${res.status}.` });
        }
      } catch {
        if (!controller.signal.aborted) {
          stopStreaming();
          setErrorReason("generic");
          dispatch({ kind: "error", message: "The stream was interrupted." });
        }
      } finally {
        if (turnText.trim()) historyRef.current.push({ role: "assistant", content: turnText });
        abortRef.current = null;
      }
    },
    [appendAssistant, stopStreaming, closeActiveUndo],
  );

  // ── user actions ────────────────────────────────────────────────────────────
  const setDraft = useCallback((value: string) => dispatch({ kind: "input", value }), []);

  const submit = useCallback(() => {
    const text = draftRef.current.trim();
    if (!text) return;
    setLog((prev) => [...prev, { id: nextId(), kind: "user", text }]);
    historyRef.current.push({ role: "user", content: text });
    dispatch({ kind: "submit" });
    void consume({});
  }, [consume]);

  /**
   * Submit a specific prompt (the guided flow drives steps through this). The
   * optional `fallback` is the step's known tool: if the model can't be reached,
   * the server runs it directly so the guided flow always completes.
   */
  const submitPrompt = useCallback(
    (text: string, fallback?: { tool: string; args: Record<string, unknown> }) => {
      const t = text.trim();
      if (!t) return;
      setLog((prev) => [...prev, { id: nextId(), kind: "user", text: t }]);
      historyRef.current.push({ role: "user", content: t });
      dispatch({ kind: "input", value: t }); // seed the draft so `submit` fires
      dispatch({ kind: "submit" }); // clears it again — batched, no flash
      void consume(fallback ? { fallbackTool: fallback.tool, fallbackArgs: fallback.args } : {});
    },
    [consume],
  );

  /**
   * The human's own filter, sent down the same pipe the agent's tools use.
   *
   * It goes to the server rather than being applied locally, and not for
   * consistency's sake: `negative_margin` is `effectivePrice < cost`, and
   * `cost` is stripped server-side by `publicProducts`, so the browser cannot
   * evaluate that predicate at all. Resolving filters on the client would work
   * for six of the seven presets and silently fail on the one that matters —
   * so none of them are resolved here.
   */
  const applyFilter = useCallback(
    (next: FilterState) => void consume({ action: "filter", setFilter: next }),
    [consume],
  );

  const pushNote = useCallback(
    (text: string) => setLog((prev) => [...prev, { id: nextId(), kind: "note", text }]),
    [],
  );
  const pushClosing = useCallback(
    (text: string) => setLog((prev) => [...prev, { id: nextId(), kind: "closing", text }]),
    [],
  );

  /** Wipe the session back to a pristine, guided state. */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setLog([]);
    setGate(null);
    setStale(null);
    historyRef.current = [];
    activeUndoRef.current = null;
    pendingUndoItemRef.current = null;
    dispatch({ kind: "reset" });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    stopStreaming();
    dispatch({ kind: "cancel" });
  }, [stopStreaming]);

  /** Re-run the last turn after an engine error. */
  const retry = useCallback(() => {
    const hist = historyRef.current;
    // Drop a partial assistant a failed stream left behind, so we retry the user
    // turn rather than have the model continue its own half-answer.
    if (hist.length && hist[hist.length - 1].role === "assistant") hist.pop();
    if (!hist.some((m) => m.role === "user")) return;
    dispatch({ kind: "retry" });
    void consume({});
  }, [consume]);

  const approve = useCallback(
    (excludedIds: string[] = []) => {
      if (!gate) return;
      closeActiveUndo("Window closed by a gate decision."); // a decision spends the window
      resolveGateItem("approved", excludedIds.length);
      const gateId = gate.id;
      setGate(null);
      cbRef.current.onGateClose();
      dispatch(excludedIds.length ? { kind: "approvePartial", excludedIds } : { kind: "approve" });
      void consume({ action: "approve", gateId, excludedIds });
    },
    [gate, consume, closeActiveUndo, resolveGateItem],
  );

  const reject = useCallback(() => {
    if (!gate) return;
    closeActiveUndo("Window closed by a gate decision.");
    resolveGateItem("rejected", 0);
    setGate(null);
    cbRef.current.onGateClose();
    dispatch({ kind: "reject" });
  }, [gate, closeActiveUndo, resolveGateItem]);

  const runUndo = useCallback(
    (force: boolean) => {
      const active = activeUndoRef.current;
      if (!active) return;
      pendingUndoItemRef.current = active.itemId;
      setStale(null);
      dispatch({ kind: "undo" });
      void consume({ action: "undo", undo: active.spec, force });
    },
    [consume],
  );

  const undo = useCallback(() => runUndo(false), [runUndo]);
  const confirmStale = useCallback(() => runUndo(true), [runUndo]);
  const cancelStale = useCallback(() => setStale(null), []);

  return {
    state: state as CopilotState,
    status: state.status,
    draft: state.draft,
    log,
    gate,
    stale,
    errorReason,
    setDraft,
    submit,
    submitPrompt,
    applyFilter,
    pushNote,
    pushClosing,
    reset,
    cancel,
    retry,
    approve,
    reject,
    undo,
    confirmStale,
    cancelStale,
  };
}
