// edgelore · Agent Memory layer — shared HTTP transport for LLM drivers.
//
// Both real drivers (chat + embedding) talk to OpenAI-compatible endpoints
// over the platform fetch API (zero dependencies) and share one transient-
// failure policy: network errors, 429 and 5xx are retried with a small
// linear backoff; everything else fails loud. Retry/timeout live HERE —
// transport-level concerns, not provider configuration (industry practice).

import { AgentError } from "./errors.js";

/** Marks retryable transport failures (network errors, 429, 5xx). Internal. */
export class TransientError extends Error {}

/** Options for {@link postJsonWithRetry}. */
export interface PostJsonOptions {
  /** Absolute endpoint URL. */
  url: string;
  /** Extra headers (Content-Type and JSON body are handled here). */
  headers: Record<string, string>;
  /** Request payload, JSON-serialized. */
  body: unknown;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
  /** Extra attempts after the first on transient failures. */
  maxRetries: number;
}

/**
 * POST a JSON payload with transient-failure retry.
 *
 * @param options endpoint, headers, payload, and transport policy
 * @returns the Response for a non-retryable outcome (caller maps 4xx etc.)
 * @throws AgentError when all attempts are exhausted
 * @throws whatever the caller maps from non-retryable responses
 */
export async function postJsonWithRetry(options: PostJsonOptions): Promise<Response> {
  let lastError: Error = new AgentError("unreachable");
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      return await postJsonOnce(options);
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      lastError = err;
    }
  }
  throw new AgentError(
    `endpoint failed after ${options.maxRetries + 1} attempts: ${lastError.message}`,
  );
}

/** One request attempt; throws TransientError for retryable failures. */
async function postJsonOnce(options: PostJsonOptions): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    throw new TransientError((err as Error).message);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TransientError(`API ${res.status}`);
  }
  return res;
}

/** Small linear backoff between retry attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
