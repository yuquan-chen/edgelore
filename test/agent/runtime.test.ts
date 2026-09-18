// edgelore · Agent Memory layer — runtime orchestrator tests.
//
// Covers processTurn end-to-end on the in-memory graph with MockDriver:
// NOOP short-circuit (extract driver never called), full capture with
// provenance injection, conflict surfacing, and the two context recipes
// (knownDimensionsOf unit-borrowing, contextMemoriesOf formatting + cap).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph } from "../../src/model/store.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { capture } from "../../src/agent/capture.js";
import { AgentError } from "../../src/agent/errors.js";
import { MockEmbedder, type EmbeddingDriver } from "../../src/agent/embedding-driver.js";
import { InMemoryVectorStore } from "../../src/agent/retrieval.js";
import { contextMemoriesOf, contextMemoriesViaRetrieval, knownDimensionsOf, processTurn } from "../../src/agent/runtime.js";

const ctx = { created_by: "human:charles", source_refs: ["t:1"] };

test("runtime: gate NOOP skips extract entirely", async () => {
  const graph = new MemoryGraph();
  // Single-reply queue: if extract were wrongly called, MockDriver throws.
  const driver = new MockDriver([JSON.stringify({ store: false, candidates: [], reason: "客套" })]);
  const outcome = await processTurn(graph, "谢谢啦", driver, ctx);
  assert.equal(outcome.gate.store, false);
  assert.equal(outcome.gate.reason, "客套");
  assert.equal(outcome.captures.length, 0);
});

test("runtime: full turn captures into the graph with runtime-injected provenance", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({
      contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }],
    }),
  ]);
  const outcome = await processTurn(graph, "项目预算 5000 元", driver, ctx);
  assert.equal(outcome.gate.store, true);
  assert.equal(outcome.captures.length, 1);
  assert.equal(outcome.captures[0]?.created, true);
  assert.equal(outcome.captures[0]?.conflict, false);
  const stmts = graph.queryNodes({ type: "core:statement" }) as Array<{ value: unknown; created_by: string }>;
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0]?.value, 5000);
  assert.equal(stmts[0]?.created_by, "human:charles"); // from ctx, never the LLM
});

test("runtime: conflicting turn surfaces conflict via capture", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    // turn 1: budget 5000
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single" }] }),
    // turn 2: budget 8000 -> clash
    JSON.stringify({ store: true, candidates: ["预算 8000"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:budget", value: 8000 }] }),
  ]);
  const first = await processTurn(graph, "预算 5000", driver, ctx);
  assert.equal(first.captures[0]?.conflict, false);
  const second = await processTurn(graph, "预算改成 8000", driver, ctx);
  assert.equal(second.captures[0]?.conflict, true);
  const dim = graph.queryNodes({ type: "core:dimension" })[0] as { state: string };
  assert.equal(dim.state, "conflict");
});

test("runtime: identical turn deduplicates through capture", async () => {
  const graph = new MemoryGraph();
  const replies = [
    JSON.stringify({ store: true, candidates: ["作者是 charles"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:author", value: "charles" }] }),
  ];
  const first = await processTurn(graph, "作者是 charles", new MockDriver(replies), ctx);
  const second = await processTurn(graph, "作者是 charles", new MockDriver(replies), ctx);
  assert.equal(first.captures[0]?.deduplicated, false);
  assert.equal(second.captures[0]?.deduplicated, true);
});

test("runtime: gate says store but extractor empty -> recorded, zero captures", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["某句话"] }),
    JSON.stringify({ contents: [] }),
  ]);
  const outcome = await processTurn(graph, "某句话", driver, ctx);
  assert.equal(outcome.gate.store, true);
  assert.match(outcome.gate.reason ?? "", /no entries/);
  assert.equal(outcome.captures.length, 0);
});

test("runtime: knownDimensionsOf borrows unit from statements, defaults cardinality", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "budget", value: 5000, unit: "CNY" }, ctx);
  capture(graph, { dimensionKey: "tags", value: "a" }, ctx);
  const known = knownDimensionsOf(graph);
  const budget = known.find((k) => k.key === "budget");
  const tags = known.find((k) => k.key === "tags");
  assert.equal(budget?.unit, "CNY"); // borrowed from its statement
  assert.equal(budget?.cardinality, "multi"); // capture default
  assert.equal(tags?.unit, undefined);
  assert.equal(tags?.description, "tags");
});

