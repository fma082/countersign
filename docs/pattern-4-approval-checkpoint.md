# Tiers & the approval checkpoint

The whole product rests on one classification: given a tool the model wants to
run, which of three tiers is it? The tier decides the friction.

> Reads → no friction.
> Reversible writes → run, then wait (undo available).
> Destructive writes → wait first (the gate).
>
> **Friction before or friction after, never both.**

This document is the criterion, not an implementation detail. The code that
enacts it lives in [`tools.ts`](../src/lib/engine/tools.ts) (governance),
[`copilot-statechart.ts`](../src/lib/copilot-statechart.ts) (states), and the
copilot UI.

---

## 1. The tier criterion

A tool is **not** reversible just because it is technically undoable — in
Postgres everything is. The criterion has two axes.

**RADIUS — how many rows does it touch?**
Radius 1 is verifiable at a glance: you can look at the one changed row and see
whether it is right. Radius N is not: undoing requires first *noticing* the
mistake, and at large radius you don't notice. Breadth defeats review.

**WINDOW — has the effect already escaped the system?**
A price is reversible right up until the first order is placed at that price.
Then the window is closed: money moved, a customer has a number. Some effects
close their own window the instant they run — a discontinued status propagates
to downstream systems (delisting, reorder stops) that you don't control.

**Operating rule**

| Radius | Window | Tier |
| ------ | ------ | ---- |
| 1 | open | **reversible** — run now, keep it undoable |
| N | (any) | **destructive** — gate, because breadth defeats review |
| 1 or N | closes on its own | **destructive** — gate, because there's no "after" to undo in |

Two products in this build make the axes concrete:

- **`toggle_web_visible` (radius 1)** is reversible — re-showing a product is a
  glance away. **`discontinue_products` (even radius 1)** is destructive —
  status propagates, the window closes. *Same radius, different tier — because
  of the window.*
- **`update_price` on one SKU** is reversible. **`update_price` resolved across
  a category** is gated. *Same tool, different tier — because of the radius.*

**The radius is the server's call, made after it resolves the target — never the
model's at call time.** The model asks; the server resolves and counts; a
field-write that resolves to many rows is routed to the gate no matter how the
model framed it.

---

## 2. The undo window

A reversible write runs immediately and is then undoable — but not forever.

- **The window lasts until the next write of the session.** There is at most
  **one** active undo: the last write's.
- **Closes the window:** another reversible write, or a decision at the gate —
  approve *or reject* (reject is a decision executed, so it counts).
- **Does not close the window:** reads. Querying and filtering consume nothing.
- **Undo spends its own window.** After undoing, there is nothing left to undo.
  **There is no redo.** A button that flips between two states forever turns
  governance into a toy.
- **Undo does not pass through the gate** — restoring a prior value always moves
  *backward*, never widens the effect. It *does* pass through the same
  server-side resolution.
- **The model cannot trigger undo. It is a human-only signal.** If the model
  could undo, it could loop — change, revert, change — unsupervised. Undo
  reinforces the asymmetry the gate already sets: the machine proposes, the
  human disposes.
- **Stale undo.** If the value drifted since the original write, undo does not
  fire blindly — the UI shows what changed and asks for confirmation.

The undo control lives **on the tool event card in the transcript**, never in a
toast — see [DEV_STATE.md](../DEV_STATE.md) for the argument. Undoing appends a
**new** entry (badge `undone`); it never edits or deletes the original. The undo
is a new action, not a rewrite of history — the opposite would be the opposite
of governance.

---

## 3. The gate, and partial approval

The gate has three exits: **approve all**, **approve a subset**, **reject**.

Every resolved target carries a checkbox, checked by default. Unchecking
excludes that target from the effect; the primary button's count updates live
(*Approve 5 of 6*). Uncheck everything and the primary disables — that is what
Reject is for.

**Why partial approval exists — and why the framing matters.**
It is *not* here because the model errs or the resolver fails. The resolver is
strict and resolves correctly. Partial approval exists because **the human holds
context the system doesn't**: a campaign still running, a customer's standing
request, an exception that was never in the data. The human excludes by
**judgment**, not by correction.

This is deliberate, and it is what keeps the pattern from aging badly. A
checkpoint justified by "the AI gets things wrong" gets weaker as models improve.
A checkpoint justified by "some decisions need context that lives outside the
system" does not — better models don't gain the missing context; it isn't in
the system to be had.

**Mechanically, the client only shrinks the effect — it never defines it.** The
exclusion travels as a list of IDs. The server re-resolves its *own* preview and
re-intersects: an excluded ID that was never in the preview is dropped, and only
the server's resolved-minus-excluded set runs. Server resolves, client reflects
— partial approval is no exception. The transcript records what was approved and
what was held back, not just the result.
