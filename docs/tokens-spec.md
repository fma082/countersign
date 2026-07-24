# Token system — source of truth

Countersign is monochrome. There is **no brand color**. The only chromatic
tokens are desaturated red / green / amber, reserved for error, success, and
warning (e.g. a discontinued product), and even those never carry meaning
alone — they are always paired with an icon and text.

The system has two layers. Nothing in a component may hardcode a color,
spacing, or radius; everything routes through a token.

The implementation lives in [`src/app/globals.css`](../src/app/globals.css). If
this document and that file disagree, both are wrong — fix them together.

---

## Layer 1 — Primitives

Raw constants. They **do not change between light and dark**. They are the
palette from which the semantic layer is composed.

### Warm neutral scale

| Token  | Hex       |
| ------ | --------- |
| `n0`   | `#FFFFFF` |
| `n50`  | `#F6F5F2` |
| `n100` | `#EDEBE6` |
| `n200` | `#DEDBD3` |
| `n400` | `#A3A099` |
| `n600` | `#6B6862` |
| `n700` | `#3A3835` |
| `n800` | `#2A2926` |
| `n900` | `#1C1B18` |
| `n975` | `#0C0C0B` |

### State (error / success / warning)

| Token       | Hex       |
| ----------- | --------- |
| `red-600`   | `#B4443C` |
| `red-400`   | `#D98A82` |
| `green-600` | `#4A7A56` |
| `green-400` | `#8FB89A` |
| `amber-600` | `#B4863C` |
| `amber-400` | `#D9B37F` |

### Non-color primitives

| Token      | Value                            |
| ---------- | -------------------------------- |
| `--radius` | `8px`                            |
| `--ease`   | `cubic-bezier(0.2, 0.8, 0.2, 1)` |

---

## Layer 2 — Semantic

Semantic tokens **alias** primitives and **flip** between modes. They are
defined twice: once under `:root` (light) and once under `.dark`. The swap is
done purely by redefining these variables — utilities reference the variables,
so the mode inverts at runtime without recompiling.

**Light is the hero mode.** It is the default; dark is the inversion.

| Semantic token        | Utility             | Light       | Dark        |
| --------------------- | ------------------- | ----------- | ----------- |
| `surface/page`        | `bg-page`           | `n50`       | `n975`      |
| `surface/panel`       | `bg-panel`          | `n0`        | `n900`      |
| `surface/sub`         | `bg-sub`            | `n100`      | `n800`      |
| `surface/input`       | `bg-field`          | `n50`       | `n800`      |
| `text/primary`        | `text-ink`          | `n900`      | `n50`       |
| `text/secondary`      | `text-ink-2`        | `n600`      | `n400`      |
| `text/tertiary`       | `text-ink-3`        | `n400`      | `n600`      |
| `text/on-action`      | `text-on-action`    | `n0`        | `n900`      |
| `interactive/primary` | `bg-action` / `text-action` | `n900` | `n0`   |
| `border/default`      | `border-line`       | `n200`      | `n700`      |
| `border/strong`       | `border-line-strong`| `n400`      | `n600`      |
| `text/error`          | `text-error`        | `red-600`   | `red-400`   |
| `text/success`        | `text-success`      | `green-600` | `green-400` |
| `text/warning`        | `text-warning`      | `amber-600` | `amber-400` |

> The CSS variables keep the **spec names** (`--surface-panel`, `--text-primary`,
> …) so they read clearly in DevTools. `@theme inline` maps them to the
> ergonomic **utility names** above. Utilities carry the `var()` reference (not a
> baked value), which is what makes `.dark` flip everything live.

---

## Runtime swap — how it works

1. Primitives are declared once under `:root`.
2. Semantic tokens are declared under `:root` (light) and re-declared under
   `.dark` (dark), pointing at different primitives.
3. `@theme inline { --color-*: var(--semantic-*) }` generates Tailwind color
   utilities that **reference** the semantic variables rather than resolving
   them at build time.
4. Toggling the `.dark` class on `<html>` re-points every semantic variable, and
   every utility updates in place. No recompile, no reload.

The theme is set before first paint by an inline script in
[`layout.tsx`](../src/app/layout.tsx) (stored preference, else OS setting), and
toggled at runtime by [`ThemeToggle`](../src/components/theme-toggle.tsx).

Browse them live at `/tokens`.

---

## Rules

- **Never hardcode** a color, spacing, or radius in a component. Route through a
  token utility (or, for one-offs like the gate's inset target bar,
  `var(--interactive-primary)` directly — still the token, never a literal hex).
- **Color is never the only signal.** Error and success states pair the color
  token with an icon and text (e.g. the `invalid` tool badge, the below-cost
  margin cell, the gate's warning rows).
- **State color is rationed.** Red, green, and amber appear only for
  error / success / warning (warning e.g. a discontinued product). Everything
  else — including the live engine-status dot — stays neutral.
