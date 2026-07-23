/**
 * Provider selector — picks the adapter the governance layer talks to.
 *
 * The engine is provider-agnostic by design: every adapter (ollama, groq) emits
 * the same RawFrame contract, so the choice is a single env-driven switch made
 * once, at module load. Governance imports `streamChat`/`completeChat` from HERE
 * and never names a concrete provider.
 *
 *   MODEL_PROVIDER=ollama  → local dev (default)
 *   MODEL_PROVIDER=groq    → cloud deploy
 *
 * Adding a third provider means adding a sibling adapter and one case here —
 * governance, statechart, and UI stay untouched.
 */

import * as ollama from "./ollama";
import * as groq from "./groq";

const PROVIDER = (process.env.MODEL_PROVIDER ?? "ollama").toLowerCase();

const adapter = PROVIDER === "groq" ? groq : ollama;

export const streamChat = adapter.streamChat;
export const completeChat = adapter.completeChat;
export const MODEL = adapter.MODEL;
export const PROVIDER_LABEL = adapter.PROVIDER_LABEL;
