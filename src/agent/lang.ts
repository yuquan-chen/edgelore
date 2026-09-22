// edgelore · Agent Memory layer — language pinning, code-level (the honest
// successor to prompt wording, which failed: models drift a session's
// language at double-digit rates no matter what the rules say).
//
// The contract "record facts in the speaker's language" is only real if code
// enforces it: statements stored in a language the user never spoke are
// corrupt data — later retrieval in the user's language misses them, and the
// answering layer mirrors their language back. This module provides:
//   - detectLang: a CONFIDENT-ONLY label for one snippet (null = ambiguous —
//     noun phrases, proper nouns, numbers; ambiguous values always pass);
//   - dominantLang: the same engine over a whole transcript (the expected
//     language);
//   - filterByLanguage: drop confident mismatches, keep everything else.
//
// Signals are CLOSED word classes only — function words and diacritics, the
// same standing as triggers.ts's lexicons. No topic vocabulary. Thresholds
// are deliberately conservative (≥2 signals, 2:1 dominance): a false drop
// loses a fact forever, a false keep only adds a foreign sentence.

/** Languages this module distinguishes confidently. */
export type Lang = "zh" | "en" | "es";

const CJK_CHARS = /[一-鿿]/g;

/** High-frequency Spanish function words + grammatical particles. */
const ES_WORDS =
  /\b(?:el|la|los|las|un|una|unos|unas|de|del|al|y|o|en|que|es|son|está|están|fue|era|ser|para|por|con|como|más|pero|porque|cuando|también|ya|muy|sin|sobre|entre|hasta|desde|mi|mis|su|sus|se|le|les|nos|ha|han|había|años|año|día)\b/giu;

/** High-frequency English function words. */
const EN_WORDS =
  /\b(?:the|and|or|of|to|in|on|at|for|with|is|are|was|were|be|been|am|i|you|he|she|it|we|they|my|your|his|her|its|our|their|this|that|these|those|have|has|had|do|does|did|not|no|but|from|will|would|can|could|should|if|then|than|so|about|there|just|very)\b/giu;

/** Spanish-specific diacritics — each occurrence is a strong signal (×2 weight). */
const ES_DIACRITICS = /[ñáéíóúü¿¡]/g;

/** CJK dominance needs only a small absolute count plus a modest share. */
function isChineseDominated(text: string): boolean {
  const cjk = (text.match(CJK_CHARS) ?? []).length;
  if (cjk < 4) return false;
  const letters = text.replace(/[^A-Za-z一-鿿]/g, "").length;
  return letters === 0 || cjk / letters >= 0.15;
}

interface MarkerScore {
  chinese: boolean;
  es: number;
  en: number;
}

function scoreMarkers(text: string): MarkerScore {
  const es =
    (text.match(ES_WORDS) ?? []).length + 2 * (text.match(ES_DIACRITICS) ?? []).length;
  const en = (text.match(EN_WORDS) ?? []).length;
  return { chinese: isChineseDominated(text), es, en };
}

/**
 * Confident language label for a snippet, or null when the signal is weak
 * (pure numbers, proper-noun strings, mixed short fragments). Null always
 * passes the filter — only confident mismatches are dropped.
 */
export function detectLang(text: string): Lang | null {
  const s = scoreMarkers(text);
  if (s.chinese) return "zh";
  if (s.es >= 2 && s.es > s.en * 2) return "es";
  if (s.en >= 2 && s.en > s.es * 2) return "en";
  return null;
}

/**
 * The expected language of a transcript (whole-text signal; sessions carry
 * plenty). Null = cannot tell — callers must then skip enforcement.
 */
export function dominantLang(transcript: string): Lang | null {
  return detectLang(transcript);
}

/** Result of {@link filterByLanguage}. */
export interface LanguageFilterResult<T> {
  /** Items whose language matches (or is ambiguous — kept). Order preserved. */
  keep: T[];
  /** Items confidently written in a language OTHER than the expected one. */
  dropped: T[];
}

/**
 * Keep items whose text is the expected language (or ambiguous); drop only
 * confident foreign-language items. Non-string payloads (bare numbers) and
 * null detections always pass.
 *
 * @param items arbitrary entries
 * @param textOf the entry's natural-language payload (the statement value)
 * @param expected the transcript's dominant language
 */
export function filterByLanguage<T>(
  items: readonly T[],
  textOf: (item: T) => unknown,
  expected: Lang,
): LanguageFilterResult<T> {
  const keep: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const text = textOf(item);
    const lang = typeof text === "string" ? detectLang(text) : null;
    if (lang === null || lang === expected) keep.push(item);
    else dropped.push(item);
  }
  return { keep, dropped };
}
