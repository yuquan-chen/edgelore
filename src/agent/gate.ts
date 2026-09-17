// edgelore · Agent Memory layer — gate (worth-storing triage).
//
// Stage 1 of the two-stage pipeline (docs/agent-memory-design.md §4.1):
// decide whether a conversation turn is worth storing, and if so cut out the
// verbatim candidate fragments for the extractor. The gate never invents
// structure — that is extract's job — and never touches the graph.

import { AgentError } from "./errors.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import { buildGatePrompt } from "./prompt.js";

/** The gate's verdict on one conversation turn. */
export interface GateResult {
  /** true = the turn contains facts worth storing. */
  store: boolean;
  /** Verbatim fragments of the worth-storing facts (empty when store=false). */
  candidates: string[];
  /** Short explanation, in the speaker's language when applicable. */
  reason?: string;
}

/** Options for {@link runGate}. */
export interface GateOptions {
  /** Extra scenario fragments appended to the base prompt (§4.3). */
  extraFragments?: readonly string[];
}

/**
 * Run the gate: decide whether a conversation turn is worth storing.
 *
 * @param text the conversation turn (already cleared by the future trigger
 *   layer; in current usage every processed turn reaches the gate)
 * @param driver the LLM driver (MockDriver in tests)
 * @param opts optional prompt fragments
 * @returns the gate verdict with verbatim candidate fragments
 * @throws AgentError if the reply is not valid JSON, or store=true without
 *   candidates, or candidates are not strings
 */
export async function runGate(text: string, driver: LlmDriver, opts?: GateOptions): Promise<GateResult> {
  const reply = await driver.complete(buildGatePrompt({ text, extraFragments: opts?.extraFragments }));
  const parsed = parseJsonReply(reply) as Record<string, unknown>;
  if (typeof parsed.store !== "boolean") {
    throw new AgentError('gate reply field "store" must be a boolean');
  }
  const candidates = asStringArray(parsed.candidates);
  if (parsed.store && candidates.length === 0) {
    throw new AgentError("gate reply with store=true must list at least one candidate");
  }
  const result: GateResult = { store: parsed.store, candidates };
  if (parsed.reason !== undefined) {
    if (typeof parsed.reason !== "string") {
      throw new AgentError('gate reply field "reason" must be a string');
    }
    result.reason = parsed.reason;
  }
  return result;
}

/** Narrow an optional array-of-strings reply field, failing loud otherwise. */
function asStringArray(value: unknown, field = "candidates"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AgentError(`gate reply field "${field}" must be an array of strings`);
  }
  return value;
}
