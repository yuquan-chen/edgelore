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
import { archiveConversationEpisode, archiveConversationEvidence } from "../../src/agent/evidence.js";
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

test("runtime: optional enrichment builds graph shape after fact extraction", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["Went to Hawaii with my family"] }),
    JSON.stringify({
      contents: [
        {
          dimensionKey: "NEW:familyTripHawaii",
          value: "Went to Hawaii with my family",
          saidBy: "user",
        },
      ],
    }),
    JSON.stringify({
      factMappings: [
        {
          factRef: "fact:0",
          subjectRef: "$scopeOwner",
          dimensionKey: "familyTrips",
          dimensionDescription: "Family travel experiences",
          cardinality: "multi",
        },
      ],
      entities: [
        { ref: "trip", type: "travel:trip", key: "hawaii-family-trip", scope: "context" },
        { ref: "hawaii", type: "geo:place", key: "hawaii", value: "Hawaii", scope: "global" },
      ],
      relations: [
        { type: "core:about", from: "fact:0", to: "trip" },
        { type: "travel:destination", from: "fact:0", to: "hawaii" },
      ],
    }),
  ]);
  const outcome = await processTurn(
    graph,
    "Went to Hawaii with my family",
    driver,
    { ...ctx, scope: { owner_id: "actor:alice" } },
    { graphEnrichment: {} },
  );
  assert.equal(outcome.graph?.enriched, true);
  assert.equal(outcome.graph?.createdEntities, 2);
  assert.equal(outcome.graph?.createdEdges, 2);
  assert.equal(graph.queryNodes({ type: "core:dimension" })[0]?.key, "familyTrips");
  assert.equal(graph.queryNodes({ type: "travel:trip" }).length, 1);
  assert.equal(graph.queryNodes({ type: "travel:trip" })[0]?.state, "accepted");
});

test("runtime: failed enrichment falls back without losing extracted facts", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({ contents: [{ dimensionKey: "NEW:budget", value: 5000 }] }),
    JSON.stringify({ factMappings: [], entities: [], relations: [] }),
  ]);
  const outcome = await processTurn(
    graph,
    "预算 5000",
    driver,
    ctx,
    { graphEnrichment: {} },
  );
  assert.equal(outcome.graph?.enriched, false);
  assert.match(outcome.graph?.error ?? "", /omitted factRef/);
  assert.equal(outcome.captures.length, 1);
  assert.equal(graph.queryNodes({ type: "core:statement" }).length, 1);
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

test("runtime: verbatim evidence is rendered directly with speaker and date", async () => {
  const graph = new MemoryGraph();
  archiveConversationEvidence(
    graph,
    [{ role: "assistant", content: "The Lost Temple encounter contained exactly 4 mummies." }],
    { created_by: "human:charles", source_ref: "session:temple", createdAt: "2023-04-18" },
  );

  const lines = await contextMemoriesViaRetrieval(graph, "How many mummies were in the Lost Temple?", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    mode: "lexical",
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /conversationEvidence \(verbatim assistant @2023-04-18\)/);
  assert.match(lines[0] ?? "", /exactly 4 mummies/);
});

test("runtime: a Claim hit recovers focused verbatim evidence from its cold Episode", async () => {
  const graph = new MemoryGraph();
  archiveConversationEpisode(
    graph,
    [
      { role: "user", content: "Which database would fit the analytics service?" },
      {
        role: "assistant",
        content: "I recommend PostgreSQL 16 because the workload needs JSONB and reliable transactions.",
      },
      { role: "user", content: "Thanks, I will compare hosting prices later." },
    ],
    { created_by: "human:charles", source_ref: "session:database", createdAt: "2023-06-12" },
  );
  capture(
    graph,
    {
      dimensionKey: "databaseRecommendation",
      value: "PostgreSQL for the analytics service",
      saidBy: "assistant",
    },
    { ...ctx, source_refs: ["session:database"] },
  );

  const lines = await contextMemoriesViaRetrieval(graph, "Which database did the assistant recommend?", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    mode: "lexical",
  });
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence"));
  assert.ok(evidence.some((line) => line.includes("PostgreSQL 16")));
  assert.ok(evidence.some((line) => line.includes("source session:database")));
  assert.equal(graph.queryNodes({ type: "core:message" }).length, 0, "cold recovery must not create Message nodes");
});

test("runtime: cold Episode recovery respects account scope and does not mix fallback sources", async () => {
  const graph = new MemoryGraph();
  for (const [source, answer] of [["s:alice", "Alice chose PostgreSQL"], ["s:bob", "Bob chose MySQL"]] as const) {
    archiveConversationEpisode(
      graph,
      [{ role: "assistant", content: answer }],
      { created_by: "human:charles", source_ref: source, createdAt: "2023-06-12" },
    );
    capture(
      graph,
      { dimensionKey: "databaseChoice", value: answer, saidBy: "assistant" },
      { ...ctx, source_refs: [source] },
    );
  }
  const lines = await contextMemoriesViaRetrieval(graph, "database choice PostgreSQL MySQL", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    mode: "lexical",
    scopeSessionIds: ["s:alice"],
  });
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence")).join("\n");
  assert.match(evidence, /Alice chose PostgreSQL/);
  assert.ok(!evidence.includes("Bob chose MySQL"));
});