test("runtime: contextMemoriesOf formats key=value[state] lines and caps by limit", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "budget", value: 5000, unit: "CNY" }, ctx);
  capture(graph, { dimensionKey: "author", value: "charles" }, ctx);
  const lines = contextMemoriesOf(graph);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /budget = 5000 CNY \[accepted\]/);
  assert.match(lines[1] ?? "", /author = "charles" \[accepted\]/);
  const capped = contextMemoriesOf(graph, 1);
  assert.equal(capped.length, 1);
  assert.match(capped[0] ?? "", /author/); // newest kept
});

test("runtime: retrieval config embeds new statements after capture", async () => {
  const graph = new MemoryGraph();
  const vectors = new InMemoryVectorStore();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({
      contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }],
    }),
  ]);
  const outcome = await processTurn(graph, "项目预算 5000 元", driver, ctx, {
    retrieval: { embedder: new MockEmbedder(8), vectors },
  });
  assert.equal(outcome.indexed, 1);
  assert.equal(outcome.indexError, undefined);
  const stored = vectors.all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.vector.length, 8);
});

test("runtime: embedding failure after capture does NOT fail the turn", async () => {
  const graph = new MemoryGraph();
  const vectors = new InMemoryVectorStore();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:budget", value: 5000 }] }),
  ]);
  const boom: EmbeddingDriver = {
    dimensions: 8,
    embed: async () => {
      throw new AgentError("embedding endpoint down");
    },
  };
  const outcome = await processTurn(graph, "项目预算 5000 元", driver, ctx, {
    retrieval: { embedder: boom, vectors },
  });
  assert.equal(outcome.captures.length, 1); // memory IS stored
  assert.equal(outcome.indexed, 0);
  assert.match(outcome.indexError ?? "", /embedding endpoint down/);
});

test("runtime: retrieval-based context carries conflict posture and constraint verdicts", async () => {
  const graph = new MemoryGraph();
  const vectors = new InMemoryVectorStore();
  const embedder = new MockEmbedder(8);
  const retrieval = { embedder, vectors };
  // Turn 1: budget 5000 (indexed).
  const first = await processTurn(graph, "预算 5000", new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single" }] }),
  ]), ctx, { retrieval });
  assert.equal(first.indexed, 1);
  // Active constraint on the budget dimension.
  const constraint = graph.addConstraint({
    participants: [first.captures[0]?.dimensionId as string],
    bindings: { x1: first.captures[0]?.dimensionId as string },
    expression: { op: "<=", args: [{ op: "avg", args: [{ ref: "x1" }] }, 6000] },
    created_by: "human:charles",
  });
  graph.transitionConstraintState(constraint.id, "active", { approved_by: "human:charles" });

  const lines = await contextMemoriesViaRetrieval(graph, "预算", retrieval);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /budget = 5000 /);
  assert.match(lines[0] ?? "", /constraint ".+" -> (satisfied|violated|indeterminate|error)/);
});

test("runtime: deduplicated capture embeds nothing new", async () => {
  const graph = new MemoryGraph();
  const vectors = new InMemoryVectorStore();
  const retrieval = { embedder: new MockEmbedder(8), vectors };
  const replies = [
    JSON.stringify({ store: true, candidates: ["作者是 charles"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:author", value: "charles" }] }),
  ];
  await processTurn(graph, "作者是 charles", new MockDriver(replies), ctx, { retrieval });
  const second = await processTurn(graph, "作者是 charles", new MockDriver(replies), ctx, { retrieval });
  assert.equal(second.captures[0]?.deduplicated, true);
  assert.equal(second.indexed, 0); // nothing new to embed
  assert.equal(vectors.all().length, 1);
});

test("runtime: knownDimensionsOf surfaces stored descriptions (anti-drift signal)", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "charles", description: "项目负责人" }, ctx);
  capture(graph, { dimensionKey: "tags", value: "a" }, ctx);
  const known = knownDimensionsOf(graph);
  assert.equal(known.find((k) => k.key === "owner")?.description, "项目负责人");
  assert.equal(known.find((k) => k.key === "tags")?.description, "tags"); // fallback = key
});
