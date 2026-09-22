// edgelore · Agent Memory layer — trigger layer, brick #1: the event scan.
//
// One-pass summarizing extraction systematically under-reports the speaker's
// own past experiences when they arrive as asides ("by the way, I ... last
// Saturday"): the session's topic wins the attention budget and the anecdote
// vanishes — silently, leaving nothing in the store to even detect. Louder
// prompt wording does not fix this (measured across prompt generations); the
// cure is GUARANTEED ATTENTION: a deterministic pre-pass flags every user
// sentence that pairs a first-person marker with a time expression, and the
// extractor must make an explicit keep/drop decision for each flagged
// sentence. Seeing is guaranteed by code; storing still goes through the
// normal worth-storing rules (the scan widens attention, not the gate).
//
// The mechanism (candidates -> must-be-decided feed) is the permanent part.
// The sensor below is the replaceable v0 probe: a regex over CLOSED
// grammatical classes only — pronouns and time words, both finite language
// constants (date resolution already needs the time words). No topic
// vocabularies, no verb lists: those are open classes and rot. Later probes
// (a decision-layer sentence filter, a small classifier) plug into the same
// contract without touching callers.

/** One flagged sentence: the speaker reporting their own experience in time. */
export interface EventCandidate {
  /** The verbatim sentence (trimmed). */
  sentence: string;
  /** The closed-class signal that fired: a time expression, or an aside marker. */
  timeExpr: string;
}

/**
 * Upper bound on candidates fed to one extraction call. A real session never
 * approaches this; the cap only bounds the prompt against pathological
 * transcripts.
 */
export const EVENT_CANDIDATE_CAP = 40;

// --- closed-class lexicons ----------------------------------------------------
// Pronouns and time words ONLY. Time words are the same closed set the
// date-resolution rule must already understand; adding a language means
// extending these lists, never mining topic or verb vocabulary.

/** First-person markers (English contractions match via the \b around "i"). */
const FIRST_PERSON = /(?:\b(?:i|me|my|mine|myself)\b)|我|咱们|俺/iu;

/**
 * Aside markers — the canonical "incidental information" flag ("by the way,
 * I ..."). Discourse markers are a closed functional class, same standing as
 * the time words: an aside pairing with first person is a high-value
 * candidate even without an explicit time anchor.
 */
const ASIDE_MARKERS = /\b(?:by the way|btw|oh,?\s+and|before i forget)\b/iu;

/** Time expressions: absolute dates, relative words, weekday/period phrases. */
const TIME_EXPRESSIONS: readonly RegExp[] = [
  // ISO and numeric dates
  /\b\d{4}-\d{1,2}-\d{1,2}\b/,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b(?:19|20)\d{2}\b/,
  // "June 3rd" / "Jun 3" / "3rd of June" / "on 3 June"
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
  // relative words
  /\b(?:today|yesterday|tonight|recent(?:ly)?|lately|earlier|just)\b/i,
  // temporal framing: "during my last trip", "during the move"
  /\bduring\b/i,
  /\blast\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|weekend|night|summer|fall|winter|spring)\b/i,
  /\bthis\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|weekend|morning|afternoon|evening)\b/i,
  /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|weekend)\b/i,
  /\b(?:a\s+few|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:day|week|month|year|hour|minute|decade)s?\s+ago\b/i,
  /\b(?:on|in|at|since|until|by)\s+(?:the\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|morning|afternoon|evening)\b/i,
  // CJK relative words
  /昨天|前天|今天|昨晚|上周|上个?月|去年|最近|近来|刚刚|刚才|日前|上礼拜|这周|这个月|今年|明天|下周|下个?月|下礼拜|周末|上周末/u,
  /(?:星期|礼拜)[一二三四五六日天]/u,
  /\d+\s*(?:天|周|个?月|年|小时|分钟)前/u,
  /\d{4}年|\d{1,2}月\d{1,2}[日号]/u,
];

// --- transcript shaping ---------------------------------------------------------

/**
 * A user-turn line in the batch transcript format ("[user] ..."). Assistant
 * turns are skipped: their "I" is the helper's, not the speaker's biography.
 * Unmarked lines are treated as user speech — callers who pass plain text get
 * the over-inclusive default.
 */
const USER_LINE = /^\s*(?:\[(?:user|human)\]|(?:user|human)\s*[:：])\s*/i;
const ASSISTANT_LINE = /^\s*(?:\[(?:assistant|ai|bot|system)\]|(?:assistant|ai|bot|system)\s*[:：])\s*/i;

/**
 * Split one turn's text into sentence-ish units. Deliberately conservative:
 * an English period only ends a unit when plausible sentence material follows
 * (uppercase/digit/quote) — abbreviation dots ("D.C.", "e.g.") must not cut a
 * sentence in half; a too-large candidate is harmless (the extractor still
 * judges it), a too-small one is a silent loss. CJK punctuation splits
 * without whitespace.
 */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const cjkChunk of text.split(/(?<=[。！？；])|\n+/)) {
    for (const unit of cjkChunk.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“‘(\[])/)) {
      const s = unit.trim();
      if (s.length > 0) out.push(s);
    }
  }
  return out;
}

/**
 * Flag every user sentence that pairs a first-person marker with a time
 * expression or an aside marker. Order follows the transcript; capped at
 * {@link EVENT_CANDIDATE_CAP}.
 *
 * @param transcript role-prefixed session transcript ("[user] ... / [assistant] ...")
 */
export function scanEventCandidates(transcript: string): EventCandidate[] {
  const out: EventCandidate[] = [];
  for (const line of transcript.split("\n")) {
    if (ASSISTANT_LINE.test(line)) continue;
    const isUser = USER_LINE.test(line);
    const body = isUser ? line.replace(USER_LINE, "") : line;
    for (const sentence of sentences(body)) {
      if (!FIRST_PERSON.test(sentence)) continue;
      const timeExpr = TIME_EXPRESSIONS.map((r) => r.exec(sentence)?.[0] ?? "").find(Boolean);
      const aside = ASIDE_MARKERS.exec(sentence)?.[0];
      if (!timeExpr && !aside) continue;
      out.push({ sentence, timeExpr: timeExpr ?? aside ?? "" });
      if (out.length >= EVENT_CANDIDATE_CAP) return out;
    }
  }
  return out;
}
