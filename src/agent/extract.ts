// edgelore · Agent Memory layer — extract (candidates -> structured entries).
//
// Stage 2 of the two-stage pipeline (docs/agent-memory-design.md §4.2): map
// the gate's candidate fragments onto dimensions and produce CaptureContent.
// The output is ONLY candidates for the storage layer — the runtime injects
// provenance and calls capture; this module never touches the graph.
//
// Code-level guards back the prompt rules: a dimensionKey must be a known key
// or NEW:lowerCamelCase (the NEW: protocol prefix is stripped here — capture
// never sees it), and every content must carry a value.

import type { CaptureContent } from "./capture.js";
import { AgentError } from "./errors.js";
import { detectLang, dominantLang, type Lang } from "./lang.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import { buildExtractPrompt, type KnownDimension } from "./prompt.js";

const NEW_PREFIX = "NEW:";
const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
/** Bare number without leading zeros: "5000", "99.5", "-3" — never "007". */
const BARE_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Input for {@link runExtract}. */
export interface ExtractInput {
  /** The full conversation turn the candidates were drawn from. */
  text: string;
  /** Verbatim fragments produced by the gate (empty -> NOOP, driver skipped). */
  candidates: string[];
  /** Dimension slots read from the graph by the runtime. */
  knownDimensions: KnownDimension[];
  /** Dimensions that own the retrieved context — if a candidate is the SAME
   * slot, their key MUST be reused instead of minting a NEW one. */
  similarDimensions?: KnownDimension[];
  /** Relevant stored memories, for judging duplicates / contradictions. */
  contextMemories: string[];
  /** The LLM driver (MockDriver in tests). */
  driver: LlmDriver;
  /** Extra scenario fragments appended to the base prompt (§4.3). */
  extraFragments?: readonly string[];
}

/** The extractor's verdict on one turn's candidates. */
export interface ExtractResult {
  /** NOOP = nothing worth storing; STORE = one or more CaptureContents. */
  action: "NOOP" | "STORE";
  /** Structured memory candidates (one per candidate fact, order preserved). */
  contents?: CaptureContent[];
  /** Short reason, mainly for debugging / the NOOP path. */
  reason?: string;
}

/**
 * Run the extractor: map candidate facts onto dimensions.
 *
 * @param input the turn, gate candidates, dimension slots, context, and driver
 * @returns NOOP or STORE with the structured contents
 * @throws AgentError if the reply is not valid JSON, a dimensionKey is neither
 *   known nor NEW:lowerCamelCase, a content lacks a value, or
 *   cardinality/unit violate their contract
 */
export async function runExtract(input: ExtractInput): Promise<ExtractResult> {
  // Cheap short-circuit: no candidates -> no model call (frozen decision:
  // the pipeline must stay cheap for empty gate results).
  if (input.candidates.length === 0) {
    return { action: "NOOP", reason: "no candidates to extract" };
  }
  const knownKeys = new Set(input.knownDimensions.map((d) => d.key));
  const reply = await input.driver.complete(
    buildExtractPrompt({
      text: input.text,
      candidates: input.candidates,
      knownDimensions: input.knownDimensions,
      similarDimensions: input.similarDimensions,
      contextMemories: input.contextMemories,
      extraFragments: input.extraFragments,
    }),
  );
  const parsed = parseJsonReply(reply) as Record<string, unknown>;
  if (!Array.isArray(parsed.contents)) {
    throw new AgentError('extract reply field "contents" must be an array');
  }
  const contents = parsed.contents.map((raw) => toCaptureContent(raw, knownKeys));
  const kept = keepInSessionLanguage(contents, input.text);
  if (kept.length === 0) {
    return {
      action: "NOOP",
      reason:
        contents.length === 0
          ? "extractor produced no entries"
          : "every entry was written in a foreign language",
    };
  }
  return { action: "STORE", contents: kept };
}

/**
 * Language pinning, enforced (not just prompted): statements in a language
 * the speaker never used are corrupt data — drop confident mismatches before
 * they reach the graph. Ambiguous payloads (numbers, proper-noun strings)
 * always pass; enforcement only fires when BOTH the turn's language and the
 * entry's language are confidently known and differ.
 */