test("runtime: scoped cold lexical fallback recovers a fact missing from Claims", async () => {
  const graph = new MemoryGraph();
  archiveConversationEpisode(
    graph,
    [{ role: "assistant", content: "The song Evolution best demonstrates the band's growth on the Fifth Album." }],
    { created_by: "human:charles", source_ref: "s:fifth-album", createdAt: "2023-05-20" },
  );
  // The extractor retained an unrelated memory but completely missed the
  // requested assistant detail. There is deliberately no Claim for Evolution.
  capture(
    graph,
    { dimensionKey: "musicGenre", value: "indie folk" },
    { ...ctx, source_refs: ["s:fifth-album"] },
  );
  const lines = await contextMemoriesViaRetrieval(
    graph,
    "Which Fifth Album song best demonstrated the band's growth?",
    {
      embedder: new MockEmbedder(8),
      vectors: new InMemoryVectorStore(),
      mode: "lexical",
      scopeSessionIds: ["s:fifth-album"],
    },
  );
  assert.ok(lines.some((line) => line.includes("song Evolution")));
});

test("runtime: cold Episode evidence gives each relevant source a quota", async () => {
  const graph = new MemoryGraph();
  archiveConversationEpisode(
    graph,
    [{ role: "user", content: "The Hawaii family trip lasted ten days." }],
    { created_by: "human:charles", source_ref: "s:hawaii", createdAt: "2023-05-21" },
  );
  archiveConversationEpisode(
    graph,
    [{ role: "user", content: "The New York City solo trip lasted five days." }],
    { created_by: "human:charles", source_ref: "s:new-york", createdAt: "2023-05-20" },
  );
  capture(
    graph,
    { dimensionKey: "familyTrips", value: "Completed a family trip to Hawaii" },
    { ...ctx, source_refs: ["s:hawaii"] },
  );
  capture(
    graph,
    { dimensionKey: "soloTrips", value: "Completed a solo trip to New York City" },
    { ...ctx, source_refs: ["s:new-york"] },
  );

  const lines = await contextMemoriesViaRetrieval(
    graph,
    "How many days did I travel in Hawaii and New York City?",
    {
      embedder: new MockEmbedder(8),
      vectors: new InMemoryVectorStore(),
      mode: "lexical",
      scopeSessionIds: ["s:hawaii", "s:new-york"],
      maxEpisodeEvidenceLines: 2,
    },
  );
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence")).join("\n");
  assert.match(evidence, /ten days/);
  assert.match(evidence, /five days/);
});

test("runtime: Claim lanes recover adjacent detail without adding Message nodes", async () => {
  const graph = new MemoryGraph();
  archiveConversationEpisode(
    graph,
    [
      { role: "user", content: "Max needs flea medication every two weeks." },
      { role: "assistant", content: "Ask the dog walker whether medication is included." },
      {
        role: "user",
        content: "Which collar would suit a Golden Retriever like Max?",
      },
      { role: "assistant", content: "A durable nylon collar would work well." },
      { role: "user", content: "I chose a nylon collar and engraved name tag for Max." },
    ],
    { created_by: "human:charles", source_ref: "s:max", createdAt: "2023-05-22" },
  );
  capture(
    graph,
    { dimensionKey: "dogMedication", value: "Max needs flea medication every two weeks" },
    { ...ctx, source_refs: ["s:max"] },
  );
  capture(
    graph,
    { dimensionKey: "dogCollarChoice", value: "Chose a nylon collar for Max" },
    { ...ctx, source_refs: ["s:max"] },
  );

  const lines = await contextMemoriesViaRetrieval(graph, "What breed is my dog?", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    mode: "lexical",
    scopeSessionIds: ["s:max"],
    maxEpisodeEvidenceLines: 6,
  });
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence")).join("\n");
  assert.match(evidence, /Golden Retriever/);
  assert.equal(graph.queryNodes({ type: "core:message" }).length, 0);
});

