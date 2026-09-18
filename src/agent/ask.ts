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
import { retrievalContext, type RetrievalConfig } from "./runtime.js";

export const ABSTAIN = "不知道";

/** The prompt asking the model to answer strictly from memory context. */
export function buildAskPrompt(question: string, memories: readonly string[]): string {
  const context =
    memories.length > 0
      ? memories.map((m) => `- ${m}`).join("\n")
      : "(the memory store returned nothing relevant)";
  return [
    "You are answering a question using ONLY a long-term memory store.",
    "",
    "Memory entries (each line: dimension = value [state]; some carry conflict",
    "posture or constraint verdicts):",
    context,
    "",
    "Rules:",
    "1. Ground every claim in the memory entries above. Never use outside knowledge",
    "   for project-specific facts.",
    "2. If entries conflict or are marked tentative, say the current values AND note",
    "   that adjudication is pending — do not pick a side yourself.",
    `3. If the memories do not contain enough information to answer, reply with exactly: ${ABSTAIN}`,
    "4. Answer concisely, in the question's language.",
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
  /** Retrieval plumbing; omit -> falls back to the "latest 50" digest. */
  retrieval?: RetrievalConfig;
  /** Max memory lines provided to the answerer (default 10). */
  k?: number;
}

/**
 * Answer a question strictly from the memory graph.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param question the user's question
 * @param driver the LLM driver (MockDriver in tests)
 * @param opts optional retrieval plumbing and context size
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
    : retrievalDigest(graph, opts?.k ?? 10);
  const answer = (await driver.complete(buildAskPrompt(question, memories))).trim();
  return { answer, usedMemories: memories, abstained: answer === ABSTAIN };
}

/** Fallback digest without embedding plumbing: latest-k statement lines. */
function retrievalDigest(graph: MemoryGraph, k: number): string[] {
  const keys = new Map<string, string>();
  for (const d of graph.queryNodes({ type: "core:dimension" }) as Array<{ id: string; key: string }>) {
    keys.set(d.id, d.key);
  }
  const all = (graph.queryNodes({ type: "core:statement" }) as Array<{
    dimension_id: string;
    value: unknown;
    unit?: string;
    state: string;
  }>).map(
    (s) => `${keys.get(s.dimension_id) ?? "?"} = ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} [${s.state}]`,
  );
  return all.slice(Math.max(0, all.length - k));
}
