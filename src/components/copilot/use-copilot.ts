"use client";

import { useCallback, useReducer, useRef, useState } from "react";
import {
  initialState,
  transition,
  type CopilotState,
} from "@/lib/copilot-statechart";
import type {
  GatePreview,
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
    };

export interface CopilotCallbacks {
  onEffect(effect: ViewEffect): void;
  onGateOpen(targetIds: string[]): void;
  onGateClose(): void;
}

interface Wire {
  role: "user" | "assistant";
  content: string;
}

let uid = 0;
const nextId = () => `it_${++uid}`;

export function useCopilot(callbacks: CopilotCallbacks) {
  const [state, dispatch] = useReducer(transition, initialState);
  const [log, setLog] = useState<LogItem[]>([]);
  const [gate, setGate] = useState<GatePreview | null>(null);
  const [stale, setStale] = useState<StaleUndo | null>(null);

  const historyRef = useRef<Wire[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef("");
  draftRef.current = state.draft;
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

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
          case "staleUndo": {
            setStale(frame.stale);
            break;
          }
          case "done": {
            stopStreaming();
            dispatch({ kind: "done" });
            break;
          }
          case "error": {
            stopStreaming();
            dispatch({ kind: "error", message: frame.message });
            break;
          }
        }
      };

      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: historyRef.current, ...bodyExtra }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          dispatch({ kind: "error", message: `Engine returned ${res.status}.` });
          return;
        }
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
            if (line) handle(JSON.parse(line) as StreamFrame);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          stopStreaming();
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

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    stopStreaming();
    dispatch({ kind: "cancel" });
  }, [stopStreaming]);

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
    setDraft,
    submit,
    cancel,
    approve,
    reject,
    undo,
    confirmStale,
    cancelStale,
  };
}
