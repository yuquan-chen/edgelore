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
import { contextMemoriesOf, contextMemoriesViaRetrieval, knownDimensionsOf, processTurn, relevantDimensionsOf } from "../../src/agent/runtime.js";

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
  assert.match(lines[0] ?? "", /budget = 5000 CNY \[accepted @\d{4}-\d{2}-\d{2}\]/);
  assert.match(lines[1] ?? "", /author = "charles" \[accepted @\d{4}-\d{2}-\d{2}\]/);
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
  assert.equal(stored.length, 2); // statement + dimension
  assert.ok(stored[0]?.vector.length >= 8);
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
  // Grouped rendering (W4): header with the graph's own count, then the
  // entry line, then the constraint verdict — 3 lines.
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /budget — 1 entry:/);
  assert.match(lines[1] ?? "", /= 5000 .*\[accepted @\d{4}-\d{2}-\d{2}\]/);
  assert.match(lines[2] ?? "", /rule ".+" -> (satisfied|violated|indeterminate|error)/);
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
  assert.equal(vectors.all().length, 2); // statement + dimension from first turn
});

test("runtime: knownDimensionsOf surfaces stored descriptions (anti-drift signal)", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "charles", description: "项目负责人" }, ctx);
  capture(graph, { dimensionKey: "tags", value: "a" }, ctx);
  const known = knownDimensionsOf(graph);
  assert.equal(known.find((k) => k.key === "owner")?.description, "项目负责人");
  assert.equal(known.find((k) => k.key === "tags")?.description, "tags"); // fallback = key
});

// --- W4: grouped rendering -----------------------------------------------------

test("runtime: grouped context caps entries per dimension but keeps the header count", async () => {
  const graph = new MemoryGraph();
  for (let i = 0; i < 5; i++) capture(graph, { dimensionKey: "trip", value: `trip-${i}` }, ctx);
  const lines = await contextMemoriesViaRetrieval(graph, "trip", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    maxEntriesPerDimension: 3,
  });
  assert.match(lines[0] ?? "", /trip — 5 entries:/); // graph's own count
  const entryLines = lines.filter((l) => l.startsWith("  = "));
  assert.equal(entryLines.length, 3); // capped
});

test("runtime: over-budget dimension degrades to a count-bearing one-liner", async () => {
  const graph = new MemoryGraph();
  for (let i = 0; i < 3; i++) capture(graph, { dimensionKey: "alpha", value: `alpha-${i}` }, ctx);
  for (let i = 0; i < 2; i++) capture(graph, { dimensionKey: "beta", value: `beta-${i}` }, ctx);
  const lines = await contextMemoriesViaRetrieval(graph, "alpha beta", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    maxContextLines: 4,
  });
  const headers = lines.filter((l) => / — \d+ entries?:$/.test(l));
  const degraded = lines.filter((l) => /\(omitted — context budget\)/.test(l));
  // both dimensions present: one as a full group, one as the summary line
  assert.equal(headers.length + degraded.length, 2);
  assert.equal(degraded.length, 1);
  assert.match(degraded[0] ?? "", /: \d+ entries? \(omitted/); // the count survives
});

test("runtime: assistant-authored statements are labelled in grouped context", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "db", value: "PG", saidBy: "assistant" }, ctx);
  capture(graph, { dimensionKey: "db", value: "MySQL" }, ctx);
  const lines = await contextMemoriesViaRetrieval(graph, "PG MySQL", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
  });
  assert.match(lines[0] ?? "", /db — 2 entries:/);
  const assistantLine = lines.find((l) => l.includes("PG"));
  assert.match(assistantLine ?? "", /\(assistant\)/);
  const userLine = lines.find((l) => l.includes("MySQL"));
  assert.ok(!/\(assistant\)/.test(userLine ?? ""));
});

// --- 相关维度选择（批量抽取的 O(维度数) prompt 爆炸修复） -----------------------

