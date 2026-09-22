// edgelore · Agent Memory layer — retrieval pipeline tests.
//
// Covers: lexical route (CJK bigrams over Chinese values), vector route with
// a controllable fake embedder, the RRF core property (mid-rank on TWO routes
// beats the top of ONE), the mode ablation switch, one-hop graph expansion
// (conflict siblings + active constraint verdicts), and the in-memory vector
// store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph } from "../../src/model/store.js";
import { capture } from "../../src/agent/capture.js";
import { archiveConversationEvidence } from "../../src/agent/evidence.js";
import type { StatementNode } from "../../src/model/types.js";
import type { EmbeddingDriver } from "../../src/agent/embedding-driver.js";
import {
  expandHit,
  InMemoryVectorStore,
  retrieveRelevant,
  statementText,
} from "../../src/agent/retrieval.js";

const ctx = { created_by: "human:charles", source_refs: ["t:1"] };

/** Embedding driver with a fixed text->vector table (full control of ranks). */
class FakeEmbedder implements EmbeddingDriver {
  readonly dimensions = 2;
  constructor(private readonly table: Map<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.table.get(t) ?? [0, 0]);
  }
}

test("lexical route: CJK bigrams rank the matching statement first", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "replyStyle", value: "回复尽量简洁" }, ctx);
  capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  const hits = await retrieveRelevant(graph, { query: "回复要简洁", mode: "lexical" });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.dimensionKey, "replyStyle");
  assert.equal(hits[0]?.value, "回复尽量简洁");
  assert.deepEqual(hits[0]?.via, ["lexical"]);
});

test("lexical route: unrelated query returns nothing", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  const hits = await retrieveRelevant(graph, { query: "完全无关的查询内容", mode: "lexical" });
  assert.equal(hits.length, 0); // no bigram overlap -> empty route -> no results
});

test("lexical route: verbatim assistant evidence preserves exact payloads", async () => {
  const graph = new MemoryGraph();
  archiveConversationEvidence(
    graph,
    [{ role: "assistant", content: "The Plesiosaur has a blue scaly body and a long neck." }],
    { created_by: "human:charles", source_ref: "session:plesiosaur", createdAt: "2023-05-20" },
  );

  const hits = await retrieveRelevant(graph, {
    query: "What color is the Plesiosaur's scaly body?",
    mode: "lexical",
  });

  assert.equal(hits[0]?.nodeType, "message");
  assert.equal(hits[0]?.dimensionKey, "conversationEvidence");
  assert.equal(hits[0]?.role, "assistant");
  assert.match(String(hits[0]?.value), /blue scaly body/);
  assert.deepEqual(expandHit(graph, hits[0]!), { siblings: [], constraints: [] });
});

test("vector route: fake embedder ranks the semantically-close statement first", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "budget", value: 5000, unit: "CNY" }, ctx);
  capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  const docs = new Map(graph.queryNodes({ type: "core:statement" }).map((s) => [s.id, statementText(graph, s as StatementNode)]));
  const table = new Map<string, number[]>([["预算相关查询", [1, 0]]]);
  for (const [, text] of docs) {
    table.set(text, text.startsWith("budget") ? [0.9, 0.1] : [0, 1]);
  }
  const hits = await retrieveRelevant(graph, {
    query: "预算相关查询",
    mode: "vector",
    embedder: new FakeEmbedder(table),
    vectors: (() => {
      const store = new InMemoryVectorStore();
      for (const [id, text] of docs) {
        store.put(id, table.get(text) as number[]);
      }
      return store;
    })(),
  });
  assert.equal(hits[0]?.dimensionKey, "budget");
  assert.deepEqual(hits[0]?.via, ["vector"]);
});

test("RRF fusion: mid-rank on TWO routes beats the leader of ONE", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "alpha", value: "alpha project" }, ctx); // vector leader only
  capture(graph, { dimensionKey: "budget", value: "预算五千" }, ctx); // mid on both routes
  capture(graph, { dimensionKey: "budgetB", value: "预算六千" }, ctx); // lexical only
  const docs = new Map(
    graph.queryNodes({ type: "core:statement" }).map((s) => [s.id, statementText(graph, s as StatementNode)]),
  );
  const table = new Map<string, number[]>([
    ["预算", [1, 0]],
    ["alpha \"alpha project\"", [1, 0]], // cosine 1.0 -> vector #1
    ["budget \"预算五千\"", [0.7, 0.3]], // cosine ~0.94 -> vector #2
    ["budgetB \"预算六千\"", [0, 1]], // cosine 0 -> off the vector list
  ]);
  const store = new InMemoryVectorStore();
  for (const [id, text] of docs) {
    store.put(id, table.get(text) as number[]);
  }
  const hits = await retrieveRelevant(graph, {
    query: "预算",
    mode: "hybrid",
    embedder: new FakeEmbedder(table),
    vectors: store,
  });
  // vector ranks [alpha, budget]; lexical ranks [budget, budgetB]
  // RRF: budget = 1/62 + 1/61 (both routes) beats alpha = 1/61 (vector only)
  assert.equal(hits[0]?.dimensionKey, "budget");
  assert.deepEqual(hits[0]?.via.sort(), ["lexical", "vector"]);
});

