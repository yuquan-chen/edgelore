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
  "one-off event with lasting significance — purchases, milestones, ceremonies, incidents; dated happenings that must still be answerable months later",
]
  .map((line) => `- ${line}`)
  .join("\n");

const GATE_REJECT_LIST = [
  'small talk, greetings, politeness ("thanks!", "ok")',
  'transient state that goes stale by the next session ("I\'m tired today") — one-off events with lasting consequences are NOT transient',
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
  "4. A dimensionKey must be either an existing key from knownDimensions, or NEW: followed by lowerCamelCase English (letters and digits, starting with a lowercase letter). BEFORE minting a NEW: key, scan knownDimensions carefully — the same concept almost always already has a key.",
  "5. If similarDimensions are provided and a candidate is the SAME slot as one of them, you MUST reuse that dimension's key — never mint a NEW key for an existing concept (key drift fragments the memory graph).",
  "6. If contextMemories already contain an equivalent value, still output the entry (capture deduplicates). If one contradicts, still output it (capture flags the conflict) — resolving conflicts is not your job.",
  "7. One entry per candidate, in order; each entry is independent.",
  '8. Attribute each entry with saidBy — who STATED it in the text: "user" for facts the user stated; "assistant" for conclusions/recommendations the assistant contributed. Assistant conclusions are first-class memories: never drop one for being the assistant\'s.',
  '9. Resolve relative time expressions ("two months ago", "last Friday") into absolute dates and keep them inside the value; today\'s date arrives with the turn context. If unresolvable, omit it — never invent one.',
].join("\n");

const EXTRACT_ENTRY_SHAPE = `For each candidate, output exactly one entry object:
{
  "dimensionKey": "<a key from knownDimensions, or NEW:camelCaseKey if no existing key fits>",
  "value": <a bare NUMBER for quantities — e.g. 5000, NEVER a quoted "5000" — otherwise a short string in the speaker's language verbatim>,
  "saidBy": "user" or "assistant" — who STATED this fact; conclusions/recommendations the ASSISTANT contributed get \\"assistant\\" (default \\"user\\" only when genuinely ambiguous)",
  "dimensionDescription": "optional but STRONGLY RECOMMENDED for NEW: keys — one short line in the speaker's language saying what this slot means (e.g. \\"项目负责人\\" for owner), so later sessions map the same concept onto this key; omit when reusing an existing dimension",
  "cardinality": "optional — ONLY for NEW: keys: "single" if the slot holds one value at a time, "multi" otherwise; omit when reusing an existing dimension (it already has one)",
  "unit": "optional, e.g. CNY, days, ms; reuse the existing dimension's unit when present"
}

Examples (note: quantities are unquoted numbers, the unit is a separate field):
quantity fact: {"dimensionKey": "budget", "value": 5000, "unit": "CNY", "saidBy": "user"}
assistant recommendation: {"dimensionKey": "database_choice", "value": "PostgreSQL", "saidBy": "assistant"}`;

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

// --- batch extraction (session-level bulk import) -----------------------------

/** Input for building the batch (session-level) extraction prompt. */
export interface BatchExtractionPromptInput {
  /** The full session transcript, turns prefixed with their role. */
  transcript: string;
  /** Dimension slots read from the graph by the importing harness. */
  knownDimensions: readonly KnownDimension[];
  /** Max facts per session — the harness's budget knob. */
  maxFacts: number;
  /** ISO date anchoring relative-time resolution ("two months ago"). */
  sessionDate?: string;
  /** Sentences flagged by the event scan (src/agent/triggers.ts): the
   * speaker's own experiences paired with a time expression. Each one must
   * get an explicit keep/drop decision — the scan guarantees they are SEEN;
   * the normal worth-storing rules still decide what is KEPT. */
  mustConsiderEvents?: readonly string[];
  /** Extra fragments appended to the rules zone (retry nudges). */
  extraFragments?: readonly string[];
}

/**
 * Assemble the BATCH extraction prompt: one call per session for bulk
 * imports (the LongMemEval harness ingests 940 sessions this way — one
 * cheap call each, instead of the per-turn gate+extract pipeline).
 *
 * Style follows the frameworks we studied (Mem0/Graphiti): a positive role,
 * FEW-SHOT EXAMPLES that teach by demonstration (date resolution, side
 * remarks, assistant attribution, abstention), and a short rules list —
 * instead of prohibitive rule walls. The session date anchors every
 * relative-time resolution; unresolvable times are omitted, never invented
 * (Graphiti's DATETIME RULES).
 */
