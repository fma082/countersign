"use client";

import type { DetailField, ProductDetail, RenderPayload } from "@/lib/engine/types";

/**
 * `product_detail` — the render half of `inspect_product`, and the second
 * component in the generative-UI vocabulary.
 *
 * The list answers "which ones"; this answers "what is true about this one".
 * So there is no ratio bar here: a bar exists to be compared against the bar
 * above it, and a card of one product has nothing to compare with. What the
 * card owes instead is completeness — the record, with every field the server
 * resolved, in the server's own formatting.
 *
 * THE ONE THING THIS COMPONENT DOES: it renders three field states differently,
 * and it does not decide which is which.
 *
 *   present         label + value.
 *   not-applicable  nothing. The row is not rendered at all.
 *   missing         label + "not available".
 *
 * The distinction between the last two is the point of the component, not a
 * detail of it. A product with no sale and a product whose sale price failed to
 * load both arrive as "no number", and drawn the same way they read the same
 * way — as the system being vague. Drawn differently, one of them disappears
 * (there was never a question) and the other says out loud what it does not
 * know. Only the server can tell them apart, so only the server does; see
 * `FieldState`.
 *
 * "not available" is words, not a dash. A dash is what a careless renderer
 * leaves behind and a human reads it as the agent losing track. A sentence is
 * something the system chose to say.
 */

export function ProductDetail({ payload }: { payload: RenderPayload }) {
  const d = payload.data as ProductDetail | undefined;
  if (!d?.fields) return null;

  // Rows are dropped HERE, not upstream: the payload still carries every
  // `not-applicable` field, because what the server decided about a field is
  // part of the record even when the answer is "this one does not apply".
  const rows = d.fields.filter((f) => f.state !== "not-applicable");
  const discontinued = d.status === "discontinued";

  return (
    // `shrink-0` for the same reason as `product_list`: this card sets
    // `overflow-hidden` to clip its rows under the rounded corners, which
    // forfeits the automatic minimum size that stops a flex item being crushed.
    <div className="shrink-0 overflow-hidden rounded-token border border-line bg-panel">
      <header className="border-b border-line px-3.5 py-3">
        <div className="flex items-start gap-1.5">
          <h3 className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{d.name}</h3>
          {/* Only `discontinued` earns a badge. An "active" chip next to a
              "Status · active" row two lines below would be the same fact at
              two weights — and the row is the record, so the badge is reserved
              for the state that changes how you read everything under it. */}
          {discontinued && (
            <span className="mt-px flex-none whitespace-nowrap rounded-full border border-line px-1.5 py-0.5 text-[10px] leading-tight text-ink-2">
              discontinued
            </span>
          )}
        </div>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink-3">
          {d.sku} · {d.category}
        </p>
      </header>

      <dl>
        {rows.map((f) => (
          <Row key={f.key} field={f} />
        ))}
      </dl>
    </div>
  );
}

function Row({ field: f }: { field: DetailField }) {
  return (
    // The label gives way, never the value: a truncated number is a wrong
    // number, and at 379px something has to yield.
    <div className="flex items-baseline gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
      <dt className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{f.label}</dt>
      <dd className="flex-none text-right">
        {f.state === "present" ? (
          // Mono, because every value in this card is a datum and they should
          // line up down the right edge as one column.
          <span className="font-mono text-[12px] text-ink">{f.value}</span>
        ) : (
          // Deliberately NOT mono and deliberately not a dash: this is the
          // system speaking, not a value. It should not look like data.
          <span className="text-[12px] italic text-ink-3">not available</span>
        )}
      </dd>
    </div>
  );
}