test("runtime: long Episode evidence uses complete semantic units under the fixed budget", async () => {
  const graph = new MemoryGraph();
  const longAnswer = [
    "# The Lost Temple of the Djinn",
    "The party crosses the desert and enters the buried temple.",
    ...Array.from({ length: 20 }, (_, index) => `Background paragraph ${index + 1} describes an ancient chamber and its traps.`),
    "* Mummies (4):",
    "  + Armor Class: 11",
    "  + Hit Points: 45",
    "* Construct Guardians (2):",
    "  + Armor Class: 17",
  ].join("\n\n");
  archiveConversationEpisode(
    graph,
    [{ role: "assistant", content: longAnswer }],
    { created_by: "human:charles", source_ref: "s:temple", createdAt: "2023-05-21" },
  );
  capture(
    graph,
    {
      dimensionKey: "dndOneShot",
      value: "The Lost Temple includes mummies and construct guardians",
      saidBy: "assistant",
    },
    { ...ctx, source_refs: ["s:temple"] },
  );

  const lines = await contextMemoriesViaRetrieval(
    graph,
    "How many mummies will the party face in the Lost Temple?",
    {
      embedder: new MockEmbedder(8),
      vectors: new InMemoryVectorStore(),
      mode: "lexical",
      scopeSessionIds: ["s:temple"],
      maxEpisodeEvidenceLines: 6,
      maxEpisodeExcerptChars: 220,
    },
  );
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence"));
  assert.ok(evidence.length <= 6);
  assert.ok(evidence.some((line) => line.includes("Mummies (4)")));
  assert.ok(evidence.every((line) => !line.includes("…")), "must not use arbitrary character slices");
  assert.ok(evidence.every((line) => line.length <= 420), "metadata plus each semantic unit stays bounded");
});

test("runtime: relative time prioritizes reported events in the matching Episode", async () => {
  const graph = new MemoryGraph();
  archiveConversationEpisode(
    graph,
    [
      { role: "user", content: "I attended a gardening workshop and learned crop rotation." },
      { role: "user", content: "I use a gardening app to monitor soil moisture." },
    ],
    { created_by: "human:charles", source_ref: "s:garden-old", createdAt: "2023-04-15" },
  );
  archiveConversationEpisode(
    graph,
    [
      {
        role: "user",
        content: "I'm looking for advice about tomato plants. By the way, I just planted 12 new tomato saplings today and I'm excited to see them grow.",
      },
      { role: "user", content: "I'm not sure how often I should water my tomato plants during this dry spell?" },
      { role: "user", content: "Can neem oil control aphids on my tomato plants?" },
      { role: "user", content: "I might use mulch to conserve water." },
      { role: "user", content: "Should I build a trellis for the cucumber plants?" },
    ],
    { created_by: "human:charles", source_ref: "s:garden-target", createdAt: "2023-04-21" },
  );
  capture(
    graph,
    { dimensionKey: "gardeningWorkshop", value: "Attended a gardening workshop" },
    { ...ctx, source_refs: ["s:garden-old"], createdAt: "2023-04-15" },
  );
  capture(
    graph,
    { dimensionKey: "gardenMulching", value: "Gardening plan: considering mulch for water conservation" },
    { ...ctx, source_refs: ["s:garden-target"], createdAt: "2023-04-21" },
  );
  capture(
    graph,
    { dimensionKey: "gardenPestControl", value: "Gardening pest control with neem oil for tomato plant aphids" },
    { ...ctx, source_refs: ["s:garden-target"], createdAt: "2023-04-21" },
  );

  const lines = await contextMemoriesViaRetrieval(
    graph,
    "What tomato gardening activity did I do two weeks ago?",
    {
      embedder: new MockEmbedder(8),
      vectors: new InMemoryVectorStore(),
      mode: "lexical",
      scopeSessionIds: ["s:garden-old", "s:garden-target"],
      dateTo: "2023-05-05",
      maxEpisodeEvidenceLines: 6,
    },
  );
  const evidence = lines.filter((line) => line.startsWith("conversationEvidence")).join("\n");
  assert.match(evidence, /planted 12 new tomato saplings/);
});

test("runtime: core:about expands a direct Claim to a bounded related Slot", async () => {
  const graph = new MemoryGraph();
  const trip = graph.addNode({
    type: "travel:trip",
    key: "hawaii-trip",
    value: "Hawaii family trip",
    state: "accepted",
    created_by: "human:charles",
  });
  const summaryResult = capture(
    graph,
    { dimensionKey: "familyTrips", value: "Family trip to Hawaii" },
    ctx,
  );
  const activityResult = capture(
    graph,
    { dimensionKey: "tripActivities", value: "Snorkeling at Hanauma Bay" },
    ctx,
  );
  const summary = graph.getNode(summaryResult.statementId!);
  const activity = graph.getNode(activityResult.statementId!);
  assert.ok(summary);
  assert.ok(activity);
  graph.addEdge({ type: "core:about", from: summary.id, to: trip.id, created_by: "human:charles" });
  graph.addEdge({ type: "core:about", from: activity.id, to: trip.id, created_by: "human:charles" });

  const lines = await contextMemoriesViaRetrieval(graph, "Tell me about the Hawaii family trip", {
    embedder: new MockEmbedder(8),
    vectors: new InMemoryVectorStore(),
    mode: "lexical",
    k: 1,
    maxGraphExpansionHits: 1,
  });
  const joined = lines.join("\n");
  assert.match(joined, /familyTrips/);
  assert.match(joined, /tripActivities/);
  assert.match(joined, /Snorkeling at Hanauma Bay/);
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
