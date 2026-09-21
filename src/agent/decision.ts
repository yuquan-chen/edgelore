// edgelore · Agent Memory layer — System One decision driver (TypeSafe Jev).
//
// The pipeline mixes two kinds of model calls:
//   GENERATION — extract/answer, needs a full LLM (LlmDriver, the main cost)
//   DECISION   — worth storing? relevant? which route? needs only a judgment
// Decisions are latency/cost critical (gate, intent routing, conflict
// flags, refusal gates) and "System One" models answer them in ~100ms for
// near-zero cost. This driver keeps the decision layer pluggable: anything
// that can answer typed questions about a piece of state.

import { AgentError } from "./errors.js";
import { postJsonWithRetry } from "./http.js";

export interface DecisionDriver {
  /** P(yes) for one yes/no question about the state (0..1). */
  noul(state: string, instructions: string): Promise<number>;
  /** Pick one option key for a multiple-choice question about the state. */
  choice(state: string, instructions: string, criteria: Record<string, string>): Promise<string>;
  /** Many yes/no questions about ONE state, answered in a single call (fan-out). */
  noulFanOut(state: string, questions: Record<string, string>): Promise<Record<string, number>>;
}

export interface TypeSafeDecisionOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** HTTP transport override (tests). Defaults to the shared retrying transport. */
  post?: typeof postJsonWithRetry;
}

type Answers = Record<string, { noul?: number; choice?: string }>;

export class TypeSafeDecisionDriver implements DecisionDriver {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly post: typeof postJsonWithRetry;

  constructor(options: TypeSafeDecisionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.post = options.post ?? postJsonWithRetry;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): TypeSafeDecisionDriver {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) throw new AgentError("missing TYPESAFE_API_KEY for the decision driver");
    return new TypeSafeDecisionDriver({
      baseUrl: env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
      apiKey,
      model: env.TYPESAFE_MODEL ?? "jev-latest",
    });
  }

  async noul(state: string, instructions: string): Promise<number> {
    const answers = await this.ask(state, { decision: { type: "noul", instructions } });
    return answers.decision?.noul ?? 0;
  }

  async choice(state: string, instructions: string, criteria: Record<string, string>): Promise<string> {
    const answers = await this.ask(state, { decision: { type: "choice", instructions, criteria } });
    return answers.decision?.choice ?? "";
  }

  async noulFanOut(state: string, questions: Record<string, string>): Promise<Record<string, number>> {
    const typed: Record<string, { type: string; instructions: string }> = {};
    for (const [name, instructions] of Object.entries(questions)) {
      typed[name] = { type: "noul", instructions };
    }
    const answers = await this.ask(state, typed);
    const out: Record<string, number> = {};
    for (const [name, a] of Object.entries(answers)) out[name] = a?.noul ?? 0;
    return out;
  }

  private async ask(state: string, questions: unknown): Promise<Answers> {
    const res = await this.post({
      url: `${this.baseUrl}/v1/systemone`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: { state, model: this.model, questions },
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      stage: "decision",
    });
    if (!res.ok) {
      throw new AgentError(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { answers?: Answers };
    if (!data.answers || typeof data.answers !== "object") {
      throw new AgentError("TypeSafe API reply missing answers object");
    }
    return data.answers;
  }
}
