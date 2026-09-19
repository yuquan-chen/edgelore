// edgelore — configuration hub.
//
// ONE place that knows how the package is wired to the outside world:
// `.env` loading, environment -> config mapping, and driver construction.
// Every entry point (CLI, MCP launcher, benchmark harnesses) builds its
// drivers through here, so changing model / provider / retrieval tuning is
// a `.env.local` edit — never a code sweep across a dozen entry points.
//
// Contract:
//   - `loadDotEnv` and `configFromEnv` NEVER throw: local-only commands
//     (digest, conflicts, node list) must keep working with no .env at all.
//   - `chatDriver` / `embeddingDriver` fail loud with AgentError when the
//     config they need is missing (whoever uses it, throws).
//   - Environment variable names are frozen (OPENAI_*, EDGELORE_*): existing
//     .env.local files keep working unchanged.

import { readFileSync } from "node:fs";
import { AgentError } from "./agent/errors.js";
import { OpenAiCompatDriver, type OpenAiCompatOptions } from "./agent/openai-compat-driver.js";
import { OpenAiCompatEmbeddingDriver } from "./agent/embedding-driver.js";
import type { RetrievalMode } from "./agent/retrieval.js";

/** Chat endpoint identity (what to call), not per-call params (maxTokens etc. live at call sites). */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Embedding endpoint identity; `dimensions` is declared, never probed. */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

/** Retrieval tuning knobs — all optional; consumers carry matching fallbacks. */
export interface RetrievalSettings {
  /** hybrid | vector | lexical (default hybrid). */
  mode?: RetrievalMode;
  /** Retrieval hit count (default 8). */
  k?: number;
  /** RRF smoothing constant — lower ranks top hits higher (default 60). */
  rrfSmoothing?: number;
  /** Per-dimension entry cap in grouped ask context (default 8). */
  maxEntriesPerDimension?: number;
  /** Hard line budget for the assembled ask context (default 48). */
  maxContextLines?: number;
}

/** Extraction tuning (batch import path). */
export interface ExtractionSettings {
  /** Max facts extracted per session in batch mode (default 12). */
  maxFactsPerSession: number;
}

/** Fully-resolved configuration; `llm`/`embedding` are absent when unconfigured. */
export interface EdgeloreConfig {
  /** Missing -> chat features unavailable (drivers constructed on demand throw). */
  llm?: LlmConfig;
  /** Missing -> retrieval degrades to lexical-only / digest. */
  embedding?: EmbeddingConfig;
  retrieval: RetrievalSettings;
  extraction: ExtractionSettings;
  /** Judge model for benchmark scoring; falls back to llm.model when unset. */
  judgeModel?: string;
}

/**
 * Load a `.env`-style file into process.env, WITHOUT overriding variables
 * already set in the real environment. Missing file is silently ignored.
 * Keeps API keys out of shell history and out of git (.env* is gitignored).
 * The single implementation — CLI, MCP launcher and benchmark boot all share it.
 */
export function loadDotEnv(path: string = ".env.local"): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map environment variables to {@link EdgeloreConfig}. Never throws: absent
 * credentials simply leave `llm`/`embedding` undefined; retrieval and
 * extraction come back fully materialized with documented defaults.
 *
 * Chat:   OPENAI_API_KEY + EDGELORE_MODEL (required pair), OPENAI_BASE_URL.
 * Embed:  EDGELORE_EMBEDDING_MODEL + EDGELORE_EMBEDDING_DIMENSIONS (required
 *         pair), OPENAI_EMBEDDING_API_KEY / _BASE_URL with chat fallbacks.
 * Tuning: EDGELORE_RETRIEVAL_{MODE,K,RRF_SMOOTHING,MAX_ENTRIES_PER_DIM,
 *         MAX_CONTEXT_LINES}, EDGELORE_EXTRACTION_MAX_FACTS,
 *         EDGELORE_JUDGE_MODEL.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): EdgeloreConfig {
  const llm =
    env.OPENAI_API_KEY && env.EDGELORE_MODEL
      ? {
          baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
          apiKey: env.OPENAI_API_KEY,
          model: env.EDGELORE_MODEL,
        }
      : undefined;
  const dimensions = num(env.EDGELORE_EMBEDDING_DIMENSIONS);
  const embedding =
    env.EDGELORE_EMBEDDING_MODEL && dimensions !== undefined && dimensions > 0
      ? {
          baseUrl:
            env.OPENAI_EMBEDDING_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
          apiKey: env.OPENAI_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY ?? "",
          model: env.EDGELORE_EMBEDDING_MODEL,
          dimensions,
        }
      : undefined;
  const retrieval: RetrievalSettings = {
    mode: (env.EDGELORE_RETRIEVAL_MODE as RetrievalMode | undefined) ?? "hybrid",
    k: num(env.EDGELORE_RETRIEVAL_K) ?? 8,
    rrfSmoothing: num(env.EDGELORE_RETRIEVAL_RRF_SMOOTHING) ?? 60,
    maxEntriesPerDimension: num(env.EDGELORE_RETRIEVAL_MAX_ENTRIES_PER_DIM) ?? 8,
    maxContextLines: num(env.EDGELORE_RETRIEVAL_MAX_CONTEXT_LINES) ?? 48,
  };
  const extraction: ExtractionSettings = {
    maxFactsPerSession: num(env.EDGELORE_EXTRACTION_MAX_FACTS) ?? 12,
  };
  return { llm, embedding, retrieval, extraction, judgeModel: env.EDGELORE_JUDGE_MODEL };
}

/** Per-call construction overrides for {@link chatDriver} (CLI flags, benchmark knobs). */
export type ChatDriverOverrides = Partial<
  Pick<OpenAiCompatOptions, "apiKey" | "baseUrl" | "model" | "maxTokens" | "timeoutMs" | "maxRetries" | "extraBody">
>;

/**
 * Build the chat driver from resolved config, with per-call overrides.
 *
 * @throws AgentError when the config carries no llm section (missing key/model).
 */
export function chatDriver(cfg: EdgeloreConfig, overrides?: ChatDriverOverrides): OpenAiCompatDriver {
  if (!cfg.llm) {
    throw new AgentError(
      "missing OPENAI_API_KEY / EDGELORE_MODEL (set them in the environment or .env.local)",
    );
  }
  return new OpenAiCompatDriver({
    baseUrl: overrides?.baseUrl ?? cfg.llm.baseUrl,
    apiKey: overrides?.apiKey ?? cfg.llm.apiKey,
    model: overrides?.model ?? cfg.llm.model,
    maxTokens: overrides?.maxTokens,
    timeoutMs: overrides?.timeoutMs,
    maxRetries: overrides?.maxRetries,
    extraBody: overrides?.extraBody,
  });
}

/**
 * Build the embedding driver from resolved config.
 *
 * @throws AgentError when the config carries no embedding section.
 */
export function embeddingDriver(cfg: EdgeloreConfig): OpenAiCompatEmbeddingDriver {
  if (!cfg.embedding) {
    throw new AgentError(
      "missing EDGELORE_EMBEDDING_MODEL / EDGELORE_EMBEDDING_DIMENSIONS (set them in the environment or .env.local)",
    );
  }
  return new OpenAiCompatEmbeddingDriver(cfg.embedding);
}