function keepInSessionLanguage(contents: CaptureContent[], turnText: string): CaptureContent[] {
  const expected: Lang | null = dominantLang(turnText);
  if (expected === null) return contents;
  return contents.filter((c) => {
    if (typeof c.value !== "string") return true;
    const lang = detectLang(c.value);
    return lang === null || lang === expected;
  });
}

/**
 * Narrow one raw reply entry into a CaptureContent, enforcing the key/value
 * contract and stripping the NEW: protocol prefix.
 */
function toCaptureContent(raw: unknown, knownKeys: ReadonlySet<string>): CaptureContent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentError("extract reply: each content must be a JSON object");
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.dimensionKey !== "string" || entry.dimensionKey.length === 0) {
    throw new AgentError('extract reply: content.dimensionKey must be a non-empty string');
  }
  if (entry.value === undefined || entry.value === null) {
    throw new AgentError(`extract reply: content "${entry.dimensionKey}" is missing a value`);
  }

  let dimensionKey = entry.dimensionKey;
  if (dimensionKey.startsWith(NEW_PREFIX)) {
    const key = dimensionKey.slice(NEW_PREFIX.length);
    if (!LOWER_CAMEL_CASE.test(key)) {
      throw new AgentError(`extract reply: "${entry.dimensionKey}" is not NEW:lowerCamelCase`);
    }
    dimensionKey = key;
  } else if (!knownKeys.has(dimensionKey)) {
    // Anti-drift alias guard v0: the model often forgets the NEW: prefix or
    // shortens a known key ("budget" vs "budgetCap"). If the unknown key is a
    // PREFIX of (or extends) exactly one known key, map it there. Anything
    // else fails loud — synonyms need an explicit alias table (deferred).
    const prefixMatches = [...knownKeys].filter(
      (k) => k.startsWith(dimensionKey) || dimensionKey.startsWith(k),
    );
    if (prefixMatches.length === 1) {
      dimensionKey = prefixMatches[0];
    } else if (prefixMatches.length > 1) {
      throw new AgentError(
        `extract reply: dimensionKey "${dimensionKey}" ambiguously matches known keys: ${prefixMatches.join(", ")}`,
      );
    } else {
      throw new AgentError(
        `extract reply: dimensionKey "${dimensionKey}" is neither a known dimension nor NEW:lowerCamelCase`,
      );
    }
  }

  const content: CaptureContent = { dimensionKey, value: normalizeNumericValue(entry.value) };
  applyOptionalContentFields(content, entry);
  return content;
}

/**
 * Fill the optional entry fields (dimensionDescription / cardinality / unit /
 * saidBy) onto a CaptureContent, validating each. Shared by the strict
 * per-turn narrow ({@link toCaptureContent}) and the lenient batch narrow
 * ({@link normalizeBatchContents}) so the two paths cannot drift apart.
 */
function applyOptionalContentFields(content: CaptureContent, entry: Record<string, unknown>): void {
  const label = content.dimensionKey;
  if (entry.dimensionDescription !== undefined) {
    if (typeof entry.dimensionDescription !== "string" || entry.dimensionDescription.trim().length === 0) {
      throw new AgentError(
        `extract reply: content "${label}" dimensionDescription must be a non-empty string`,
      );
    }
    content.description = entry.dimensionDescription.trim();
  }
  if (entry.cardinality !== undefined) {
    if (entry.cardinality !== "single" && entry.cardinality !== "multi") {
      throw new AgentError(
        `extract reply: content "${label}" cardinality must be "single" or "multi"`,
      );
    }
    content.cardinality = entry.cardinality;
  }
  if (entry.unit !== undefined) {
    if (typeof entry.unit !== "string" || entry.unit.length === 0) {
      throw new AgentError(`extract reply: content "${label}" unit must be a non-empty string`);
    }
    content.unit = entry.unit;
  }
  if (entry.saidBy !== undefined) {
    if (entry.saidBy !== "user" && entry.saidBy !== "assistant") {
      throw new AgentError(
        `extract reply: content "${label}" saidBy must be "user" or "assistant", got: ${JSON.stringify(entry.saidBy)}`,
      );
    }
    content.saidBy = entry.saidBy;
  }
}

