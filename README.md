# Countersign

An AI agent operating a fictional admin panel (**Northbase**) against a real
local model, with a human checkpoint before the irreversible operations.
Countersign is a portfolio piece, not a UI kit or a pattern library.

## The thesis

> Reads run on their own. Reversible writes run, then wait. Destructive writes
> wait first. **Friction before or friction after, never both.**

The whole product is built to make that one idea legible: a person can watch an
agent read freely, act reversibly, and stop dead at the edge of anything it
cannot take back — approving *exactly* what the server will execute, resolved by
name, never a client-side reinterpretation.

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript**
- **Tailwind v4**, tokens via `@theme` in `globals.css`
- **shadcn/ui** conventions (radix base, lucide icons)
- **Inter** (400 / 500)
- **Model provider** consumed with `fetch` + `ReadableStream`, no SDK, behind a
  provider-agnostic adapter seam: **Ollama** (`llama3.2:3b`) local, **Groq**
  (`llama-3.1-8b-instant`) for the public deploy. Same family, same frame
  contract; `MODEL_PROVIDER` picks one.

Beyond the above: zero extra dependencies.

## Run it

Local dev runs against [Ollama](https://ollama.com) with the model pulled:

```bash
ollama pull llama3.2:3b     # capabilities must include "tools"
ollama serve                # http://localhost:11434

npm install
npm run dev                 # http://localhost:3000
```

Override the provider with `OLLAMA_HOST` / `OLLAMA_MODEL` if needed.

### Cloud provider (Groq)

The public deploy swaps Ollama for Groq's OpenAI-compatible API by env var — the
governance layer, statechart, and UI don't change. Set `MODEL_PROVIDER=groq` and:

| Env var                      | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `GROQ_API_KEY`               | Server-side only; never reaches the bundle.         |
| `MODEL_PROVIDER=groq`        | Selects the Groq adapter (default `ollama`).        |
| `NEXT_PUBLIC_MODEL_PROVIDER` | Cosmetic footer label only; carries no secret.      |
| `GROQ_THROTTLE_MS`           | Inter-token delay (default 28). Groq is too fast to see streaming — this restores a legible cadence. |
| `RATE_LIMIT_MAX`             | Per-IP requests per window (default 20; `<=0` off). |
| `RATE_LIMIT_WINDOW_MS`       | Rate-limit window (default 60000).                  |

On Vercel these are project env vars. `/` prerenders static and never mounts the
engine; only `/scenario` consumes the provider. See [`DEV_STATE.md`](DEV_STATE.md)
for the throttle rationale, the per-instance rate-limit limitation, and the
dignified-fallback design.

## Routes

| Route       | What it is                                                        |
| ----------- | ---------------------------------------------------------------- |
| `/`         | Home — the positioning, a static app-shot, and the pattern index. |
| `/scenario` | The demo — Northbase catalog + the copilot, guided start.         |
| `/tokens`   | Live showcase of the token system (toggle light/dark).            |

Deep-link a theme with `?theme=light` / `?theme=dark`.

## Try the scenario

`/scenario` opens **guided**: four stacked steps walk you through the tiers in
order, then free input unlocks.

1. *Find products selling below cost* → a **read** runs on its own; the hidden
   Margin column is revealed with server-computed values.
2. *Show me what's causing it* → still a **read** — what you see changes, what
   exists doesn't.
3. *Raise the price on the SD Card Case* → a **reversible** write runs, then
   waits; the undo lives on the action's card until the next write.
4. *Clear all expired sale prices* → a **destructive** write parks at the
   approval gate. The affected rows are spotlighted; the one active, valid sale
   (`NB-LT-2004`) is left out. Approve all, approve a subset (uncheck by your own
   judgment), or reject.

A closing states the thesis, free input unlocks, and Reset restores the seed.

## Architecture

Three layers, one invariant.

```
provider  ──RawFrame──▶  governance (server)  ──StreamFrame──▶  client
```

- **Adapter frame** ([`src/lib/engine/ollama.ts`](src/lib/engine/ollama.ts) ·
  [`groq.ts`](src/lib/engine/groq.ts)) — the only modules that talk to a
  provider. Each emits raw frames, ignorant of governance;
  [`provider.ts`](src/lib/engine/provider.ts) picks one by `MODEL_PROVIDER`.
  Adding a provider is a sibling adapter plus one line in the selector — nothing
  above it changes.
- **Governance** ([`src/app/api/copilot/route.ts`](src/app/api/copilot/route.ts)
  + [`tools.ts`](src/lib/engine/tools.ts)) — computes previews, labels with real
  counts, and effects. Decides safe / gate / invalid. Executes nothing
  destructive without human approval.
- **Client** — reflects StreamFrames verbatim. Never re-interprets, never
  recomputes a count, never sees `cost` or `margin` unless a tool reveals it.

**The invariant: the server resolves, the client reflects.** The human approves
what the server will execute — resolved products, real counts, declared
`targetIds` — never a string the browser had to parse.

The copilot's behavior is a pure statechart
([`copilot-statechart.ts`](src/lib/copilot-statechart.ts)), documented as a
shared design/code contract in
[`docs/statechart-copilot-chat-panel.md`](docs/statechart-copilot-chat-panel.md).

## Documentation

- [`docs/tokens-spec.md`](docs/tokens-spec.md) — the token system, source of truth.
- [`docs/statechart-copilot-chat-panel.md`](docs/statechart-copilot-chat-panel.md) — the copilot statechart.
- [`DEV_STATE.md`](DEV_STATE.md) — living log of decisions and iterations.

## A note on Northbase

Northbase and its entire catalog are **fictional**. Nothing here reflects any
real brand, customer, dataset, or system. The catalog's quirks — expired sales
that never cleared, resulting negative margins — are planted on purpose so the
agent can *discover* problems rather than be told about them.
