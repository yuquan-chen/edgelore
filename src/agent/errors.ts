// edgelore · Agent Memory layer — typed error.
//
// Per conventions §7: throw typed errors, never raw strings. `ModelError`
// guards the storage layer; `AgentError` guards the Agent Memory layer
// (malformed LLM replies, contract violations in extracted content,
// exhausted mock drivers).

/** Thrown when the Agent Memory layer receives or produces malformed data. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}
