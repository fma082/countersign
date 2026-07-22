# DEV_STATE

A living log of decisions and iterations. Newest first.

---

## Iteration 2 — three-tier governance (2026-07-22)

**Goal:** add the missing tier (reversible writes) and reframe the gate to allow
partial approval. Layout, home, and routes untouched — those are iteration 3.
Reference behavior: `_inbox/countersign-guided-flow.html` (a static sim, read
for interaction, not ported).

### Shipped

- **Tier criterion.** RADIUS (how many rows) + WINDOW (has the effect escaped
  the system?). radius-1 + open window → reversible; radius-N or a self-closing
  window → destructive. Written up as a case-study artifact in
  `docs/pattern-4-approval-checkpoint.md`.
- **Reversible tools** (radius 1): `update_price`, `adjust_stock`,
  `toggle_web_visible`. Run immediately, undoable. **The server decides the
  radius after resolving** — a field write that resolves to many rows is routed
  to the gate, never run as reversible.
- **Undo window.** Lasts until the next write; at most one active. Closed by
  another write or a gate decision (approve *or reject*); reads don't close it.
  No redo. Human-only signal — the model can't undo. Stale undo (value drifted)
  asks for confirmation instead of firing blind.
- **Partial approval.** The gate has three exits: approve all, approve a subset
  (per-target checkboxes, live "Approve N of M"), reject. Exclusions travel as
  IDs; the server re-resolves its own preview and re-intersects.
- **New destructive tool** `discontinue_products` (batch, always gated — its
  window closes downstream). `clear_expired_sales` unchanged.
- **Statechart** gained `undo` and `approvePartial(excludedIds)` (both user
  origin). The gate still has exactly one way out: a human signal.

### Design decisions worth remembering

