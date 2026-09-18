// edgelore · Agent Memory layer — embedding provider abstraction.
//
// Chat and embedding are SEPARATE provider concerns (often literally
// different vendors — e.g. Anthropic has no embeddings API), so this
// interface mirrors `LlmDriver` and is configured independently.
//
// Design points traceable to the provider-abstraction research:
//  - dimensions are DECLARED (config constant pinned against the vector
//    store), never probed at runtime;
//  - embed() is batch-first (one call for N texts);
//  - OpenAI-compatible /embeddings covers official OpenAI, relays,
//    dashscope-compatible endpoints, Ollama, vLLM — one implementation for
//    nearly every vendor.

import { AgentError } from "./errors.js";
import { postJsonWithRetry } from "./http.js";

/** Vectorization half of the provider surface (chat lives in llm-driver). */
export interface EmbeddingDriver {
  /** Vector length this driver produces — pin it against the vector store. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts.
   * @param texts non-empty list; empty input returns [] without a call
   * @returns one vector per input, in input order
   * @throws AgentError on shape/count mismatches or unretryable API errors
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** Construction options for {@link OpenAiCompatEmbeddingDriver}. */
export interface OpenAiCompatEmbeddingOptions {
  /** API base URL without trailing slash. */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Embedding model name exactly as the endpoint names it. */
  model: string;
  /** Declared vector length; every reply is validated against it. */
  dimensions: number;
  /** Per-call timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Extra attempts after the first on transient failures. Default 1. */
  maxRetries?: number;
}

/**
 * `EmbeddingDriver` over an OpenAI-compatible `/embeddings` endpoint.
 * Transient failures (network, 429, 5xx) are retried; everything else
 * fails loud with `AgentError`.
 */
export class OpenAiCompatEmbeddingDriver implements EmbeddingDriver {
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /** @param options endpoint config; dimensions is REQUIRED (declared, not probed). */
  constructor(options: OpenAiCompatEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /**
   * Build an embedding driver from environment variables, with overrides.
   * Reads `EDGELORE_EMBEDDING_MODEL` (required — chat models are not
   * embedding models, so no fallback), `EDGELORE_EMBEDDING_DIMENSIONS`
   * (required positive integer), and `OPENAI_EMBEDDING_API_KEY` /
   * `OPENAI_EMBEDDING_BASE_URL` with fallback to `OPENAI_API_KEY` /
   * `OPENAI_BASE_URL` (embedding may live at another vendor).
   *
   * @param env environment source; defaults to `process.env`
   * @param overrides explicit values that win over the environment
   * @returns a ready driver
   * @throws AgentError if model, dimensions, or an API key is missing
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    overrides?: Partial<Pick<OpenAiCompatEmbeddingOptions, "apiKey" | "baseUrl" | "model" | "dimensions">>,
  ): OpenAiCompatEmbeddingDriver {
    const apiKey = overrides?.apiKey ?? env.OPENAI_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AgentError(
        "missing OPENAI_EMBEDDING_API_KEY (or OPENAI_API_KEY fallback) for embeddings",
      );
    }
    const model = overrides?.model ?? env.EDGELORE_EMBEDDING_MODEL;
    if (!model) {
      throw new AgentError(
        "missing EDGELORE_EMBEDDING_MODEL (a chat model is not an embedding model; set it explicitly)",
      );
    }
    const rawDimensions = overrides?.dimensions !== undefined
      ? String(overrides.dimensions)
      : env.EDGELORE_EMBEDDING_DIMENSIONS;
    const dimensions = Number(rawDimensions);
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new AgentError(
        "EDGELORE_EMBEDDING_DIMENSIONS must be a positive integer (declared, not probed)",
      );
    }
    const baseUrl =
      overrides?.baseUrl ?? env.OPENAI_EMBEDDING_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    return new OpenAiCompatEmbeddingDriver({ apiKey, baseUrl, model, dimensions });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await postJsonWithRetry({
      url: `${this.baseUrl}/embeddings`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, input: texts },
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    });
    if (!res.ok) {
      throw new AgentError(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new AgentError(
        `expected ${texts.length} embeddings, got ${Array.isArray(data.data) ? data.data.length : "none"}`,
      );
    }
    return data.data.map((entry, index) => {
      const vector = entry.embedding;
      if (
        !Array.isArray(vector) ||
        vector.length !== this.dimensions ||
        vector.some((x) => typeof x !== "number")
      ) {
        throw new AgentError(
          `embedding ${index}: expected ${this.dimensions} numbers, got ${
            Array.isArray(vector) ? `${vector.length} values` : typeof vector
          }`,
        );
      }
      return vector;
    });
  }
}

/**
 * Deterministic fake embedder for tests and offline use: identical text
 * always yields the identical vector (FNV-1a seed + LCG), different texts
 * yield different vectors. Vectors carry NO semantics — tests that need
 * similarity rankings stub their own embedder.
 */
export class MockEmbedder implements EmbeddingDriver {
  readonly dimensions: number;

  /** @param dimensions vector length (default 16). */
  constructor(dimensions = 16) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      let x = 2166136261; // FNV-1a seed
      for (let i = 0; i < text.length; i++) {
        x ^= text.charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      x = x >>> 0;
      const vector = new Array<number>(this.dimensions);
      for (let i = 0; i < this.dimensions; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0; // LCG
        vector[i] = (x / 4294967296) * 2 - 1;
      }
      return vector;
    });
  }
}
