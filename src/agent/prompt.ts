// edgelore · Agent Memory layer — prompt templates (two-stage: gate + extract).
//
// Design: docs/agent-memory-design.md §4. Structure is FIXED (the JSON
// contracts downstream depend on it); wording is adjustable. Prompts are
// assembled from composable fragments so new memory scenarios plug in without
// touching the base template (§4.3: "structure fixed, wording tunable").
//
// Language policy (user-approved):
// - instructions are English — the task is extraction-to-JSON, the output
//   contract keys and the dimension keys are English anyway, and this is an
//   open-source project;
// - stored CONTENT (value / candidates / reason) keeps the speaker's language
//   verbatim;
// - dimension keys are subject-free English camelCase — they are ADDRESSES of
//   the graph (so a Chinese session and an English session land on the same
//   dimension), never content. Human-language labels live in `description`.
//
// The whitelist below traces back to the research notes
// (docs/notes/agent-memory-write-policy.md §2, Mem0's official criteria),
// plus the user-approved "lesson/feedback" addition.

/**
 * A dimension slot as seen by the prompts. The runtime builds this list from
 * the graph (queryNodes on `core:dimension`); the model may only reuse these
 * keys or invent `NEW:camelCaseKey` ones.
 */
export interface KnownDimension {
  /** Stable subject-free dimension key (English camelCase), e.g. "budget". */
  key: string;
  /** Human-language description helping the model map phrases onto keys. */
  description: string;
  /** How many accepted values the slot holds: one at a time, or many. */
  cardinality: "single" | "multi";
  /** Optional unit hint, e.g. "CNY", "days". */
  unit?: string;
}

// --- gate (worth-storing triage) -------------------------------------------

const GATE_ROLE =
  "You are the memory gatekeeper. Decide whether the given conversation turn " +
  "is worth storing as long-term memory. When in doubt, do NOT store: " +
  "over-extraction pollutes the memory graph and degrades retrieval.";

const GATE_STORE_WHITELIST = [
  "decision/conclusion — something was settled or decided",
  "preference — a stated like/dislike about how things should be done",
  "constraint/rule — budget, SLA, must/must-not, prohibition",
  "fact/identity — owner, tech stack, deadline, role, organization",
  "measured quantity — a value with a unit",
  "relation — ownership, dependency, belonging",
  "lesson/feedback — a pitfall hit, or a correction/praise about how work is done (include the why)",
]
  .map((line) => `- ${line}`)
  .join("\n");

const GATE_REJECT_LIST = [
  'small talk, greetings, politeness ("thanks!", "ok")',
  'transient state that goes stale by the next session ("I\'m tired today")',
  "information equivalent to something already stored (capture deduplicates)",
  'pure process talk ("help me look at this", "done")',
  "public knowledge or general common sense",
  "guesses or uncertain claims",
]
  .map((line) => `- ${line}`)
  .join("\n");

const GATE_OUTPUT = [
  "Respond with ONLY one JSON object, no markdown fences, no commentary:",
  '{ "store": true|false, "candidates": ["<verbatim fragment of each fact worth storing>"], "reason": "<short reason>" }',
  "- If store is false, candidates must be [].",
  "- candidates must be VERBATIM fragments of the input text: no rewriting, no translation, keep the speaker's language.",
  "- Write reason in the speaker's language.",
].join("\n");

/** Input for building the gate prompt. */
export interface GatePromptInput {
  /** The conversation turn to judge. */
  text: string;
  /** Extra scenario fragments spliced in before the output contract (§4.3). */
  extraFragments?: readonly string[];
}

/**
 * Assemble the gate prompt (worth-storing triage).
 *
 * @param input the conversation turn plus optional extra fragments
 * @returns the fully assembled prompt text
 */
export function buildGatePrompt(input: GatePromptInput): string {
  const blocks = [
    GATE_ROLE,
    "Worth storing (any hit -> produce candidates; none -> store=false):",
    GATE_STORE_WHITELIST,
    "NOT worth storing (store=false):",
    GATE_REJECT_LIST,
    ...(input.extraFragments ?? []),
    "Input text (the conversation turn to judge):",
    input.text,
    GATE_OUTPUT,
  ];
  return blocks.join("\n\n");
}

// --- extract (candidates -> structured entries) ------------------------------

const EXTRACT_ROLE =
  "You are the memory extractor. Turn the candidate facts from the " +
  "conversation turn into structured memory entries.";

