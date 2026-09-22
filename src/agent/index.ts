// edgelore · Agent Memory layer — public barrel.
//
// Two-layer model (M3 spec §8): the agent layer (this folder) turns human
// language into CaptureContent candidates; the storage layer (capture.ts)
// persists them. The agent layer NEVER calls capture itself — the runtime
// orchestrates: gate -> extract -> (runtime injects provenance) -> capture.

export * from "./capture.js";
export * from "./graph-write.js";
export * from "./graph-enrichment.js";
export * from "./errors.js";
export * from "./llm-driver.js";
export * from "./prompt.js";
export * from "./gate.js";
export * from "./lang.js";
export * from "./extract.js";
export * from "./runtime.js";
export * from "./openai-compat-driver.js";
export * from "./embedding-driver.js";
export * from "./decision.js";
export * from "./usage.js";
export * from "./http.js";
export * from "./retrieval.js";
export * from "./conflicts.js";
export * from "./ask.js";
export * from "./triggers.js";
