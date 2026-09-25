import assert from "node:assert/strict";
import test from "node:test";
import { appendEpisode } from "../../src/agent/evidence.js";
import { recall } from "../../src/agent/recall.js";
import { capture } from "../../src/agent/capture.js";
import { MemoryGraph } from "../../src/model/store.js";

test("host API: appendEpisode is idempotent and rejects conflicting reuse", () => {
  const graph = new MemoryGraph();
  const input = {
    id: "conversation:one",
    turns: [{ role: "user", content: "I prefer quiet hotels." }],
    createdBy: "agent:host:test",
    scope: { owner_id: "alice", project_id: "trip-planning", phase_id: "planning" },
  };

  const first = appendEpisode(graph, input);
  const second = appendEpisode(graph, input);
  assert.equal(second.id, first.id);
  assert.equal(graph.getAllEpisodes().length, 1);
  assert.deepEqual(second.scope, input.scope);
  assert.throws(
    () => appendEpisode(graph, { ...input, turns: [{ role: "user", content: "Changed." }] }),
    /immutable and already has different content or identity/,
  );
  assert.throws(
    () => appendEpisode(graph, { ...input, scope: { ...input.scope, owner_id: "bob" } }),
    /immutable and already has different content or identity/,
  );
});

test("host API: explicit owner/project/phase scope strictly isolates capsule claims and evidence", async () => {
  const graph = new MemoryGraph();
  const aliceScope = { owner_id: "alice", project_id: "trip-planning", phase_id: "planning" };
  const bobScope = { owner_id: "bob", project_id: "trip-planning", phase_id: "planning" };

  appendEpisode(graph, {
    id: "conversation:alice",
    turns: [{ role: "user", content: "My vehicle is a blue electric bicycle." }],
    createdBy: "agent:host:test",
    scope: aliceScope,
  });
  appendEpisode(graph, {
    id: "conversation:bob",
    turns: [{ role: "user", content: "My vehicle is a red delivery van." }],
    createdBy: "agent:host:test",
    scope: bobScope,
  });
  capture(
    graph,
    { dimensionKey: "vehicle", value: "blue electric bicycle", saidBy: "user" },
    { created_by: "agent:host:test", source_refs: ["conversation:alice"], scope: aliceScope },
  );
  capture(
    graph,
    { dimensionKey: "vehicle", value: "red delivery van", saidBy: "user" },
    { created_by: "agent:host:test", source_refs: ["conversation:bob"], scope: bobScope },
  );

  const capsule = await recall(graph, "what is my vehicle", {
    scope: { ...aliceScope, sessionIds: ["conversation:alice"] },
    retrieval: { mode: "lexical" },
  });

  assert.deepEqual(capsule.claims.map((claim) => claim.value), ["blue electric bicycle"]);
  assert.deepEqual(capsule.claims[0]?.sourceRefs, ["conversation:alice"]);
  assert.deepEqual(capsule.evidence.map((evidence) => evidence.sourceId), ["conversation:alice"]);
  assert.ok(!capsule.context.some((line) => line.includes("delivery van")));
});

test("host API: session-id filter alone remains distinct from exact identity scope", async () => {
  const graph = new MemoryGraph();
  appendEpisode(graph, {
    id: "conversation:shared-scope",
    turns: [{ role: "user", content: "My preferred editor is Vim." }],
    createdBy: "agent:host:test",
  });
  capture(
    graph,
    { dimensionKey: "preferredEditor", value: "Vim", saidBy: "user" },
    { created_by: "agent:host:test", source_refs: ["conversation:shared-scope"] },
  );
  const capsule = await recall(graph, "preferred editor", {
    scope: { sessionIds: ["conversation:shared-scope"] },
    retrieval: { mode: "lexical" },
  });
  assert.equal(capsule.claims[0]?.value, "Vim");
});