test("runtime: relevantDimensionsOf ranks matching dims first and bounds the list", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "gymSchedule", value: "6:00 pm", description: "健身安排" }, ctx);
  capture(graph, { dimensionKey: "weddingsAttended", value: "Sarah" }, ctx);
  capture(graph, { dimensionKey: "apexLevel", value: 100 }, ctx);
  // 再造 40 个不相关维度，验证 limit 截断
  for (let i = 0; i < 40; i++) capture(graph, { dimensionKey: `noise${i}Pad`, value: `noise-${i}` }, ctx);
  const relevant = relevantDimensionsOf(graph, "今天下午六点去健身房锻炼", 30);
  assert.ok(relevant.length <= 30);
  assert.equal(relevant[0]?.key, "gymSchedule"); // 词面命中者登顶
  const relevant2 = relevantDimensionsOf(graph, " completely unrelated text about quantum sailing ", 5);
  assert.ok(relevant2.length <= 5); // 零命中 → 插入序兜底，仍受 limit 约束
});

// --- A1/A5: 双端保留渲染 + scope 分组成员过滤 -----------------------------------

test("runtime: over-cap dimensions render oldest+newest with a gap marker", async () => {
  const graph = new MemoryGraph();
  for (let i = 0; i < 10; i++) {
    capture(graph, { dimensionKey: "trip", value: `trip-${String(i).padStart(2, "0")}` }, ctx);
  }
  const lines = await contextMemoriesViaRetrieval(graph, "trip", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    maxEntriesPerDimension: 8,
  });
  assert.match(lines[0] ?? "", /trip — 10 entries:/); // 图给计数不因截断失真
  const entries = lines.filter((l) => l.startsWith("  = "));
  assert.equal(entries.length, 8); // 4 最旧 + 4 最新
  assert.match(entries[0] ?? "", /trip-00/); // 最旧
  assert.match(entries[entries.length - 1] ?? "", /trip-09/); // 最新（旧版恰好裁掉的就是它）
  const gap = lines.find((l) => l.includes("⋯"));
  assert.match(gap ?? "", /2 more entries/);
});

test("runtime: scopeSessionIds filters group members (identity, not content)", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "hobby", value: "Alice 的爱好" }, { ...ctx, source_refs: ["s:alice"] });
  capture(graph, { dimensionKey: "hobby", value: "Bob 的爱好" }, { ...ctx, source_refs: ["s:bob"] });
  const lines = await contextMemoriesViaRetrieval(graph, "hobby", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    scopeSessionIds: ["s:alice"],
  });
  assert.match(lines[0] ?? "", /hobby — 1 entry:/); // 只剩 Alice 的
  const joined = lines.join("\n");
  assert.match(joined, /Alice 的爱好/);
  assert.ok(!joined.includes("Bob 的爱好"), "scoped-out member must not render");
});

// --- 账本标注渲染（软 scope 的聚合防护） ----------------------------------------

test("runtime: fallback (no in-scope members) tags lines as non-user-account", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "standMixerGift", value: "mixer from sister" }, { ...ctx, source_refs: ["s:twin"] });
  const lines = await contextMemoriesViaRetrieval(graph, "stand mixer", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    scopeSessionIds: ["s:alice"], // 该维度在 alice 账本内无成员 → 走孪生兜底并打标
  });
  assert.match(lines[0] ?? "", /standMixerGift — 1 entry:/);
  assert.match(lines[1] ?? "", /\(non-user-account\)/);
});

test("runtime: in-scope members render without the non-user-account tag", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "hobby", value: "Alice 的爱好" }, { ...ctx, source_refs: ["s:alice"] });
  capture(graph, { dimensionKey: "hobby", value: "Bob 的爱好" }, { ...ctx, source_refs: ["s:bob"] });
  const lines = await contextMemoriesViaRetrieval(graph, "hobby", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    scopeSessionIds: ["s:alice"],
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes("non-user-account"), "scoped render is the account itself — no tag");
  assert.ok(!joined.includes("Bob 的爱好"));
});
