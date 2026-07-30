/**
 * Tool argument specs — one declaration, two consumers.
 *
 * THE SCHEMA IS DOCUMENTATION AIMED AT THE MODEL. THE VALIDATION IS THE
 * SERVER'S. A provider does not enforce the `type` it is handed: llama3.2:3b
 * sent `threshold: "50"` against `{ type: "number" }` and the call arrived
 * anyway. The same hole passes a wrong type, an out-of-range value, an enum
 * member that does not exist, or nothing at all where `required` said there
 * would be something.
 *
 * So the shape a tool accepts is declared ONCE, here, and both the JSON schema
 * the model is shown and the parser the server runs are built from it. They
 * cannot drift, because there is nothing to keep in sync. The previous
 * arrangement — a hand-written schema array next to validation scattered
 * through the tool bodies — is exactly how `where` came to be honoured on
 * `update_price`, a tool whose schema never declared it: nothing read the
 * schema at runtime, so nothing knew the argument was not part of the contract.
 *
 * The parser is liberal in what it accepts and strict about what it lets
 * execute:
 *
 *   - An argument the spec does not declare is DROPPED. It never reaches a
 *     tool body, so no body can quietly honour one.
 *   - A numeric string coerces ("50" → 50) because that is the failure real
 *     models actually produce. `true`, `[12.5]` and `{}` do not, because
 *     `Number()` turning a boolean into 1 is not a parse — it is the server
 *     inventing a value and then executing it.
 *   - An invalid argument is REFUSED, never defaulted. A read that refuses
 *     costs the human a re-ask; a write that defaults costs them a product.
 */

import type { ProviderTool } from "./types";

/** A value that survived parsing. Tool bodies see only these. */
export type ArgValue = string | number | boolean;
export type ParsedArgs = Record<string, ArgValue>;

interface Base {
  /** Shown to the model in the schema. Omitted for arguments whose name says it. */
  description?: string;
  required?: true;
  /**
   * Replaces the generated refusal for this argument. Use when the reason a
   * value is unacceptable is worth explaining in the tool result the model
   * reads back — `set_web_visible.visible` is the case that earned it.
   */
  refusal?: string;
}

export type ArgSpec =
  | (Base & { kind: "string" })
  | (Base & { kind: "enum"; values: readonly string[] })
  | (Base & { kind: "number"; min?: number; exclusiveMin?: number; integer?: true })
  | (Base & { kind: "boolean" });

interface ToolSpec {
  description: string;
  args: Record<string, ArgSpec>;
}

/**
 * Deliberately NOT in this table: whether `threshold` is required. It is
 * required for `stock_below` and meaningless for every other metric, which is a
 * fact about the metric and not about the argument's shape. `readMetric` owns
 * it and refuses with a message that names the metric. The rule of the split:
 * this layer decides whether a value is WELL-FORMED, the tool body decides
 * whether it is MEANINGFUL for what was asked.
 */
