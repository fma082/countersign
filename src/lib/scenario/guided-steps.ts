/**
 * The four guided steps for /scenario.
 *
 * What's guided is the ORDER and the suggested prompts — never the responses.
 * Each step's `prompt` is sent to the real model; the streaming and tool calls
 * are real. The `label`/`tier` are what the visitor sees on the step button;
 * the `note` is the terse contextual signpost dropped into the log right after
 * the phenomenon is visible.
 *
 * The sequence read → read → reversible → destructive is deliberate: it lets a
 * stranger feel the three tiers in contrast, without a guide beside them.
 */

export interface GuidedStep {
  label: string; // shown on the step button
  tier: string; // the tier subtitle — announces reversible/destructive before the click
  prompt: string; // sent to the real engine
  note: string; // dropped in the log after the step (supports **bold** leads)
  /**
   * The tool this step is known to run. The model normally decides *when* to
   * call it and narrates the result; when the model is paused, the server runs
   * exactly this — real governance, real effect — so the guided flow completes
   * with or without the model. This is the "system guarantees, not the model"
   * path made concrete. It is never a fabricated answer: only a known operation.
   */
  fallback: { tool: string; args: Record<string, unknown> };
}

export const GUIDED_STEPS: GuidedStep[] = [
  {
    label: "Find products selling below cost",
    tier: "read · runs on its own",
    prompt: "How many products are selling below cost? Reveal the margin column.",
    note: "**Read.** The agent ran without asking. It also revealed a column that wasn't on screen — margin isn't stored, it's computed server-side from cost and effective price.",
    fallback: { tool: "filter_view", args: { filter: "negative_margin", reveal_margin: true } },
  },
  {
    label: "Show me what's causing it",
    tier: "read · runs on its own",
    prompt: "What is causing those negative margins? Filter the table to the products still on an expired sale.",
    note: "**Still a read.** What you see changed. What exists didn't.",
    fallback: { tool: "filter_view", args: { filter: "expired_sales" } },
  },
  {
    label: "Raise the price on the SD Card Case",
    tier: "reversible · runs, then undo",
    prompt: "Raise the price of the SD Card Case (NB-ST-6002) to $19.",
    note: "**Reversible.** One row, one field, still undoable. The undo lives on the action itself — no toast, no countdown. It stays until the next write closes the window.",
    fallback: { tool: "update_price", args: { sku: "NB-ST-6002", price: 19 } },
  },
  {
    label: "Clear all expired sale prices",
    tier: "destructive · needs approval",
    prompt: "Clear all the expired sale prices.",
    note: "**The engine is halted here.** Only you move past it — the model can't reopen or skip the gate. The resolver already left the one active sale out; unchecking anything else is your call, on context the data doesn't hold.",
    fallback: { tool: "clear_expired_sales", args: {} },
  },
];

/** The thesis, stated in full once the visitor has lived all four tiers. */
export const GUIDED_CLOSING =
  "Reads run alone. Reversible writes run, then wait. Destructive writes wait first. Friction before or friction after — never both.";

export const GUIDED_INTRO = {
  title: "Try the agent in four steps",
  sub: "The first two run on their own. The third executes but can be undone. The fourth stops and waits for you.",
};
