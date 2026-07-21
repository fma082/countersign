# DEV_STATE

A living log of decisions and iterations. Newest first.

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
