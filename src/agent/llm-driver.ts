// edgelore · Agent Memory layer — LLM driver boundary.
//
// The layer never talks to a concrete model. It only knows the `LlmDriver`
// interface; a real backend (hosted API, local model) plugs in later by
// implementing it. `MockDriver` is the default: it replays preset replies so
// the whole pipeline is testable offline and for free (frozen decision #5).

import { AgentError } from "./errors.js";

/** The only thing the Agent Memory layer asks of any model. */
export interface LlmDriver {
  /**
   * Run a prompt against the model and return its raw text reply.
   * @param prompt fully assembled prompt (see src/agent/prompt.ts)
   * @returns the model's raw reply text — JSON parsing is NOT this method's job
   */
  complete(prompt: string): Promise<string>;
}

/**
 * Replay-style driver for tests: returns the preset replies in order.
 * A test that receives more `complete()` calls than presets (or fewer —
 * assert via `remaining`) has an orchestration bug; surfacing it loudly is
 * the point.
 */
export class MockDriver implements LlmDriver {
  private readonly replies: string[];
  private cursor = 0;

  /**
   * @param replies preset model replies, consumed first-in-first-out
   */
  constructor(replies: string[]) {
    this.replies = [...replies];
  }

  /** @returns how many preset replies are still queued. */
  get remaining(): number {
    return this.replies.length - this.cursor;
  }

  async complete(_prompt: string): Promise<string> {
    if (this.cursor >= this.replies.length) {
      throw new AgentError(
        `MockDriver queue exhausted (no preset reply left for prompt "${truncate(_prompt)}")`,
      );
    }
    const reply = this.replies[this.cursor];
    this.cursor += 1;
    return reply;
  }
}

/**
 * Parse a model reply into a JS value, tolerating the usual decorations
 * (markdown code fences, prose around the JSON object) by slicing from the
 * first "{" to the last "}".
 *
 * Assumption: the reply contains exactly one top-level JSON object. Anything
 * else is a contract violation and fails loud — never silently swallowed.
 *
 * @param raw the model's raw reply text
 * @returns the parsed JSON value
 * @throws AgentError if the reply contains no `{...}` object or invalid JSON
 */
export function parseJsonReply(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AgentError(`LLM reply contains no JSON object: "${truncate(raw)}"`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new AgentError(`LLM reply is not valid JSON: "${truncate(raw)}"`);
  }
}

/** Shorten a string for inclusion in an error message. */
function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