/** Result of {@link normalizeBatchContents}. */
export interface BatchNormalizeResult {
  /** Valid entries, order preserved (malformed entries are skipped, not fatal). */
  contents: CaptureContent[];
  /** How many entries were dropped for being malformed (missing key/value,
   * malformed key). One bad entry must not cost a whole session's harvest. */
  skipped: number;
}

/** Fully normalized session-level extraction, including enforced decisions for
 * deterministic event-scan candidates. */
export interface BatchExtractionNormalizeResult extends BatchNormalizeResult {
  eventKept: number;
  eventDropped: number;
}

/**
 * Validate the batch extraction reply as one auditable contract. General facts
 * remain lenient, but every event-scan candidate must have exactly one explicit
 * keep/drop decision. A kept event carries its own fact object, so it cannot be
 * silently displaced by the general max-facts budget.
 */
export function normalizeBatchExtractionReply(
  raw: unknown,
  expectedEventCount: number,
  knownKeys?: ReadonlySet<string>,
): BatchExtractionNormalizeResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentError("batch extraction reply must be a JSON object");
  }
  const reply = raw as Record<string, unknown>;
  const general = normalizeBatchContents(Array.isArray(reply.contents) ? reply.contents : [], knownKeys);
  if (expectedEventCount === 0) {
    return { ...general, eventKept: 0, eventDropped: 0 };
  }
  if (!Array.isArray(reply.eventDecisions)) {
    throw new AgentError("batch extraction reply must include eventDecisions");
  }

  const expected = new Set(
    Array.from({ length: expectedEventCount }, (_, index) => `E${index + 1}`),
  );
  const seen = new Set<string>();
  const eventContents: CaptureContent[] = [];
  let eventKept = 0;
  let eventDropped = 0;
  for (const rawDecision of reply.eventDecisions) {
    if (typeof rawDecision !== "object" || rawDecision === null || Array.isArray(rawDecision)) {
      throw new AgentError("eventDecisions entries must be objects");
    }
    const decision = rawDecision as Record<string, unknown>;
    const eventId = decision.eventId;
    if (typeof eventId !== "string" || !expected.has(eventId)) {
      throw new AgentError(`eventDecisions contains an unknown eventId: ${JSON.stringify(eventId)}`);
    }
    if (seen.has(eventId)) {
      throw new AgentError(`eventDecisions contains duplicate decision for ${eventId}`);
    }
    seen.add(eventId);
    if (decision.decision === "keep") {
      // Providers occasionally flatten the fact fields onto the keep decision
      // or call the nested object `entry`/`memory`. These shapes are
      // semantically identical, so normalize them without weakening the fact
      // validation itself.
      const inlineContent =
        decision.dimensionKey !== undefined
          ? Object.fromEntries(
              Object.entries(decision).filter(
                ([key]) => key !== "eventId" && key !== "decision" && key !== "reason",
              ),
            )
          : undefined;
      const contentCandidate = decision.content ?? decision.entry ?? decision.memory ?? inlineContent;
      const normalized = normalizeBatchContents([contentCandidate], knownKeys);
      if (normalized.contents.length !== 1 || normalized.skipped !== 0) {
        const preview = JSON.stringify(contentCandidate)?.slice(0, 500) ?? "undefined";
        throw new AgentError(
          `${eventId} keep decision must carry one valid content object; received: ${preview}`,
        );
      }
      eventContents.push(normalized.contents[0]);
      eventKept += 1;
    } else if (decision.decision === "drop") {
      if (typeof decision.reason !== "string" || decision.reason.trim().length === 0) {
        throw new AgentError(`${eventId} drop decision must include a reason`);
      }
      eventDropped += 1;
    } else {
      throw new AgentError(`${eventId} decision must be keep or drop`);
    }
  }
  const missing = [...expected].filter((eventId) => !seen.has(eventId));
  if (missing.length > 0) {
    throw new AgentError(`eventDecisions missing: ${missing.join(", ")}`);
  }

  const merged: CaptureContent[] = [];
  const identities = new Set<string>();
  for (const content of [...eventContents, ...general.contents]) {
    const identity = JSON.stringify([
      content.dimensionKey,
      content.value,
      content.unit ?? null,
      content.saidBy ?? null,
    ]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(content);
  }
  return {
    contents: merged,
    skipped: general.skipped,
    eventKept,
    eventDropped,
  };
}