export function toolSpecs(
  metrics: readonly string[],
  selectors: readonly string[],
  presets: readonly string[],
  fields: readonly string[],
  ops: readonly string[],
): Record<string, ToolSpec> {
  return {
    query_products: {
      description:
        "Count products by a business metric and show the matching rows to the human. Read-only. You get the count and the criterion back, not the rows — the rows are displayed directly.",
      args: {
        metric: { kind: "enum", values: metrics, required: true },
        threshold: {
          kind: "number",
          exclusiveMin: 0,
          description:
            "Required when metric is stock_below: the number from the question (\"less than 50 in stock\" → 50). Copy it; never round it, never supply one the human did not give.",
        },
      },
    },

    inspect_product: {
      // The description promises exactly what comes back and no more. It used
      // to say "report its stock, reorder point, margin and sale" — and the
      // tool did hand all of that over, which is how a 28.9% margin came back
      // narrated as "$28.90". The record is shown to the human directly now,
      // so the model is told it gets the identity and not the numbers.
      description:
        "Look up ONE product by its sku and show the human its full record — price, stock, sale, margin, status. Read-only. You get the product's identity back, not its numbers: the record is displayed directly. Use this for any question about a single product (e.g. \"what is the status of NB-AU-1005?\") instead of a metric count.",
      args: {
        sku: { kind: "string", required: true, description: "The product SKU, e.g. NB-AU-1005." },
      },
    },

    // ── The two filter tools ────────────────────────────────────────────
    // They are TWO tools and not one with a `preset` OR `(field, op, value)`
    // argument, because a union argument's failure mode on a small model is
    // sending both halves or neither — the same failure `resolveTargets`
    // refuses when a write arrives with a `sku` AND a `where`. With disjoint
    // `required` sets the two cannot be mixed: a call either names a preset or
    // names a comparison, and `parseArgs` decides which before any body runs.
    //
    // They are also, together, exactly the two controls in the human's filter
    // bar. The tool surface is a subset of the human's surface: there is no
    // filter the model can apply that the bar cannot show and clear.
    filter_view: {
      description:
        "Filter the product table to a named group, so the human sees those rows and nothing else. Read-only. Pass preset: \"none\" to clear the filter and show all products. Use this for a group with a NAME; use filter_compare for a threshold on a number. You get the count and the criterion back, not the rows — the rows are displayed directly.",
      args: {
        preset: { kind: "enum", values: [...presets, "none"], required: true },
      },
    },

    filter_compare: {
      description:
        "Filter the product table by comparing ONE field against ONE number — use this for any question that names a quantity (\"less than 50 in stock\", \"under $20\", \"exactly 0 in stock\"). Read-only. Copy the number from the question; never supply one the human did not give. To clear the filter, call filter_view with preset: \"none\".",
      args: {
        field: {
          kind: "enum",
          values: fields,
          required: true,
          description: "stock = units on hand. effective_price = what the customer pays today (the sale price when one is running).",
        },
        op: {
          kind: "enum",
          values: ops,
          required: true,
          description: "lt = less than, lte = at most, gt = greater than, gte = at least, eq = exactly.",
        },
        value: {
          kind: "number",
          // `min`, not `exclusiveMin`. `stock eq 0` — "which products are out of
          // stock" — is a real question, and the old `threshold` argument's
          // exclusive bound made it unaskable.
          min: 0,
          required: true,
          description: "The number from the question (\"less than 50 in stock\" → 50).",
        },
      },
    },

    update_price: {
      description:
        "Set the regular price of ONE product (pass its sku). Reversible — runs immediately and can be undone until the next write.",
      args: {
        sku: { kind: "string", required: true, description: "The product SKU, e.g. NB-ST-6002." },
        price: { kind: "number", exclusiveMin: 0, required: true },
      },
    },

    adjust_stock: {
      description:
        "Set the stock level of ONE product (pass its sku). Reversible — runs immediately and can be undone until the next write.",
      args: {
        sku: { kind: "string", required: true },
        stock: { kind: "number", min: 0, integer: true, required: true },
      },
    },

    set_web_visible: {
      description:
        "Set the web-store visibility of ONE product (pass its sku) to an EXPLICIT value. `visible` is required: true shows it, false hides it. There is no toggle — a call without an explicit direction is rejected, never guessed. Reversible. A `where` selector matching many products becomes a batch and requires approval.",
      args: {
        sku: { kind: "string" },
        where: { kind: "enum", values: selectors },
        visible: {
          kind: "boolean",
          required: true,
          description: "Required. true = show, false = hide.",
          refusal:
            "set_web_visible needs an explicit visible: true or false. It was omitted or unclear — refusing to guess a direction.",
        },
      },
    },

    clear_expired_sales: {
      description:
        "Remove the sale price from every product whose sale has ended. DESTRUCTIVE — requires human approval.",
      args: {},
    },

    discontinue_products: {
      description:
        "Mark a set of products as discontinued (also hides them from the web store). DESTRUCTIVE — the status propagates downstream, so it requires human approval regardless of how many products match. Pass a `filter`.",
      args: {
        filter: { kind: "enum", values: selectors, required: true },
      },
    },
  };
}

// ── Schema generation (what the model is shown) ────────────────────────────
const schemaType = (spec: ArgSpec): Record<string, unknown> => {
  switch (spec.kind) {
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "string", enum: [...spec.values] };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }
};

