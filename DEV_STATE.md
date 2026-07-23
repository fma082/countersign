# DEV_STATE

A living log of decisions and iterations. Newest first.

---

## Iteration 5 — resilience: the system guarantees, not the model (2026-07-23)

**Frame.** The demo runs on a free-tier model that intermittently answers "out
of capacity". The thesis of Countersign is that the *system* — not the model —
enforces the guarantees. This iteration makes that literal: when the model is
paused, the guided flow still completes, the tools still run, the gate still
resolves. The only thing lost is the model's spoken narration, and that is
declared, never faked. **The system guarantees, not the model.**

Governing constraint held throughout: **never simulate a model response.** The
honest degradation shows the tool's REAL server-side effect and says the model
is paused — it never passes pre-written text off as generated.

### Shipped

- **Auto-retry with backoff (`resilient.ts`).** A wrapper around the provider
  stream retries a *transient* failure (`model_paused`: capacity / 5xx / network)
  with growing backoff (`MODEL_RETRY_BACKOFF_MS`, default `1000,2500,5000`)
  before any failure state shows. During the wait nothing is emitted — the turn
  stays in `thinking`, so the log's loading indicator already reads as "working".
  A *permanent* fault (`provider_error`: contract 400, auth) is surfaced at once,
  never retried. A retry only fires if the failure was the attempt's first frame
  (never after output has streamed — no duplication).
- **Guided flow that always completes (server-side degradation).** Each guided
  step carries a `fallback` — the tool it is known to run. When the model can't
  be reached after retries, the route runs that tool through the SAME `govern`
  path a model-driven call uses: real decision, real effect, real gate, real
  `targetIds`, real partial-approval. Only the narration is replaced — by a
  server-authored `paused` note. The four steps reach the gate and its
  resolution with or without the model. If a tool had *already* run when a later
  round failed, the turn ends with a paused note + `done` (the effect stands;
  only the summary is missing) — no re-run, no double effect.
