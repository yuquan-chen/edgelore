// edgelore · Agent Memory layer — real LLM driver (OpenAI-compatible chat).
//
// The first real `LlmDriver` implementation: a thin fetch over any
// OpenAI-compatible chat endpoint (official OpenAI, relays like dogrouter,
// self-hosted gateways). Deliberately dependency-free — the project keeps
// zero runtime npm dependencies; if a richer backend is ever needed, this
// class is the single swap point.
//
// Not used by tests (they run on MockDriver); exercised via the CLI
// `remember` command and the trial harness.

import { AgentError } from "./errors.js";
import type { LlmDriver } from "./llm-driver.js";
import { postJsonWithRetry } from "./http.js";

/** Construction options for {@link OpenAiCompatDriver}. */
export interface OpenAiCompatOptions {
  /** API base URL without trailing slash, e.g. "https://api.dogrouter.ai/v1". */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Model name exactly as the endpoint names it (relays differ). */
  model: string;
  /** Per-call output token cap. Default 700 — plenty for gate/extract JSON. */
  maxTokens?: number;
  /** Per-call timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Extra attempts after the first on transient failures. Default 1. */
  maxRetries?: number;
  /** Vendor-specific request params (escape hatch), shallow-merged into the request body. */
  extraBody?: Record<string, unknown>;
}

/**
 * `LlmDriver` over an OpenAI-compatible `/chat/completions` endpoint.
 * Temperature is pinned to 0: gate/extract want deterministic JSON, not
 * creativity. Transient failures (network, 429, 5xx) are retried with a
 * small linear backoff; everything else fails loud with `AgentError`.
 */
export class OpenAiCompatDriver implements LlmDriver {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraBody: Record<string, unknown>;

  /** @param options endpoint config; unset optional fields take defaults. */
  constructor(options: OpenAiCompatOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 700;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.extraBody = options.extraBody ?? {};
  }

  /**
   * Build a driver from environment variables, with per-call overrides.
   * Reads `OPENAI_API_KEY` (required), `OPENAI_BASE_URL` (optional; defaults
   * to the official endpoint), and `EDGELORE_MODEL` (required — relays name
   * models differently, so no silent default).
   *
   * @param env environment source; defaults to `process.env`
   * @param overrides explicit values that win over the environment
   * @returns a ready driver
   * @throws AgentError if the API key or model is missing
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    overrides?: Partial<Pick<OpenAiCompatOptions, "apiKey" | "baseUrl" | "model">>,
  ): OpenAiCompatDriver {
    const apiKey = overrides?.apiKey ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AgentError("missing OPENAI_API_KEY (set it in the environment or .env.local)");
    }
    const model = overrides?.model ?? env.EDGELORE_MODEL;
    if (!model) {
      throw new AgentError("missing EDGELORE_MODEL (endpoints name models differently; set it explicitly)");
    }
    const baseUrl = overrides?.baseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    return new OpenAiCompatDriver({ apiKey, baseUrl, model });
  }

  async complete(prompt: string): Promise<string> {
    const res = await postJsonWithRetry({
      url: `${this.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      stage: "llm",
      body: {
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: this.maxTokens,
        ...this.extraBody,
      },
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    });
    if (!res.ok) {
      throw new AgentError(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AgentError(`unexpected reply shape: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  }
}