test("RRF fusion returns descending fused scores, not first-route insertion order", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "lexicalOnly", value: "target filler" }, ctx);
  capture(graph, { dimensionKey: "bothRoutes", value: "target exact" }, ctx);
  const nodes = graph.queryNodes({ type: "core:statement" }) as StatementNode[];
  const docs = new Map(nodes.map((node) => [node.id, statementText(graph, node)]));
  const table = new Map<string, number[]>([["target", [1, 0]]]);
  for (const [id, text] of docs) {
    const node = nodes.find((candidate) => candidate.id === id)!;
    table.set(text, node.dimension_id === graph.queryNodes({ type: "core:dimension" }).find((d) => d.key === "bothRoutes")?.id ? [1, 0] : [0, 1]);
  }
  const vectors = new InMemoryVectorStore();
  for (const [id, text] of docs) vectors.put(id, table.get(text)!);

  const hits = await retrieveRelevant(graph, {
    query: "target",
    mode: "hybrid",
    embedder: new FakeEmbedder(table),
    vectors,
  });

  assert.equal(hits[0]?.dimensionKey, "bothRoutes");
  assert.ok((hits[0]?.score ?? 0) >= (hits[1]?.score ?? 0));
});

test("mode ablation: vector-only and lexical-only return their own rankings", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "alpha", value: "alpha project" }, ctx);
  capture(graph, { dimensionKey: "budget", value: "预算五千" }, ctx);
  const docs = new Map(
    graph.queryNodes({ type: "core:statement" }).map((s) => [s.id, statementText(graph, s as StatementNode)]),
  );
  const table = new Map<string, number[]>([
    ["预算", [1, 0]],
    ["alpha \"alpha project\"", [1, 0]],
    ["budget \"预算五千\"", [0.8, 0.2]], // cosine ~0.97 -> second on the vector route
  ]);
  const store = new InMemoryVectorStore();
  for (const [id, text] of docs) {
    store.put(id, table.get(text) as number[]);
  }
  const embedder = new FakeEmbedder(table);
  const vectorOnly = await retrieveRelevant(graph, { query: "预算", mode: "vector", embedder, vectors: store });
  const lexicalOnly = await retrieveRelevant(graph, { query: "预算", mode: "lexical" });
  assert.deepEqual(vectorOnly.map((h) => h.dimensionKey), ["alpha", "budget"]);
  assert.deepEqual(lexicalOnly.map((h) => h.dimensionKey), ["budget"]);
});

test("vector mode without plumbing fails loud", async () => {
  const graph = new MemoryGraph();
  await assert.rejects(
    retrieveRelevant(graph, { query: "x", mode: "vector" }),
    /requires an embedder/,
  );
});

test("expandHit: conflict sibling and constraint verdict ride along", () => {
  const graph = new MemoryGraph();
  const r1 = capture(graph, { dimensionKey: "budget", value: 5000, cardinality: "single", unit: "CNY" }, ctx);
  const constraint = graph.addConstraint({
    participants: [r1.dimensionId],
    bindings: { x1: r1.dimensionId },
    // avg(x1) <= 6000 — bare refs outside an aggregation are an M1 error
    expression: { op: "<=", args: [{ op: "avg", args: [{ ref: "x1" }] }, 6000] },
    created_by: "human:charles",
  });
  graph.transitionConstraintState(constraint.id, "active", { approved_by: "human:charles" });
  const r2 = capture(graph, { dimensionKey: "budget", value: 8000 }, ctx); // clash -> tentative

  const expansion = expandHit(graph, {
    statementId: r2.statementId as string,
    dimensionId: r2.dimensionId,
    dimensionKey: "budget",
    value: 8000,
    state: "tentative",
    score: 1,
    via: ["lexical"],
  });
  assert.equal(expansion.siblings.length, 1);
  assert.equal(expansion.siblings[0]?.value, 5000); // the conflict counterpart
  assert.equal(expansion.siblings[0]?.state, "accepted");
  assert.equal(expansion.constraints.length, 1);
  // Retrieval discloses the tentative challenger, but the constraint engine
  // evaluates the current accepted belief only. Candidate arbitration builds
  // its own hypothetical accepted snapshot in conflicts.ts.
  assert.equal(expansion.constraints[0]?.evaluation, "satisfied");
});

