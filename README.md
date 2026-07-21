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
- **Ollama** (`llama3.2:3b`) consumed with `fetch` + `ReadableStream`. No SDK.

Beyond the above: zero extra dependencies.

## Run it

You need [Ollama](https://ollama.com) running locally with the model pulled:

```bash
ollama pull llama3.2:3b     # capabilities must include "tools"
ollama serve                # http://localhost:11434

npm install
npm run dev                 # http://localhost:3000
```

Override the provider with `OLLAMA_HOST` / `OLLAMA_MODEL` if needed.

## Routes

| Route       | What it is                                                   |
| ----------- | ------------------------------------------------------------ |
| `/`         | Placeholder home (the real home ships in a later iteration). |
| `/scenario` | The demo — Northbase catalog + the copilot.                  |
| `/tokens`   | Live showcase of the token system (toggle light/dark).       |

Deep-link a theme with `?theme=light` / `?theme=dark`.

## Try the scenario

In the copilot panel:

1. *"How many products are on an expired sale?"* → a **read** runs on its own.
2. *"Filter to the ones below cost and show margin"* → a reversible **view**
   change; the hidden Margin column is revealed with server-computed values.
3. *"Clean up the expired sales"* → a **destructive** write parks at the
   approval gate. The six affected rows are spotlighted in the table; the one
   active, valid sale (`NB-LT-2004`) is left out. Approve applies it; Reject
   changes nothing.

## Architecture

Three layers, one invariant.

```
provider  ──RawFrame──▶  governance (server)  ──StreamFrame──▶  client
```

- **Adapter frame** ([`src/lib/engine/ollama.ts`](src/lib/engine/ollama.ts)) —
  the only module that talks to Ollama. Emits raw frames, ignorant of
  governance. Swapping providers means rewriting this file only.
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
