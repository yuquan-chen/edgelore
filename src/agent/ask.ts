// edgelore · Agent Memory layer — the answering layer (read path's last mile).
//
// Retrieval finds relevant memories; this module turns them into an ANSWER —
// strictly grounded in the provided memories, with mandatory abstention: if
// the memories do not contain enough information, the answer is exactly
// "不知道". This abstention contract is what the benchmark's abstention
// questions test, and what keeps the memory honest (never invent from
// outside knowledge).

import type { MemoryGraph } from "../model/store.js";
import type { LlmDriver } from "./llm-driver.js";
import { contextMemoriesOf, retrievalContext, type RetrievalConfig } from "./runtime.js";

export const ABSTAIN = "不知道";

/**
 * The prompt asking the model to answer strictly from memory context.
 *
 * `now` pins "today" (ISO day, e.g. "2023-04-10"): temporal questions are
 * relative to the moment of asking, and without it the model guesses. The
 * benchmark harness derives it from each question's `question_date` (pure
 * string transform — never `new Date()`, whose UTC conversion shifts
 * pre-08:00 timestamps a day back on UTC+8 machines).
 */
export function buildAskPrompt(question: string, memories: readonly string[], now?: string): string {
  const context =
    memories.length > 0
      ? memories.map((m) => `- ${m}`).join("\n")
      : "(the memory store returned nothing relevant)";
  return [
    "You are the user's long-term memory — you were present in every conversation,",
    "and the entries below are what you remember. Answer as a trusted assistant who",
    "KNOWS their history, not as a search engine returning exact matches.",
    ...(now ? ["", `Today is ${now}.`] : []),
    "",
    "=== Memory ===",
    context,
    "=== End of Memory ===",
    "",
    "Rules:",
    "1. Every claim must come from the memory entries. Never invent facts.",
    "2. Use dates actively: entries have [state @date] markers. For temporal questions,",
    "   compare dates against today, compute intervals, and order events chronologically.",
    "3. When entries compete, the LATEST accepted entry is current truth. Report it as",
    "   the answer; you may briefly note the outdated value.",
    "4. The context is grouped by dimension: a header like `key — 3 entries:` is the",
    "   graph's OWN count — trust it for counting questions (a group marked omitted",
    "   still has its count in the header). superseded and tentative entries still",
    "   happened — count them too.",
    "5. Combine multiple entries when the answer spans several memories.",
    `6. Reply ${ABSTAIN} ONLY if no entry is even loosely related to the question.`,
    "   If entries are partially relevant, reason from them and give your best answer.",
    "7. Answer in the question's language.",
    "",
    `Question: ${question}`,
  ].join("\n");
}

/** Result of {@link answerQuestion}. */
export interface AskResult {
  /** The grounded answer, or {@link ABSTAIN} when memory is insufficient. */
  answer: string;
  /** The memory lines the answer was grounded in (for debugging/audit). */
  usedMemories: string[];
  /** True when the answer is the abstention marker. */
  abstained: boolean;
}

/** Options for {@link answerQuestion}. */
export interface AskOptions {
  /** Retrieval plumbing; omit -> falls back to the "latest k" digest
   * (contextMemoriesOf — same line format as the retrieval path, @date included). */
  retrieval?: RetrievalConfig;
  /** Max memory lines provided to the answerer (default 10). This is the
   * ANSWER-path budget; the extraction-context path keeps its own default 8 —
   * different consumers, deliberately separate knobs. */
  k?: number;
  /** "Today", as an ISO day ("2023-04-10"). Omitted -> no Today line. */
  now?: string;
}

/**
 * Answer a question strictly from the memory graph.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param question the user's question
 * @param driver the LLM driver (MockDriver in tests)
 * @param opts optional retrieval plumbing, context size, and today's date
 * @returns the grounded answer with its supporting memory lines
 * @throws AgentError on malformed driver replies (propagated)
 */
export async function answerQuestion(
  graph: MemoryGraph,
  question: string,
  driver: LlmDriver,
  opts?: AskOptions,
): Promise<AskResult> {
  const memories = opts?.retrieval
    ? (await retrievalContext(graph, question, { ...opts.retrieval, k: opts.k ?? 10 })).lines
    : contextMemoriesOf(graph, opts?.k ?? 10);
  const answer = (await driver.complete(buildAskPrompt(question, memories, opts?.now))).trim();
  return { answer, usedMemories: memories, abstained: answer === ABSTAIN };
}
