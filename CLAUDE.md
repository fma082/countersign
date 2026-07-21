# CLAUDE.md

Conventions and invariants for working in this repo. Read before changing code.

## The governing invariant

**The server resolves, the client reflects.**

- Counts, previews, labels, resolved targets, and margins are computed
  **server-side** and shipped as `StreamFrame`s. The client renders them
  verbatim. It never re-derives a count, re-parses a label, or reinterprets a
  tool call.
- The human approves **what the server will execute** — the resolved product
  list and the exact effect — never a client-side guess.
- `cost` and `margin` never reach the browser except through a tool that
  explicitly reveals margin. `publicProducts()` strips `cost` server-side.

If a change would move resolution to the client, it is wrong. Find another way.

## Layering (do not cross the streams)

```
provider  ──RawFrame──▶  governance (server)  ──StreamFrame──▶  client
```

- `src/lib/engine/ollama.ts` — **adapter frame**. Talks to the provider, emits
  raw frames. Knows nothing about gates, previews, or labels. Provider-agnostic
  by design: changing providers must touch nothing but this file.
- `src/app/api/copilot/route.ts` + `src/lib/engine/tools.ts` — **governance**.
  Classifies each tool call `safe | gate | invalid`, computes effects, and never
  runs a destructive op without approval.
- `src/lib/copilot-statechart.ts` — **pure statechart**. No React, no provider,
  no I/O. Effects live in `useCopilot`.

## Tokens

- **Never hardcode** a color, spacing, or radius. Route through a token utility
  (`bg-panel`, `text-ink-2`, `border-line`, …). One-offs use the CSS variable
  directly (`var(--interactive-primary)`), never a literal hex.
- Monochrome. The only chromatic tokens are desaturated red/green for
  error/success, and **color is never the only signal** — pair it with an icon
  and text.
- Light is the hero mode. The system supports light + dark; the swap is a
  runtime CSS-variable flip. See `docs/tokens-spec.md`.

## Truth in the UI

This is a project about trust. The UI must not lie:

- A tool call discarded for bad arguments shows an **`invalid`** badge, never
  `ok`. (`ToolDecision` carries `"invalid"` as a first-class outcome.)
- A destructive op shows `pending` at the gate and `ok` only **after** it runs.
- The gate's confirmation is authored by the **server**, not narrated by the
  model — a language model describing a destructive action it did not itself run
  is exactly the failure this project argues against.

## Northbase is fictional

100% fictional. No real brand, customer, dataset, or structure — not in code,
comments, or commit messages. The seeded conflicts are intentional; do not
"fix" `effectivePrice()` returning an expired `salePrice` — that legacy quirk is
the whole scenario.

## Hygiene

- `next dev` and `next build` use **separate** `distDir`s (`.next-dev` /
  `.next-build`, set in `next.config.ts`) so a mixed `.next` can't push
  Turbopack into a phantom recompilation loop. `npm run clean` removes both.
- Keep `tsc --noEmit` and `next build` clean before committing.
- Raw drops live in `_inbox/` (gitignored). Move anything real into `src/`.

## Commands

```bash
npm run dev         # dev server (distDir .next-dev)
npm run build       # production build (distDir .next-build)
npm run typecheck   # tsc --noEmit
npm run clean       # remove both distDirs
```