test("in-memory vector store roundtrips", () => {
  const store = new InMemoryVectorStore();
  store.put("a", [1, 2, 3]);
  store.put("a", [4, 5, 6]); // replace
  store.put("b", [7, 8, 9]);
  const all = store.all();
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((e) => e.id === "a")?.vector, [4, 5, 6]);
});

// --- W4: candidate pre-filters (states / date window) -------------------------

test("retrieval: states filter restricts candidates before scoring", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "alice", cardinality: "single" }, ctx); // accepted
  capture(graph, { dimensionKey: "owner", value: "bob", cardinality: "single" }, ctx); // tentative (clash)
  const all = await retrieveRelevant(graph, { query: "alice bob", mode: "lexical" });
  assert.equal(all.length, 2);
  const acceptedOnly = await retrieveRelevant(graph, { query: "alice bob", mode: "lexical", states: ["accepted"] });
  assert.equal(acceptedOnly.length, 1);
  assert.equal(acceptedOnly[0]?.value, "alice");
});

test("retrieval: dateFrom/dateTo window filters candidates inclusively", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "trip", value: "旧金山" }, { ...ctx, createdAt: "2023-01-05T10:00:00Z" });
  capture(graph, { dimensionKey: "trip", value: "夏威夷" }, { ...ctx, createdAt: "2023-06-05T10:00:00Z" });
  const windowed = await retrieveRelevant(graph, {
    query: "旧金山 夏威夷",
    mode: "lexical",
    dateFrom: "2023-06-01",
    dateTo: "2023-12-31",
  });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0]?.value, "夏威夷");
  // inclusive bounds: the exact boundary day is kept
  const edge = await retrieveRelevant(graph, {
    query: "夏威夷",
    mode: "lexical",
    dateFrom: "2023-06-05",
    dateTo: "2023-06-05",
  });
  assert.equal(edge.length, 1);
});

// --- F1-balanced lexical scoring (anti-attractor) -------------------------------

test("lexical route: long attractor documents no longer outrank short precise ones", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "gymSchedule", value: "gym at 6:00 pm" }, ctx);
  capture(graph, {
    dimensionKey: "movieList",
    value:
      "avengers endgame titanic avatar inception godfather pulp matrix fight club gladiator heat rio frozen up cars toy coco soul wall soul power gym 6:00 pm run",
  }, ctx);
  const hits = await retrieveRelevant(graph, { query: "几点去健身房 gym 6:00 pm", mode: "lexical" });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.dimensionKey, "gymSchedule", "short precise doc must beat the long movie list");
});

// --- A3/A5/A6: 日期兼容 + scope 过滤 + 描述桥接 ---------------------------------

test("retrieval: slash-format legacy dates compare correctly against ISO bounds", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "trip", value: "五月出行" }, { ...ctx, createdAt: "2023/05/28" });
  // 斜杠日期若不归一，ASCII 比较 "2023/05/28" > "2023-05-31"（'/'>'-'）→ 会静默漏判
  const inWindow = await retrieveRelevant(graph, {
    query: "出行",
    mode: "lexical",
    dateFrom: "2023-05-01",
    dateTo: "2023-05-31",
  });
  assert.equal(inWindow.length, 1);
  const before = await retrieveRelevant(graph, {
    query: "出行",
    mode: "lexical",
    dateTo: "2023-04-30",
  });
  assert.equal(before.length, 0);
});

test("retrieval: sourceRefsAllow soft-scopes — in-scope ranked first, out-of-scope reachable", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "city", value: "巴黎" }, { ...ctx, source_refs: ["s:alice"] });
  capture(graph, { dimensionKey: "city", value: "罗马" }, { ...ctx, source_refs: ["s:bob"] });
  const scoped = await retrieveRelevant(graph, {
    query: "巴黎 罗马",
    mode: "lexical",
    sourceRefsAllow: ["s:alice"],
  });
  // 确定性优先：范围内永远排在范围外前面（分数不再跨层比较），范围外仍可达
  assert.equal(scoped.length, 2);
  assert.equal(scoped[0]?.value, "巴黎");
  assert.equal(scoped[1]?.value, "罗马");
  const unscoped = await retrieveRelevant(graph, { query: "巴黎 罗马", mode: "lexical" });
  assert.equal(unscoped.length, 2);
});

test("retrieval: statementText bridges numeric values via dimension description", () => {
  const graph = new MemoryGraph();
  const withDesc = capture(graph, { dimensionKey: "videoViews", value: 1456, description: "视频播放量" }, ctx);
  const noDesc = capture(graph, { dimensionKey: "views", value: 42 }, ctx);
  const t1 = statementText(graph, graph.getNode(withDesc.statementId!) as StatementNode);
  const t2 = statementText(graph, graph.getNode(noDesc.statementId!) as StatementNode);
  assert.match(t1, /视频播放量/); // 自然语言桥接进打分文本
  assert.ok(!t2.includes("views views"), "description === key must not be duplicated");
  assert.match(t2, /^views /);
});
