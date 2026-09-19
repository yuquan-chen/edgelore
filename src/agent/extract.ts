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
  if (contents.length === 0) {
    return { action: "NOOP", reason: "extractor produced no entries" };
  }
  return { action: "STORE", contents };
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

/**
 * Narrow a BATCH extraction reply's contents (the session-level bulk-import
 * path used by the benchmark harnesses). Deliberately more lenient than
 * {@link toCaptureContent}: a bare lowerCamelCase key without the NEW:
 * prefix is ACCEPTED as a new key (batch sessions mint many keys; the alias
 * guard's ambiguity checks matter less than not losing a whole session to
 * one strict failure). Everything else — value normalization, optional
 * fields, saidBy — follows the exact same contract.
 *
 * @param raw the parsed reply's `contents` array (each entry an object)
 * @param knownKeys keys of dimensions already in the graph (informational;
 *   unknown keys are accepted as new when well-formed)
 * @returns one CaptureContent per entry, order preserved
 * @throws AgentError on malformed entries (missing key/value, bad enum)
 */
export function normalizeBatchContents(
  raw: readonly unknown[],
  knownKeys?: ReadonlySet<string>,
): CaptureContent[] {
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AgentError("batch extract: each content must be a JSON object");
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.dimensionKey !== "string" || rec.dimensionKey.length === 0) {
      throw new AgentError("batch extract: content.dimensionKey must be a non-empty string");
    }
    if (rec.value === undefined || rec.value === null) {
      throw new AgentError(`batch extract: content "${rec.dimensionKey}" is missing a value`);
    }
    let dimensionKey = rec.dimensionKey;
    if (dimensionKey.startsWith(NEW_PREFIX)) {
      const key = dimensionKey.slice(NEW_PREFIX.length);
      if (!LOWER_CAMEL_CASE.test(key)) {
        throw new AgentError(`batch extract: "${rec.dimensionKey}" is not NEW:lowerCamelCase`);
      }
      dimensionKey = key;
    } else if (!knownKeys?.has(dimensionKey) && !LOWER_CAMEL_CASE.test(dimensionKey)) {
      // Lenient path: an unknown key is fine when well-formed (the model
      // meant a new key and forgot NEW:); anything malformed fails loud.
      throw new AgentError(`batch extract: malformed dimensionKey "${dimensionKey}"`);
    }
    const content: CaptureContent = { dimensionKey, value: normalizeNumericValue(rec.value) };
    applyOptionalContentFields(content, rec);
    return content;
  });
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
