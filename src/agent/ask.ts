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
import type { DecisionDriver } from "./decision.js";
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
    '   Relative expressions ("last week", "recently") are fuzzy — an entry a few days',
    "   outside your strict window still counts if it clearly matches.",
    "3. When entries describe the same slot at different dates, the LATEST USER-stated",
    "   entry is current truth — even if it is still tentative (pending review is not",
    "   rejection); you may briefly note the outdated value. An assistant's tentative",
    "   suggestion never overrides an accepted user value.",
    "4. The context is grouped by dimension: a header like `key — 3 entries:` is the",
    "   graph's OWN count — trust it for counting questions (a group marked omitted",
    "   still has its count in the header). superseded and tentative entries still",
    "   happened — count them too.",
    "5. Combine multiple entries when the answer spans several memories.",
    "   `conversationEvidence` entries are verbatim transcript excerpts. Use them",
    "   for exact wording, numbers, mappings, URLs, code, and generated artifacts;",
    "   they record what was said, not an independently verified real-world fact.",
    "6. Entries tagged (non-user-account) belong to a DIFFERENT account: never count,",
    "   sum, or compare them inside aggregates (totals/how-many/comparisons). Consult",
    "   one only as a last resort for a single-fact lookup that has no in-account match,",
    "   and say so.",
    `7. Reply ${ABSTAIN} ONLY if no entry is even loosely related to the question.`,
    "   If entries are partially relevant, reason from them and give your best answer.",
    "   For how-many / how-much / how-long questions: if the account has no entry",
    `   recording that exact quantity, reply ${ABSTAIN} — never substitute a near-topic`,
    "   entry or guess a number.",
    "8. Answer in the question's language.",
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
  /** Upper bound on candidate memory dates ("YYYY-MM-DD") — a question asked
   * at time T cannot recall statements made after T. Product callers omit
   * this (now = actual time); benchmark callers pass the question date. */
  dateTo?: string;
  /** Scope: WHOSE memory to search (session/source ids). Identity, not
   * content — product callers scope by user namespace; benchmark callers
   * pass the question's haystack session set. */
  scopeSessionIds?: readonly string[];
  /** System One decision layer (e.g. TypeSafe Jev). When present, one
   * decision call classifies the question's intent and a "set" intent
   * widens the retrieval window. Optional — answering proceeds without it. */
  decision?: DecisionDriver;
}

/**
 * Answer a question strictly from the memory graph.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param question the user's question
 * @param driver the LLM driver (MockDriver in tests)
 * @param opts optional retrieval plumbing, context size, today's date, and
 *   scope/date bounds
 * @returns the grounded answer with its supporting memory lines
 * @throws AgentError on malformed driver replies (propagated)
 */
export async function answerQuestion(
  graph: MemoryGraph,
  question: string,
  driver: LlmDriver,
  opts?: AskOptions,
): Promise<AskResult> {
  let retrievalConfig = opts?.retrieval
    ? {
        ...opts.retrieval,
        ...(opts.dateTo ? { dateTo: opts.dateTo } : {}),
        ...(opts.scopeSessionIds ? { scopeSessionIds: opts.scopeSessionIds } : {}),
      }
    : undefined;
  let effectiveK = opts?.k ?? opts?.retrieval?.k ?? 10;
  // 决策层（可选）：聚合类问题自动放大检索窗口。失败不阻塞主链路——
  // 决策层是增强，不是依赖。
  if (opts?.decision && retrievalConfig) {
    try {
      const intent = await opts.decision.choice(
        question,
        "Is this question asking for a COMPLETE list or total count of everything matching (a set question), or about ONE specific fact?",
        {
          set: "asks for all instances, a count, or a total",
          lookup: "asks about one specific fact",
        },
      );
      if (intent === "set") effectiveK = Math.max(effectiveK, 30);
    } catch {
      // decision-layer failures must never break answering
    }
  }
  if (retrievalConfig) retrievalConfig = { ...retrievalConfig, k: effectiveK };
  const memories = retrievalConfig
    ? (await retrievalContext(graph, question, retrievalConfig)).lines
    : contextMemoriesOf(graph, effectiveK);
  const answer = (await driver.complete(buildAskPrompt(question, memories, opts?.now))).trim();
  return { answer, usedMemories: memories, abstained: answer === ABSTAIN };
}