const EXTRACT_RULES = [
  "1. NEVER output provenance (created_by / source_refs / created_at) — the runtime injects it.",
  "2. Never invent information that is not in the input text.",
  '3. dimensionKey is a subject-free address of the graph ("budget", not "p1_budget" or "my_project_budget"); project/scope context is NOT your business.',
  "4. A dimensionKey must be either an existing key from knownDimensions, or NEW: followed by lowerCamelCase English (letters and digits, starting with a lowercase letter).",
  "5. If similarDimensions are provided and a candidate is the SAME slot as one of them, you MUST reuse that dimension's key — never mint a NEW key for an existing concept (key drift fragments the memory graph).",
  "6. If contextMemories already contain an equivalent value, still output the entry (capture deduplicates). If one contradicts, still output it (capture flags the conflict) — resolving conflicts is not your job.",
  "7. One entry per candidate, in order; each entry is independent.",
].join("\n");

const EXTRACT_ENTRY_SHAPE = `For each candidate, output exactly one entry object:
{
  "dimensionKey": "<a key from knownDimensions, or NEW:camelCaseKey if no existing key fits>",
  "value": <a bare NUMBER for quantities — e.g. 5000, NEVER a quoted "5000" — otherwise a short string in the speaker's language verbatim>,
  "dimensionDescription": "optional but STRONGLY RECOMMENDED for NEW: keys — one short line in the speaker's language saying what this slot means (e.g. \\"项目负责人\\" for owner), so later sessions map the same concept onto this key; omit when reusing an existing dimension",
  "cardinality": "optional — ONLY for NEW: keys: "single" if the slot holds one value at a time, "multi" otherwise; omit when reusing an existing dimension (it already has one)",
  "unit": "optional, e.g. CNY, days, ms; reuse the existing dimension's unit when present"
}

Examples (note: quantities are unquoted numbers, the unit is a separate field):
quantity fact: {"dimensionKey": "budget", "value": 5000, "unit": "CNY"}
text fact:     {"dimensionKey": "theme", "value": "深色"}`;

/** Input for building the extract prompt. */
export interface ExtractPromptInput {
  /** The full conversation turn the candidates were drawn from. */
  text: string;
  /** Verbatim fragments produced by the gate. */
  candidates: readonly string[];
  /** Dimension slots read from the graph by the runtime. */
  knownDimensions: readonly KnownDimension[];
  /** Dimensions owning the retrieved context — same-slot candidates must
   * reuse their keys (anti-drift, layer 2). */
  similarDimensions?: readonly KnownDimension[];
  /** Relevant stored memories, for judging duplicates / contradictions. */
  contextMemories: readonly string[];
  /** Extra scenario fragments spliced in before the output contract (§4.3). */
  extraFragments?: readonly string[];
}

/**
 * Assemble the extract prompt (candidates -> structured entries).
 *
 * @param input the turn, candidates, dimension slots, similar dimensions,
 *   and stored-memory context
 * @returns the fully assembled prompt text
 */
export function buildExtractPrompt(input: ExtractPromptInput): string {
  const dimensions =
    input.knownDimensions.length > 0
      ? input.knownDimensions.map((d) => JSON.stringify(d)).join("\n")
      : "(none yet — every new key must use the NEW: prefix, with a dimensionDescription)";
  const similar =
    input.similarDimensions && input.similarDimensions.length > 0
      ? input.similarDimensions.map((d) => JSON.stringify(d)).join("\n")
      : "(none)";
  const context =
    input.contextMemories.length > 0
      ? input.contextMemories.map((m) => `- ${m}`).join("\n")
      : "(none)";
  const blocks = [
    EXTRACT_ROLE,
    `Known dimensions (prefer reusing one of these keys):\n${dimensions}`,
    `Similar dimensions (retrieved as likely-relevant; if a candidate is the SAME slot, REUSE its key — never mint a new one):\n${similar}`,
    `Relevant stored memories (for judging duplicates / contradictions):\n${context}`,
    `Candidate facts (verbatim fragments):\n${input.candidates.map((c) => `- ${c}`).join("\n")}`,
    `Input text (the full conversation turn):\n${input.text}`,
    EXTRACT_RULES,
    ...(input.extraFragments ?? []),
    EXTRACT_ENTRY_SHAPE,
    'Respond with ONLY one JSON object, no markdown fences, no commentary:\n{ "contents": [ { ...entry... } ] }',
  ];
  return blocks.join("\n\n");
}
