// edgelore — shared memory graph for AI agents.
//
// M0 is frozen: this package exposes the data model (types), the identifier /
// namespace validators, the state machines, and an in-memory reference store.
// See docs/shared-memory-m0-spec.md and schema.json for the contract.

export * from "./model/index.js";
export * from "./store/sqlite.js";
export * from "./agent/capture.js";

export const name = "edgelore";
export const version = "0.0.1";
