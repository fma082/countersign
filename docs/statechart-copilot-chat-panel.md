# Statechart — copilot chat panel

This is the shared contract between design and code, and an artifact of the case
study. The implementation is [`src/lib/copilot-statechart.ts`](../src/lib/copilot-statechart.ts):
a **pure** reducer with no React and no provider knowledge. If this document and
that file disagree, they are both bugs — fix them together.

The machine decides *what is true*. Every effect — calling the engine, opening a
stream, running a timer — lives in the caller (the `useCopilot` hook). The
statechart itself performs no I/O.

---

## States (8)

| State              | Meaning                                                        |
| ------------------ | ------------------------------------------------------------- |
| `empty`            | No turn has ever started. The composer is pristine.           |
| `idle`             | A previous turn finished. Composer empty, panel ready.        |
| `typing`           | The user has text in the composer, not yet submitted.         |
| `thinking`         | Request sent; no token has come back yet.                     |
| `streaming`        | Tokens / tool events are arriving.                            |
| `complete`         | The turn ended — naturally, or by cancel.                     |
| `awaitingApproval` | A destructive tool is parked at the human gate.               |
| `error`            | The engine process failed. Retry is available.                |

---

## Signals, by origin

The **origin** is part of the contract — it is what makes "only a human leaves
the gate" enforceable rather than aspirational (`SIGNAL_ORIGIN` in code).

**User** (the person at the keyboard)
: `input(value)` · `submit` · `cancel` · `approve` · `approvePartial(excludedIds)` · `reject` · `undo`

**Engine** (the server-side StreamFrame reader)
: `firstToken` · `delta(text)` · `toolCall` · `invalidToolCall` · `awaitApproval` · `done` · `error(message)`

**Auto** (the machine / shell; derived, not a human or the model)
: `reset`

---

## Transitions

```
empty ──input(text)──▶ typing
idle  ──input(text)──▶ typing
typing ──input("")──▶ idle
typing ──submit──▶ thinking            (composer clears; text moves to transcript)
{empty,idle,complete,error} ──submit──▶ thinking
{empty,idle,typing,complete,error} ──undo──▶ thinking   (undo is a write; draft untouched)

thinking ──firstToken──▶ streaming
thinking ──delta──▶ streaming          (a chunk can precede firstToken)
thinking ──toolCall──▶ streaming
thinking ──awaitApproval──▶ awaitingApproval
thinking ──done──▶ complete
thinking ──cancel──▶ complete
thinking ──error──▶ error

streaming ──delta──▶ streaming         (append)
streaming ──toolCall──▶ streaming      (event logged by the shell)
streaming ──invalidToolCall──▶ streaming   (NO-OP — see below)
streaming ──awaitApproval──▶ awaitingApproval
streaming ──done──▶ complete
streaming ──cancel──▶ complete         (partial text preserved)
streaming ──error──▶ error

awaitingApproval ──approve──▶ thinking (re-engage engine to execute + report)
awaitingApproval ──approvePartial(excludedIds)──▶ thinking   (a variant of approve)
awaitingApproval ──reject──▶ complete
awaitingApproval ──(any engine signal)──▶ awaitingApproval   (ignored)

error ──submit──▶ thinking             (submit doubles as retry)
* ──reset──▶ empty
```

The reducer returns the **same object reference** for a no-op, so the shell can
cheaply detect "nothing happened."

---

## The four rules this machine exists to enforce

1. **Cancel mid-stream preserves the partial text.**
   `streaming ──cancel──▶ complete` keeps `partial`. The half-written answer
   stays in the transcript; it is not thrown away.

2. **The gate is left only by a human.**
   In `awaitingApproval`, every engine signal (`delta`, `toolCall`, `done`,
   even another `awaitApproval`) is ignored. The model cannot reopen the gate,
   cannot skip it, cannot resolve it. Only `approve` or `reject` moves the
   machine — and both originate from the user.

3. **Invalid arguments do not change state.**
   `streaming ──invalidToolCall──▶ streaming` is a deliberate no-op. A call with
   bad arguments is discarded and handed back to the model; it never advances
   the turn and never surfaces as an "ok" result. (The tool card still shows an
   `invalid` badge — the *event log* records it; the *state* does not move.)

4. **Engine failure is recoverable.**
   `error` is a real state with `submit` wired as retry, not a dead end.

5. **Undo is a human-only write; partial approval is not a new state.**
   `undo` originates only from the user — the model cannot emit it — and runs
   through the engine like any other write (`… ──undo──▶ thinking ──…──▶
   complete`), appending a new `undone` entry rather than editing history.
   `approvePartial` is a *variant* of `approve`, not a fourth gate exit in the
   machine: the human still leaves the gate with a single human signal. The undo
   *window* (which write is undoable, and what closes it) is transcript state
   owned by the shell, not the statechart — see
   [pattern-4-approval-checkpoint.md](pattern-4-approval-checkpoint.md).

---

## Why "no cancel at the gate"

`canCancel` is true only in `thinking` / `streaming`. At the gate the engine has
already stopped — it emitted the preview and halted. There is nothing in flight
to cancel, so the composer offers no cancel affordance; it shows
"Waiting for your decision…" and the only exits are Approve and Reject.

This is the UI mirror of rule 2: the gate is a hard stop that only a human
clears.