- **Reframed model-paused state (Part 3).** A pause is no longer dressed as an
  error. It borrows the approval gate's register — the action-coloured accent,
  the calm uppercase badge — because both are "the system is holding on purpose".
  Badge reads `MODEL PAUSED · SYSTEM INTACT`; the header status dot uses the
  gate's action colour, not error red; the copy reaffirms the thesis instead of
  apologising ("Countersign's guarantees hold without it — reads, undo, and the
  approval gate are enforced by the system, not the model"). A real fault
  (`provider_error`) keeps the error treatment — the two are now visibly
  distinct.

### Decisions worth remembering

- **Degradation is server-side, keyed on a per-step fallback tool.** The client
  passes the step's known tool; the server, on an exhausted pre-tool failure,
  executes it via `govern`. This keeps "server resolves, client reflects" intact
  (the degraded effect is server-resolved, never client-fabricated) and lets the
  statechart and guided orchestrator see an ordinary completion — no new states,
  no special-casing. The engine, statechart, and governance logic are unchanged;
  this is a new entrypoint into the same governance plus a retry wrapper.
- **Three distinct failure modes, by design.** `model_paused` (transient →
  retried, reframed as a pause), `provider_error` (permanent → not retried, a
  real error to report), `rate_limit` (our own cap). A first-class `reason` on
  the frame drives both the retry decision and the surface — never string
  sniffing. `provider_down` from iteration 4 is gone, split into the two precise
  reasons.
- **The reconnecting text was dropped as unnecessary.** The retry window is
  already covered by the `thinking` loading indicator (the transient failure
  fails at connect time, before any token), so the visitor sees continuous
  "working" without an extra label. Kept the surface simpler.
- **`MODEL_FORCE_ERROR` test affordance.** Off unless set. Forces every provider
  attempt to fail with a given reason, so the retry→degrade path is testable
  without waiting on the real backend to be down.

### Validated (forced failure + model available)

- Forced `model_paused` (fast backoff): guided step 1 → paused note + **real**
  `filter_view` (3 below-cost rows, real margins −2.2/−5.5/−6.1) + effect + done;
  step 4 → paused note + **real** gate (6 targets, active sale excluded, warn
  flags); **approve** → real mutations + margins + server closing, no model. ~0.36s
  total confirms the ~300ms backoff ran before degrading.
- Free input, no fallback, forced `model_paused` → `error{reason:model_paused}`
  → reframed paused surface.
- Forced `provider_error` (5s backoff configured): free input surfaced in
  **0.05s** — no retry hammering; a guided step still degraded to complete.
- Model available (no force): guided step used the real model — narration
  tokens + real tool + done, **zero** paused frames; the fallback is ignored.
- Paused surfaces use only theme-aware tokens (the gate card's set), so light +
  dark follow structurally. `tsc` + `next build` clean.

---

## Iteration 4 — public deploy: Groq adapter + endpoint guards (2026-07-23)

**Goal:** a stable public link for portfolio/interviews. Swap the local Ollama
provider for a cloud one (Groq) behind the existing provider-agnostic seam,
without touching governance, the statechart, or the UI's substance. No database
yet — session state stays in memory, Reset returns to the seed. The deploy is
`/scenario` only; `/` stays static and never mounts the engine.

### Shipped

- **Groq adapter (sibling of Ollama).** `src/lib/engine/groq.ts` talks to Groq's
  OpenAI-compatible `/chat/completions` (SSE, `stream: true`), model
  `llama-3.1-8b-instant`. It translates OpenAI-style streamed `tool_calls`
  (fragmented `arguments` accumulated by `index`) into the internal `toolCall`
  RawFrame — same contract Ollama emits. `ollama.ts` is untouched in behaviour;
  both are selected by `provider.ts` on `MODEL_PROVIDER=ollama|groq`. Governance
  imports the provider from the selector and never names a concrete backend.
- **Artificial inter-token throttle (Groq only).** `GROQ_THROTTLE_MS` (default
  28ms) delays each content delta. See the decision below.
- **Per-IP rate limit.** `rate-limit.ts` — fixed-window, in-memory, keyed on
  `x-forwarded-for`. `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`; only the
  model-consuming turn is limited (approve/undo are pure governance and never
  blocked mid-decision). On the limit, the route returns HTTP 429 whose NDJSON
  body carries a typed `{reason:"rate_limit"}` error frame.
- **Dignified fallback.** Error frames now carry an optional `reason`
  (`rate_limit | provider_down | generic`). The client shows a distinct,
  explained surface — never a stack trace: "Demo request limit reached" (rate)
  vs "The live model isn't available right now" (provider down), each with a
  line on what Countersign is so the page still communicates with the model
  offline. `generic` keeps the existing retry card.

### Decisions worth remembering

- **The throttle is an anti-feature, on purpose.** Groq returned a full turn in
  ~22ms in testing — at that speed the streaming cursor, the thinking dots, and
  the token-by-token reveal are all invisible; text lands in one block and the
  patterns this project is *about* (watching a read resolve, watching a write
  land) stop being legible. Warm local Ollama gave perceptible latency for free;
  the throttle re-creates it deliberately. This is the counter-narrative to the
  usual Groq demo that sells raw speed: for a trust UI, legible cadence beats
  instant. Configurable, invisible to the visitor, Groq-only.
- **Error `reason` on the frame, not string-matched.** Rather than have the
  client sniff error text, the failure kind is a first-class field the adapter
  and the route set. Honest by construction — the same principle as `invalid`
  being a real `ToolDecision`: the UI reflects a typed server verdict, it does
  not guess.
- **Rate limit only the model turn.** Approve/undo don't call the provider, so
  limiting them would block a visitor from finishing a decision they already
  started — worse UX for no quota saving.
- **`ProviderTool` moved to `types.ts`.** It described the provider wire shape
  but lived in `ollama.ts`; a true sibling adapter shouldn't import a type from
  the other adapter. It now lives in the shared contract.

### Known limits / next up

- **In-memory rate limit is per serverless instance.** On Vercel, the counter
  is not shared across concurrent instances and resets on cold start, so the
  effective cap is per-instance, not global. Deliberate — a shared store (Redis)
  is over-engineering for a portfolio demo. Documented, not fixed.
- **Pre-recorded walkthrough deferred.** The dignified error state is solid (the
  priority — it's what an interviewer sees if the link fails). Playing the flow
  back with simulated responses when the model is down is desirable but
  secondary; deferred to a later iteration.
- **No DB yet.** Session state is in memory; Reset returns to the seed. Per-
  session isolation waits for the database iteration.

### Validation (against Groq)

- `tsc --noEmit` clean · `next build` clean (5 routes); `/` still `○ Static`,
  only `/scenario` + `/api/copilot` dynamic.
- Full flow driven via `curl` against `MODEL_PROVIDER=groq`:
  - `query_products(expired_sales)` → read runs alone, real count 6, targets
    resolved; answer streams as discrete throttled deltas.
  - `clear_expired_sales` → parks at the gate first; 6 targets, the one active
    sale excluded, `warn` flags and server-authored preview intact.
  - **Approve** → server-authored closing ("Done — applied to 6 products"),
    mutations + fresh margins in the effect.
  - `update_price` → reversible, with an `undo` spec.
- Rate limiter unit-verified: `MAX=3` allows 3, blocks the 4th/5th
  (`retryAfter=60`), independent per IP.

### Deploy (Vercel)

- Project `/scenario` is the only engine consumer; `/` prerenders static.
- Env vars to set in Vercel (server-side; the key never reaches the bundle):
  `GROQ_API_KEY`, `MODEL_PROVIDER=groq`, `NEXT_PUBLIC_MODEL_PROVIDER=groq`
  (label only), `GROQ_THROTTLE_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`.
  `NEXT_PUBLIC_MODEL_PROVIDER` is the only public one and carries no secret.

### distDir fix — build must stay on `.next` for Vercel (2026-07-23)

- **Symptom.** Vercel failed: "output directory `.next` was not found". The
  custom `distDir` wrote the production build to `.next-build`, but Vercel only
  ever looks at the default `.next`.
- **Cause.** The split keyed on `NODE_ENV` — `production ? ".next-build" :
  ".next-dev"` — to stop local `next dev` and `next build` from sharing a
  `.next` (a mixed cache pushes Turbopack into a phantom recompile loop). But
  Vercel runs only `build`, so it hit the `.next-build` branch and lost the
  output.
- **Fix.** Key on `development` instead: `next dev` → `.next-dev`, every build
  (local *and* Vercel) → the default `.next`. Dev and build still never share a
  dir locally, so the original loop can't return, and Vercel finds its output.
  No host special-casing (`process.env.VERCEL`) needed — the divergence is about
  the command, not the platform. `.gitignore`, `npm run clean`, the tsconfig
  `include` (generated route types now under `.next/types`), and CLAUDE.md were
  updated for the renamed dir. `next build` verified locally: output at `.next`
  with a `BUILD_ID`.

### Groq `tool_call_id` — provider-agnostic isn't free (2026-07-23)

- **Symptom (found in production).** The first tool call ran, but the follow-up
  round 400'd: `'messages.3.tool_call_id': property 'tool_call_id' is missing`.
  The dignified fallback caught it as MODEL OFFLINE and the app never broke —
  which is exactly what that state is for — but the cause had to be fixed.
- **Cause.** Groq (OpenAI contract) *requires* every `role:"tool"` message to
  carry a `tool_call_id` binding the result to the call that produced it. Ollama
  requires no such thing, so the internal frame never carried an id and the Groq
  adapter never set one. On the digest round (tool result re-sent upstream),
  Groq rejected the untethered tool message.
- **Fix.** The internal `ChatMessage`/`ToolCall` now carry the optional call id
  (`ToolCall.id`, `ChatMessage.tool_call_id`); the route stamps each assistant
  `tool_call` and its matching result with the same id (Groq's own, captured off
  the stream — multiple calls each keep their own, never mixed). The Groq adapter
  translates both into OpenAI shape. Ollama is untouched: it neither sets nor
  reads the fields, and ignores them on the wire.
- **The lesson (case-study material).** Provider-agnostic is not free. Two
  backends in the same Llama family still disagree on the message contract —
  Groq demands `tool_call_id`, Ollama doesn't — and the seam that absorbs that is
  the adapter, by design: *the translation between the internal frame and each
  provider's format is each adapter's responsibility.* The bug surfaced only
  against the real cloud backend, in production, and was absorbed by the fallback
  without a crash before being fixed at the source.
- **Validated.** Same query that 400'd now completes clean against Groq; approve
  (server-authored closing + mutations/margins) and a reversible write (incl. a
  chained second tool round) pass with no 400. Ollama re-verified unchanged. tsc
  + build clean.

---

## Iteration 3 — presentation: guided flow + home (2026-07-22)

**Goal:** the layer that makes a stranger understand the project with nobody
beside them. Two fronts: a guided start for `/scenario`, and a new home at `/`.
The engine is untouched — the guided flow runs the real engine as-is; the home
is static. References (`_inbox/`) read for interaction and hierarchy, not ported.

### Shipped

- **Guided flow.** `/scenario` opens with a welcome block and the four steps as
  stacked commands — read → read → reversible → destructive, each tagged with
  its tier. Steps are sequential (only the active one is clickable); 03 and 04
  announce "reversible"/"destructive" before the click, so the tension is built
  ahead of it. Each step runs a real prompt against the model; only the order
  and the prompts are guided, never the responses.
- **Contextual notes.** A terse, left-bordered note drops into the log right
  after each phenomenon is visible (read; still-a-read; reversible/undo-on-card;
  engine-halted-at-the-gate). Step 04's note lands when the engine halts; the
  thesis closing lands once the gate is decided — by any of the three exits.
- **Input gating + release.** Free input is disabled through the flow with an
  explanatory placeholder; it unlocks only after step 04 completes, alongside a
  Reset. A Reset button restores the seed and returns to the guided state.
- **Home.** Hero-first: headline ("Reads run alone. Writes wait for you."),
  lede, a **static** app-shot of the split view frozen at the gate (real table +
  gate card, no engine, inert), and the demo CTA. A 3-column claims strip with
  hairlines (no cards), then the pattern catalog rebuilt as a compact **index**
  (not a chat gallery) — subordinate to the hero.
- **Two truth fixes surfaced by the guided run.** The gate now clears any prior
  read's filter so all "could pass" rows are visible at once; and every write
  effect carries server-fresh margins, so a cleared sale flips a revealed
  negative margin positive instead of showing a stale number.

### Decisions worth remembering

- **Separate routes.** The home lives at `/`, the demo at `/scenario`; the hero
  links across. The home never mounts the engine or calls Ollama — a static
  app-shot, built from the real components, keeps it theme-aware (light + dark)
  and quota-free. (A raster screenshot couldn't invert with the theme.)
- **Gate the free input until the flow completes.** A public demo against a 3B
  with free input from the first second is a roulette — one odd answer in the
  opening fifteen seconds ruins the first impression. Releasing it only at the
  end means the visitor already understands what they're looking at, and an
  imperfect reply breaks nothing. The guided order is also what guarantees a
  stranger feels read → reversible → destructive in contrast; click "clear"
  first and the gate has no foil.
- **In-memory reset.** Northbase is a single shared mutable catalog, so the
  second visitor would otherwise inherit the first one's changes. Reset restores
  the seed (client rows immediately; the server re-seeds on the next fresh
  conversation). This changes once there's a DB with per-session isolation.

### Validation (all green)

- `tsc --noEmit` clean · `next build` clean (`/` prerendered static — no engine).
- In-browser, **light + dark**: the home (desktop + mobile, no horizontal
  overflow); the full guided flow — welcome/steps, the four steps with their
  notes, the reversible step's undo card, the gate with the control sale left
  out, **all three exits** (approve all, approve a subset, reject), the thesis
  closing, the input unlocking, and Reset returning to the guided seed.

### Next up

- Per-session isolation (a DB) would retire the shared in-memory reset and let
  many visitors run the demo at once.

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
