"use client";

import { useCallback, useReducer, useRef, useState } from "react";
import {
  initialState,
  transition,
  type CopilotState,
} from "@/lib/copilot-statechart";
import type {
  GatePreview,
  StreamFrame,
  ToolEvent,
  ViewEffect,
} from "@/lib/engine/types";

// ── What the panel renders ──────────────────────────────────────────────────
export type LogItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | { id: string; kind: "tool"; event: ToolEvent }
  | {
      id: string;
      kind: "gate";
      gate: GatePreview;
      resolved: "pending" | "approved" | "rejected";
    };

/** The shell wires table side effects through these. The hook owns everything
 *  else (transcript, statechart, streaming). */
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

  const historyRef = useRef<Wire[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef("");
  draftRef.current = state.draft;
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  // ── log mutators ──────────────────────────────────────────────────────────
  const stopStreaming = useCallback(() => {
    setLog((prev) =>
      prev.map((i) =>
        i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i,
      ),
    );
  }, []);

  const appendAssistant = useCallback((id: string, text: string) => {
    setLog((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx === -1)
        return [...prev, { id, kind: "assistant", text, streaming: true }];
      const next = prev.slice();
      const it = next[idx];
      if (it.kind === "assistant") next[idx] = { ...it, text: it.text + text };
      return next;
    });
  }, []);

  const resolveGateItem = useCallback(
    (resolved: "approved" | "rejected") => {
      setLog((prev) =>
        prev.map((i) =>
          i.kind === "gate" && i.resolved === "pending" ? { ...i, resolved } : i,
        ),
      );
    },
    [],
  );

  // ── the stream consumer ─────────────────────────────────────────────────────
  const consume = useCallback(
    async (action?: "approve") => {
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
            setLog((prev) => [
              ...prev,
              { id: frame.event.id, kind: "tool", event: frame.event },
            ]);
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
          body: JSON.stringify({ messages: historyRef.current, action }),
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
        // Cancel mid-stream keeps the partial text — commit it so the next turn
        // still has context.
        if (turnText.trim()) {
          historyRef.current.push({ role: "assistant", content: turnText });
        }
        abortRef.current = null;
      }
    },
    [appendAssistant, stopStreaming],
  );

  // ── user actions ────────────────────────────────────────────────────────────
  const setDraft = useCallback((value: string) => {
    dispatch({ kind: "input", value });
  }, []);

  const submit = useCallback(() => {
    const text = draftRef.current.trim();
    if (!text) return;
    setLog((prev) => [...prev, { id: nextId(), kind: "user", text }]);
    historyRef.current.push({ role: "user", content: text });
    dispatch({ kind: "submit" });
    void consume();
  }, [consume]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    stopStreaming();
    dispatch({ kind: "cancel" });
  }, [stopStreaming]);

  const approve = useCallback(() => {
    if (!gate) return;
    resolveGateItem("approved");
    setGate(null);
    cbRef.current.onGateClose();
    dispatch({ kind: "approve" });
    void consume("approve");
  }, [gate, consume, resolveGateItem]);

  const reject = useCallback(() => {
    if (!gate) return;
    resolveGateItem("rejected");
    setGate(null);
    cbRef.current.onGateClose();
    dispatch({ kind: "reject" });
  }, [gate, resolveGateItem]);

  return {
    state: state as CopilotState,
    status: state.status,
    draft: state.draft,
    log,
    gate,
    setDraft,
    submit,
    cancel,
    approve,
    reject,
  };
}