- **Undo lives on the tool card, not a toast.** Three reasons: (1) a countdown
  manufactures time pressure and contradicts a product whose whole subject is
  taking the time to decide; (2) a toast fires in the workspace while the user
  is reading the panel (or vice-versa) and is missed half the time; (3) a toast
  vanishes, and with it the record that the action happened. On the card, the
  undo sits on the action itself, with no clock. When the window closes the card
  keeps the record and loses only the control ("Window closed by the next
  write.").
- **Undo is a new action, not a rollback of history.** Undoing appends a fresh
  entry (badge `undone`); the original is never edited or deleted. A history you
  can rewrite is the opposite of governance.
- **The undo window lasts until the next write.** One active undo, spent by the
  next write or any gate decision — reject included, because reject is a
  decision executed. Reads never consume it. There is deliberately no redo.
- **Partial approval is framed around missing context, not model error.** The
  resolver is strict and resolves correctly; the human excludes because they
  hold context the system doesn't (a running campaign, a customer request). A
  checkpoint justified by "the AI errs" ages out as models improve; one
  justified by "some decisions need context outside the system" does not. The
  client only shrinks the server's preview — it never defines the effect.
- **Placeholder-arg tolerance.** Small models fill an unused `sku` with junk
  ("none", "all"); the resolver ignores those and falls back to the `where`
  selector, so a radius-N field write still reaches the gate.

### Validation (all green)

- `tsc --noEmit` clean · `next build` clean.
- Engine verified via the API: reversible write (radius 1), radius-N → gate,
  discontinue → gate, undo (clean), stale-undo detection + force, partial
  approve re-intersect (2 of 3), gate consumed exactly once.
- **Full flow driven in-browser (light + dark)** via CDP:
  read (no window) → reversible `update_price` → **Undo** (new `undone` entry,
  original keeps its record) → reversible write → another write closes the first
  window → `discontinue_products` gate with a target unchecked ("Approve 2 of
  3") → partial approve. Confirmed a gate decision closes the open reversible
  window ("Window closed by a gate decision.").

### The `set_web_visible` finding — absorb the ambiguity, don't patch the model

During validation, `llama3.2:3b` intermittently called `toggle_web_visible`
with the `visible` arg **omitted**, and the tool's soft intent-mapping filled
the gap by flipping the current state. The result: a directionless request
("toggle X") silently **inverted** visibility — a product the user never asked
to expose got shown on the storefront. Evidence:
[`docs/toggle-web-visible-ambiguity.png`](docs/toggle-web-visible-ambiguity.png)
(the model invents `visible: "true"` for a "Toggle" request — a hidden product
goes public, from a guess with no grounding).

**The fix was architectural, not a model patch.** The tool was renamed
`toggle_web_visible` → `set_web_visible` and the direction made **required**:

- `set_web_visible(sku, visible)` — `visible` is mandatory.
- Omitted, or anything that doesn't resolve to a clear boolean → discarded as
  **`invalid`** (badge "invalid"), handed back to the model, **no state change**.
  The server never infers a direction and never flips the current value. A write
  without an explicit direction does not execute.

This is "strict in what it executes" applied to naming. "toggle" *invites* the
ambiguity the 3B exposed; "set" + a required arg *closes* it. The model's
weakness is now contained by the contract instead of patched in the prompt — and
the schema requirement demonstrably changed behavior (the model now always
states a direction). `set_web_visible` stays radius-1, reversible, undoable until
the next write, exactly as before.

The lesson generalizes: you don't correct the model, you design the tool surface
so the ambiguity can't execute silently.

### Known limits / next up

- Even with the direction required, a *directionless* user request ("toggle X")
  still makes the model **guess** a value — but now the guess is explicit in the
  args and auditable, never a silent inversion, and an omission is refused.
- Iteration 3: the three-column layout stays, but the new home and the guided
  4-step flow (staged in `_inbox/`) land then.

---

## Iteration 1 — scaffold, end to end (2026-07-21)

**Goal:** stand up the whole spine — tokens, seed, table, engine, statechart —
running end to end against a real local model. Out of scope this iteration:
reversible tier with undo, partial approval at the gate, the guided 4-step flow,
and the new home. Those come next.

### Shipped

- **Scaffold.** Next.js 16.2 (App Router, Turbopack) · React 19.2 · TS ·
  Tailwind v4.3 · Inter (400/500). Zero deps beyond the stack (+ lucide, clsx,
  tailwind-merge for shadcn conventions).
- **Token system.** Two layers — primitives (mode-invariant) and semantic
  (flip light/dark) — in `globals.css` via `@theme inline`, so the mode inverts
  at runtime by re-pointing CSS variables. Documented in `docs/tokens-spec.md`.
  Live showcase at `/tokens`.
- **Data.** Seed moved to `src/lib/scenario/`. `catalog.ts` adds a server-side
  session store, the public projection (strips `cost`), aggregations, and the
  one destructive op. `effectivePrice()` still returns an expired `salePrice` —
  intentional legacy quirk, left alone.
- **Statechart.** Pure, 8 states, signals classified by origin. Enforces the
  four rules (cancel keeps partial text; only a human leaves the gate; invalid
  args are a no-op; error is recoverable). Documented as a design/code contract
  in `docs/statechart-copilot-chat-panel.md`.
- **Engine.** Adapter frame (`ollama.ts`, provider-agnostic, raw frames) →
  governance (`route.ts` + `tools.ts`, computes preview/label/effect, decides
  `safe | gate | invalid`) → client reflects `StreamFrame`s. Three tools:
  `query_products`, `filter_view` (safe), `clear_expired_sales` (gated).
- **UI.** Three-column viewport layout (nav rail · workspace + table · copilot),
  each column scrolls independently; copilot becomes a drawer below `lg`. Live
  engine-status badge, plain-text assistant messages, tool event cards, the
  approval gate as the strongest element, and table row targeting
  (side bar + subtle fill = *could pass*; full fill = *passed*).

### Decisions worth remembering

- **Server-authored gate confirmation.** After approval, the closing line is
  written by the server, not the model. A 3B model narrating a completed
  destructive action produced a misleading "pending approval" message in
  testing — unacceptable in a project about trust. The server states what
  actually ran.
- **Text-emitted tool-call salvage.** `llama3.2:3b` intermittently "speaks" a
  tool call as JSON text instead of emitting a structured call. The route now
  (a) holds any turn whose text starts with `{` so a broken blob never reaches
  the transcript, and (b) salvages a known tool name out of it and routes it
  through governance. Temperature is pinned to 0 to reduce the flakiness at the
  source. Genuine prose is never affected (the salvage only fires on
  JSON-shaped, tool-named blobs).
- **Repeatable demo.** The API re-seeds its catalog at the start of a fresh
  conversation (history length ≤ 1, i.e. a page load), so the planted conflicts
  return without restarting the server. Under Turbopack the route handler and
  the page can hold separate module instances, so the page's own reset does not
  reach the API's store — hence the API resets itself.
- **distDir split.** `.next-dev` vs `.next-build` per `next.config.ts`, plus an
  `npm run clean`, to avoid the mixed-`.next` phantom recompile loop.

### Validation (all green)

- `tsc --noEmit` clean · `next build` clean (5 routes).
- Rendered in a real headless browser, **light and dark** — token swap inverts
  everything at runtime.
- **Full flow driven in-browser** via CDP:
  - `query_products` → read runs on its own, real count (6), targets resolved.
  - `filter_view` + reveal margin → 3 below-cost rows, server margins
    (−2.2 / −5.5 / −6.1).
  - `clear_expired_sales` → gate parks first; 6 rows spotlighted; the active
    sale `NB-LT-2004` excluded; composer disabled, no cancel.
  - **Approve** → applied; rows show *passed* treatment with struck-through old
    prices; `NB-LT-2004` untouched.
  - **Reject** → gate collapses to "Nothing changed"; table unchanged.

### Known limits / next up

- `llama3.2:3b` tool-calling is inherently a bit flaky; salvage + temp 0
  mitigate but do not eliminate it. A larger model would be steadier.
- The reversible tier currently reflects effects immediately (view changes);
  the **undo** affordance for reversible writes is deferred to the next
  iteration, along with **partial approval** at the gate, the **guided 4-step
  flow**, and the **new home** (prototypes staged in `_inbox/`).