export function buildBatchExtractionPrompt(input: BatchExtractionPromptInput): string {
  const known =
    input.knownDimensions.length > 0
      ? input.knownDimensions.map((d) => JSON.stringify(d)).join("\n")
      : "(none yet)";
  return [
    "You are a Personal Memory Organizer. You read ONE session of a conversation",
    "between a user and an assistant, and extract the facts worth remembering",
    "months later — from BOTH sides of the conversation:",
    "- User facts: preferences, plans, events, personal details, quantities.",
    "- Assistant contributions: recommendations, conclusions, or plans that will",
    "  still matter to the user later.",
    "",
    "### Examples",
    "",
    "Session date: 2023-05-01",
    "[user] Hi!",
    "[assistant] Hello! How can I help?",
    '→ {"contents": []}',
    "",
    "Session date: 2023-05-14",
    "[user] This week is busy. By the way, I got a $50 parking ticket last Monday.",
    '→ {"contents": [{"dimensionKey": "NEW:parkingTicket", "value": "Parking ticket, $50 (2023-05-08)", "saidBy": "user"}]}',
    "",
    "Session date: 2023-05-20",
    "[user] I started learning French two months ago, and now I have lessons three times a week.",
    '→ {"contents": [{"dimensionKey": "NEW:frenchLearning", "value": "Started learning French (from 2023-03-20), now 3 lessons per week", "saidBy": "user"}]}',
    "",
    "Session date: 2023-05-20",
    "[user] Which database should I use for this project?",
    "[assistant] For this use case I recommend PostgreSQL — it fits your structured workload better than MongoDB here.",
    '→ {"contents": [{"dimensionKey": "NEW:databaseChoice", "value": "PostgreSQL recommended for the project\'s structured workload", "saidBy": "assistant"}]}',
    "",
    "### Rules",
    "",
    "- The session date is stated above the transcript. Resolve every relative time",
    '  ("two months ago", "last Friday", "today") into an absolute date and keep it',
    "  inside the value. If a time cannot be resolved, omit it — never invent one.",
    '- Keep numbers exactly as stated ("10-12 hours", "$50", "500 Mbps") — never',
    "  flatten a range to a single number.",
    '- Facts mentioned in passing ("by the way...") count as memories too.',
    "- If the user CORRECTS an earlier statement in this session, record only the",
    "  final corrected value.",
    "- Do not invent facts; every value must come from the transcript.",
    "- Record facts in the speaker's original language — if the session is in English,",
    "  write English; if Chinese, write Chinese. NEVER switch languages mid-session.",
    "- Dimension keys stay English regardless of session language.",
    "",
    ...(input.mustConsiderEvents && input.mustConsiderEvents.length > 0
      ? [
          "### Reported experiences (decide every one)",
          "",
          "The sentences below pair the speaker's own words with a specific time. For",
          "EACH one, make an explicit decision: keep it as an entry when it is a one-off",
          "event or lasting fact (purchases, milestones, incidents, visits, things",
          "acquired, given away, or given up), and drop it only when it is transient",
          "state, small talk, or a duplicate of another entry. Skipping a flagged",
          "sentence without a decision is not allowed.",
          "",
          ...input.mustConsiderEvents.map((s) => `- ${s}`),
          "",
        ]
      : []),
    "### Known dimensions",
    "(REUSE one of these keys if a fact is the same slot — never mint a new key for",
    "an existing concept)",
    known,
    "",
    "For each fact output one object:",
    '{ "dimensionKey": "<known key, or NEW:lowerCamelCase>",',
    '  "value": <bare NUMBER for quantities, else a short string in the original',
    '           language — keep resolved dates inside>,',
    '  "saidBy": "user" | "assistant" — who STATED this fact',
    '            (assistant recommendations count too),',
    '  "dimensionDescription": "<one short line in the original language, NEW: only>",',
    '  "cardinality": "<single|multi, NEW: only>",',
    '  "unit": "<optional, e.g. CNY, days, km>" }',
    "",
    "Additionally, for each dimension you touched, output a ONE-LINE roll-up summary",
    "of its CURRENT state (fact count, latest value, key changes). These help future",
    "sessions quickly understand the user's situation without reading every detail.",
    "",
    `Extract at most ${input.maxFacts} facts per session — prefer the durable and important.`,
    "An EMPTY list is a LAST RESORT: re-read the transcript (assistant",
    "recommendations count too) before returning [].",
    ...(input.extraFragments ?? []),
    "",
    "Session date: " + (input.sessionDate ?? "(unknown)"),
    "Session transcript:",
    input.transcript,
    "",
    'Respond with ONLY one JSON object, no fences: { "contents": [ ... ] }',
  ].join("\n");
}
