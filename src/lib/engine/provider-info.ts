/**
 * Display-only provider identity for the composer footer. Safe to import from
 * client and server.
 *
 * The real provider is chosen server-side by `MODEL_PROVIDER` (see
 * `provider.ts`) and never leaks a key to the browser. This label is cosmetic,
 * so it reads a PUBLIC mirror of the same choice — `NEXT_PUBLIC_MODEL_PROVIDER`,
 * inlined at build time — to keep the footer honest about what's answering.
 */
const PROVIDER = (process.env.NEXT_PUBLIC_MODEL_PROVIDER ?? "ollama").toLowerCase();

const GROQ = PROVIDER === "groq";

export const PROVIDER_LABEL = GROQ ? "Groq" : "Ollama";
export const MODEL_LABEL = GROQ ? "llama-3.1-8b-instant" : "llama3.2:3b";
