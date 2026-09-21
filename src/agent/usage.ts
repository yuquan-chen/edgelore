// edgelore · Agent Memory layer — API usage tracker (local, zero-dep).
//
// Every LLM / embedding / decision call flows through postJsonWithRetry,
// so the tracker hooks there and accumulates per-stage counts. Callers
// read the totals at end-of-run (answer.mjs / ingest.mjs / cli print).
// Local JSONL log for post-hoc cost analysis; no external service.

import { AgentError } from "./errors.js";

export interface UsageEntry {
  /** Pipeline stage identifier: "gate" | "extract" | "answer" | "embedding" | "decision" | "unknown". */
  stage: string;
  /** ISO timestamp of the call. */
  at: string;
  /** HTTP status code (200 = success). */
  status: number;
  /** Input tokens (from API response usage block; 0 if absent). */
  inputTokens: number;
  /** Output tokens (from API response usage block; 0 if absent). */
  outputTokens: number;
  /** Wall-clock ms from request start to response received. */
  latencyMs: number;
}

const log: UsageEntry[] = [];
const MAX_ENTRIES = 100_000; // memory guard: 100k calls ≈ 10MB, plenty

function parseTokens(body: unknown): { input: number; output: number } {
  if (typeof body !== "object" || body === null) return { input: 0, output: 0 };
  const usage = (body as { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!usage) return { input: 0, output: 0 };
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
}

/**
 * Record one API call. Called automatically by postJsonWithRetry's
 * response processing — callers never invoke this directly.
 *
 * @param stage a short pipeline label ("gate", "extract", "answer", "embedding", "decision")
 * @param status HTTP status code
 * @param body the parsed response body (for token usage extraction)
 * @param startedAt performance.now() captured before the call
 */
export function recordUsage(stage: string, status: number, body: unknown, startedAt: number): void {
  if (log.length >= MAX_ENTRIES) log.shift();
  const { input, output } = parseTokens(body);
  log.push({
    stage,
    at: new Date().toISOString(),
    status,
    inputTokens: input,
    outputTokens: output,
    latencyMs: Math.round(performance.now() - startedAt),
  });
}

/** Aggregate usage totals, optionally filtered by stage. */
export function usageTotals(stage?: string): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMsP50: number;
  errors: number;
} {
  const entries = stage ? log.filter((e) => e.stage === stage) : log;
  const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;
  return {
    calls: entries.length,
    inputTokens: entries.reduce((s, e) => s + e.inputTokens, 0),
    outputTokens: entries.reduce((s, e) => s + e.outputTokens, 0),
    latencyMsP50: p50,
    errors: entries.filter((e) => e.status !== 200).length,
  };
}

/** Dump all entries as JSONL (one JSON object per line) for file logging. */
export function usageJsonl(): string {
  return log.map((e) => JSON.stringify(e)).join("\n");
}

/** Reset the tracker (start of a new run). */
export function resetUsage(): void {
  log.length = 0;
}

/** How many calls recorded so far. */
export function usageCallCount(): number {
  return log.length;
}
