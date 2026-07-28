/**
 * Does the user's phrasing still say anything the criterion label doesn't?
 *
 * `interpreted from: "…"` exists to mark the gap between what the human ASKED
 * and what the server RAN. Shown on every read it stops marking anything: the
 * common case is
 *
 *     3 products selling below cost
 *     interpreted from: "products selling below cost"
 *
 * — the same sentence twice, at the same weight. Repetition spends the
 * subtitle's whole signal, so the one that matters,
 *
 *     13 products below their reorder point
 *     interpreted from: "products less than 50 are in Stock"
 *
 * arrives looking exactly like the noise around it. A reinterpretation the
 * human is meant to catch has to LOOK different from a restatement.
 *
 * The rule is set containment on content words, and deliberately not a
 * similarity score: a threshold would have to be tuned, could not be explained
 * on the screen it governs, and would make "did the system reinterpret me?"
 * — a yes/no question — answerable only in degrees.
 *
 *     Omit the subtitle when one word set contains the other. Otherwise show it.
 *
 * The decision is the server's, taken while building the renderPayload: an
 * omitted `userIntent` is simply absent from the frame. The component is not
 * touched — it already renders the subtitle only when the field arrives with
 * content ("optional by design, not a fallback"), so this reuses that path
 * rather than adding a second way to hide the same line.
 */

/**
 * Words that carry no criterion. Articles, prepositions, conjunctions,
 * auxiliaries, and the question/deixis scaffolding a request is wrapped in.
 * Everything else — nouns, adjectives, verbs, numbers — is content and is
 * compared.
 *
 * The list is English only, and that is the right failure: a Spanish intent
 * against an English label shares no content words, so it never contains and is
 * never contained, and the subtitle shows. Which is correct — the executed
 * criterion really is worded differently from what the human typed.
 */
const STOPWORDS = new Set([
  // articles + determiners
  "a", "an", "the", "this", "that", "these", "those", "any", "some", "all",
  "each", "every", "no", "my", "our", "your", "their", "its", "his", "her",
  // prepositions + conjunctions
  "of", "in", "on", "at", "to", "for", "from", "by", "with", "without",
  "into", "over", "under", "below", "above", "than", "as", "and", "or", "but",
  "up", "out", "off",
  // auxiliaries + copulas
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "has", "have", "had", "can", "could", "will", "would", "should", "may",
  // question + request scaffolding
  "what", "whats", "which", "who", "how", "many", "much", "show", "me", "give",
  "list", "tell", "there", "i", "you", "we", "it", "please",
]);

/**
 * Lowercase, drop punctuation, split on whitespace, keep the content words.
 * Numbers survive — "50" is the whole difference between "less than 50 are in
 * Stock" and "below their reorder point".
 */
export function contentTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    // Apostrophes close up ("what's" → "whats"); every other separator becomes
    // a space, so "less-than-50" tokenizes the same as "less than 50".
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9áéíóúüñ]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => {
  for (const t of a) if (!b.has(t)) return false;
  return true;
};

/**
 * True when the intent adds nothing to the label — identical word sets, or one
 * contained in the other. An intent that reduces to no content words at all is
 * redundant by the same rule (the empty set is contained in everything), which
 * is what we want: "show me the list" restates nothing.
 */
export function isRedundantIntent(userIntent: string, criterionLabel: string): boolean {
  const intent = contentTokens(userIntent);
  const label = contentTokens(criterionLabel);
  return isSubset(intent, label) || isSubset(label, intent);
}

/**
 * Filler a small model types into an optional string field instead of leaving
 * it out — the same habit `resolveTargets` already guards against for `sku`.
 * `interpreted from: "none"` was observed live: a placeholder printed under the
 * header in the position reserved for the human's own words. A lone filler
 * token is an omission, not a phrasing.
 *
 * Only the WHOLE string counts. "all products on an expired sale" is a real
 * intent; "all" is not.
 */
const PLACEHOLDERS = new Set([
  "none", "null", "undefined", "empty", "unknown", "n/a", "na", "any", "all", "-",
]);

/**
 * The subtitle a renderPayload should carry, if any. Returns `undefined` for an
 * absent, empty, placeholder, or redundant intent — one gate, so a caller
 * cannot include the field by a path that skipped a check.
 */
export function subtitleIntent(
  userIntent: string | undefined,
  criterionLabel: string,
): string | undefined {
  if (!userIntent) return undefined;
  if (PLACEHOLDERS.has(userIntent.trim().toLowerCase().replace(/[.!?]+$/, ""))) return undefined;
  return isRedundantIntent(userIntent, criterionLabel) ? undefined : userIntent;
}