export function buildProviderTools(specs: Record<string, ToolSpec>): ProviderTool[] {
  return Object.entries(specs).map(([name, spec]) => ({
    type: "function" as const,
    function: {
      name,
      description: spec.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(spec.args).map(([arg, a]) => [
            arg,
            { ...schemaType(a), ...(a.description ? { description: a.description } : {}) },
          ]),
        ),
        required: Object.entries(spec.args)
          .filter(([, a]) => a.required)
          .map(([arg]) => arg),
      },
    },
  }));
}

// ── Parsing (what the server enforces) ─────────────────────────────────────
/**
 * A numeric literal and nothing else. `"50"` is a model writing a number into a
 * string field — a transport slip worth absorbing. `"5e1"`, `"0x32"` and
 * `" 12 units"` are not: accepting them would mean guessing what was meant.
 */
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && NUMERIC.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** What the model actually sent, for a refusal message the human can read. */
function shown(v: unknown): string {
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `an array`;
  if (v === null) return "null";
  if (typeof v === "object") return "an object";
  return String(v);
}

const refuse = (tool: string, spec: ArgSpec, message: string) => ({
  error: spec.refusal ?? `${tool}: ${message}`,
});

function parseOne(
  tool: string,
  arg: string,
  spec: ArgSpec,
  raw: unknown,
): { value: ArgValue } | { error: string } {
  switch (spec.kind) {
    case "string": {
      if (typeof raw !== "string")
        return refuse(tool, spec, `"${arg}" must be a string — got ${shown(raw)}.`);
      const s = raw.trim();
      if (!s) return refuse(tool, spec, `"${arg}" was empty.`);
      return { value: s };
    }

    case "enum": {
      // Trimmed before matching: a stray space is a transport slip, not a
      // different criterion. Anything outside the list is refused with the list
      // — never mapped to a neighbour, never defaulted.
      const s = typeof raw === "string" ? raw.trim() : "";
      if (!spec.values.includes(s))
        return refuse(
          tool,
          spec,
          `"${arg}" must be one of ${spec.values.join(", ")} — got ${shown(raw)}.`,
        );
      return { value: s };
    }

    case "number": {
      const n = toNumber(raw);
      if (n === undefined)
        return refuse(tool, spec, `"${arg}" must be a number — got ${shown(raw)}.`);
      if (spec.integer && !Number.isInteger(n))
        return refuse(tool, spec, `"${arg}" must be a whole number — got ${n}.`);
      if (spec.exclusiveMin !== undefined && n <= spec.exclusiveMin)
        return refuse(tool, spec, `"${arg}" must be greater than ${spec.exclusiveMin} — got ${n}.`);
      if (spec.min !== undefined && n < spec.min)
        return refuse(tool, spec, `"${arg}" must be at least ${spec.min} — got ${n}.`);
      return { value: n };
    }

    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      // The string forms only. A number is NOT a direction: `visible: 1` reads
      // as "show" to a human and as nothing in particular to this server.
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return refuse(tool, spec, `"${arg}" must be true or false — got ${shown(raw)}.`);
    }
  }
}

/**
 * Parse a tool call's arguments against its spec.
 *
 * Iterates the SPEC, never the input — so an argument the tool does not declare
 * has no path into the result. That is the structural half of the fix: it is not
 * that the bodies now ignore `where` on `update_price`, it is that they never
 * receive it.
 */
export function parseArgs(
  tool: string,
  specs: Record<string, ToolSpec>,
  raw: Record<string, unknown>,
): { args: ParsedArgs } | { error: string } {
  const spec = specs[tool];
  if (!spec) return { error: `Unknown tool "${tool}".` };

  const args: ParsedArgs = {};
  for (const [arg, argSpec] of Object.entries(spec.args)) {
    const value = raw[arg];
    if (value === undefined || value === null || value === "") {
      if (argSpec.required)
        return {
          error: argSpec.refusal ?? `${tool} needs "${arg}" — it was not provided.`,
        };
      continue;
    }
    const parsed = parseOne(tool, arg, argSpec, value);
    if ("error" in parsed) return parsed;
    args[arg] = parsed.value;
  }
  return { args };
}