/**
 * Narrow a BATCH extraction reply's contents (the session-level bulk-import
 * path used by the benchmark harnesses). Deliberately more lenient than
 * {@link toCaptureContent} — the smoke test showed a single strict failure
 * used to cost a WHOLE session's harvest (~12 facts), so here:
 *   - a bare lowerCamelCase key without NEW: is accepted as new;
 *   - empty-string unit / dimensionDescription are omitted (the model emits
 *     `""` freely; the old harness ignored it silently);
 *   - an invalid saidBy is omitted (the fact is kept — it just loses its
 *     content-axis attribution);
 *   - malformed entries are SKIPPED and counted, never fatal.
 * The per-turn product path stays fail-loud by design; only bulk import is
 * forgiving.
 *
 * @param raw the parsed reply's `contents` array (each entry an object)
 * @param knownKeys keys of dimensions already in the graph (informational;
 *   unknown keys are accepted as new when well-formed)
 * @returns valid entries plus the skip count
 */
export function normalizeBatchContents(
  raw: readonly unknown[],
  knownKeys?: ReadonlySet<string>,
): BatchNormalizeResult {
  const contents: CaptureContent[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.dimensionKey !== "string" || rec.dimensionKey.length === 0) {
      skipped += 1;
      continue;
    }
    if (rec.value === undefined || rec.value === null) {
      skipped += 1;
      continue;
    }
    let dimensionKey = rec.dimensionKey;
    // Models sometimes lowercase the protocol prefix ("new:key") — accept
    // any case, strip it, then enforce camelCase on the key itself.
    if (/^new:/i.test(dimensionKey)) {
      const rawKey = dimensionKey.slice(dimensionKey.indexOf(":") + 1);
      const key = repairBatchDimensionKey(rawKey);
      if (!key) {
        skipped += 1;
        continue;
      }
      dimensionKey = key;
    } else if (!knownKeys?.has(dimensionKey) && !LOWER_CAMEL_CASE.test(dimensionKey)) {
      // Lenient path: an unknown key is fine when well-formed (the model
      // meant a new key and forgot NEW:); anything malformed drops the entry.
      skipped += 1;
      continue;
    }
    const content: CaptureContent = { dimensionKey, value: normalizeNumericValue(rec.value) };
    // Lenient optional fields: empty strings vanish, invalid saidBy vanishes,
    // everything else follows the shared contract.
    if (typeof rec.dimensionDescription === "string" && rec.dimensionDescription.trim().length > 0) {
      content.description = rec.dimensionDescription.trim();
    }
    if (rec.cardinality === "single" || rec.cardinality === "multi") {
      content.cardinality = rec.cardinality;
    }
    if (typeof rec.unit === "string" && rec.unit.length > 0) content.unit = rec.unit;
    if (rec.saidBy === "user" || rec.saidBy === "assistant") content.saidBy = rec.saidBy;
    contents.push(content);
  }
  return { contents, skipped };
}

/**
 * Repair common provider drift for explicitly-new keys in the bulk importer.
 * The stored key still obeys lowerCamelCase; the strict product extractor is
 * intentionally unaffected. Numeric-leading concepts receive a neutral
 * `fact` prefix, while separators are folded into camelCase.
 */
function repairBatchDimensionKey(raw: string): string | undefined {
  if (LOWER_CAMEL_CASE.test(raw)) return raw;
  let repaired = raw
    .trim()
    .replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_match, next: string) => next.toUpperCase())
    .replace(/[^A-Za-z0-9]/g, "");
  if (/^[0-9]/.test(repaired)) repaired = `fact${repaired}`;
  if (/^[A-Z]/.test(repaired)) repaired = repaired[0].toLowerCase() + repaired.slice(1);
  return LOWER_CAMEL_CASE.test(repaired) ? repaired : undefined;
}

/**
 * Coerce pure numeric strings ("5000", "99.5") into numbers. LLMs
 * inconsistently quote quantities ("5000" vs 5000), and M1's constraint
 * engine reads number values only — so the extract boundary normalizes
 * once, here. Identifier-like strings with leading zeros ("007") are
 * intentionally left alone: a unitless digit string may be a code, not a
 * quantity.
 */
function normalizeNumericValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return BARE_NUMBER.test(trimmed) ? Number(trimmed) : value;
}
