/**
 * Recorded pattern scripts for the landing-page demos.
 *
 * Each script is a `ReplayDriver`: given a request body it returns the exact
 * `StreamFrame`s the governance server emitted for that step, with the pauses
 * between them. The frames are the server's own output — the counts, the gate
 * title, the resolved targets are all computed server-side and recorded here
 * verbatim. The client still only reflects them. A scripted panel does not
 * re-derive anything a live one wouldn't; it just reads from tape.
 *
 * Northbase is fictional; these products are the three ACTIVE rows hidden from
 * the web store in the seed catalog — exactly what `discontinue_products` with
 * the `hidden` filter resolves to.
 */
import type { GateItem, StreamFrame } from "@/lib/engine/types";
import type { ReplayDriver, ReplayStep } from "@/components/copilot/use-copilot";

// ── Pattern 04 — Human-in-the-Loop Approval (the wedge) ─────────────────────

export const WEDGE_PROMPT = "Discontinue the products hidden from the web store";

/** The server-resolved gate targets: active + not web-visible. */
const HIDDEN_ITEMS: GateItem[] = [
  { sku: "NB-LT-2005", name: "Gel Filter Pack", detail: "stock 140 · $22.00", warn: true },
  { sku: "NB-PW-4005", name: "Inline Voltage Meter", detail: "stock 96 · $31.00", warn: true },
  { sku: "NB-ST-6004", name: "Archival Disc Spindle", detail: "stock 158 · $27.00", warn: true },
];

const HIDDEN_IDS = HIDDEN_ITEMS.map((it) => it.sku);

const discontinueMutation = (sku: string) =>
  ({ sku, status: "discontinued" as const, webVisible: false, lastUpdated: "2026-01-31" });

/** The opening turn: an honest lead-in, then the destructive call halts at the gate. */
const WEDGE_OPENING: ReplayStep[] = [
  { frame: { type: "token", text: "Those three are active but hidden from the web store. " }, delay: 240 },
  { frame: { type: "token", text: "Discontinuing them is destructive, so it needs your sign-off:" }, delay: 320 },
  {
    delay: 420,
    frame: {
      type: "gate",
      gate: {
        id: "gate_wedge",
        tool: "discontinue_products",
        title: "Discontinue 3 products",
        description:
          "Marks each product as discontinued and drops it from the web store. The status propagates downstream, so this is destructive regardless of count.",
        targetIds: HIDDEN_IDS,
        items: HIDDEN_ITEMS,
      },
    },
  },
];

/** The post-approval turn: run what the human let through, then settle. */
function wedgeApproval(excludedIds: string[]): ReplayStep[] {
  const survivors = HIDDEN_IDS.filter((sku) => !excludedIds.includes(sku));
  const n = survivors.length;
  const summary = `Discontinued ${n} product${n === 1 ? "" : "s"}.`;
  const okFrame: StreamFrame = {
    type: "tool",
    event: {
      id: "ev_wedge_ok",
      name: "discontinue_products",
      decision: "gate",
      badge: "ok",
      summary,
      args: { filter: "hidden" },
      targetIds: survivors,
      ...(excludedIds.length ? { excluded: excludedIds } : {}),
    },
  };
  return [
    { frame: { type: "effect", effect: { mutations: survivors.map(discontinueMutation) } }, delay: 260 },
    { frame: okFrame, delay: 120 },
    { frame: { type: "done" }, delay: 160 },
  ];
}

export const wedgeReplay: ReplayDriver = (body) => {
  if (body.action === "approve") {
    const excluded = Array.isArray(body.excludedIds) ? (body.excludedIds as string[]) : [];
    return wedgeApproval(excluded);
  }
  return WEDGE_OPENING;
};
