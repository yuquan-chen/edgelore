import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyFactRelationProposal,
  reconcileStatement,
  type FactRelationProposal,
} from "../../src/agent/fact-reconciler.js";
import { capture } from "../../src/agent/capture.js";
import { listConflicts } from "../../src/agent/conflicts.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { MemoryGraph, type GraphStore } from "../../src/model/store.js";
import type { DimensionNode, StatementNode } from "../../src/model/types.js";
import { SqliteGraph } from "../../src/store/sqlite.js";

const actorScope = { owner_id: "actor:alice" };

function addDimension(
  graph: GraphStore,
  key: string,
  cardinality: "single" | "multi" = "multi",
): DimensionNode {
  return graph.addNode({
    type: "core:dimension",
    key,
    cardinality,
    state: "accepted",
    scope: actorScope,
    created_by: "agent:test:1",
  }) as DimensionNode;
}

function addStatement(
  graph: GraphStore,
  dimension: DimensionNode,
  value: unknown,
  state: "accepted" | "tentative" = "accepted",
  createdAt?: string,
): StatementNode {
  return graph.addNode({
    type: "core:statement",
    dimension_id: dimension.id,
    value,
    state,
    scope: actorScope,
    created_by: "agent:test:1",
    source_refs: ["session:test"],
    created_at: createdAt,
  }) as StatementNode;
}

test("fact reconciler: normalized duplicate is deterministic and skips the Agent", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "familyTrips");
  const old = addStatement(graph, dimension, "Family trip to Hawaii");
  const fresh = addStatement(graph, dimension, "  FAMILY   TRIP TO HAWAII  ");
  const driver = new MockDriver(["unused"]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.equal(driver.remaining, 1);
  assert.deepEqual(result.unresolvedIds, []);
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0], {
    subjectId: fresh.id,
    objectId: old.id,
    relation: "duplicate",
    basis: "deterministic",
    confidence: 1,
    reason: "normalized values are equal",
    requiresApproval: false,
  });
});

test("fact reconciler: different live values in one single Dimension contradict deterministically", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative");

  const result = await reconcileStatement(graph, fresh.id);

  assert.equal(result.proposals[0]?.objectId, old.id);
  assert.equal(result.proposals[0]?.relation, "contradicts");
  assert.equal(result.proposals[0]?.basis, "deterministic");
  assert.equal(result.proposals[0]?.requiresApproval, false);
});

test("fact reconciler: ambiguous neighbors remain unresolved without an Agent", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "familyTrips");
  const old = addStatement(graph, dimension, "Family trip to Hawaii");
  const fresh = addStatement(graph, dimension, "Snorkeled during the Hawaii trip");

  const result = await reconcileStatement(graph, fresh.id);

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.unresolvedIds, [old.id]);
});

test("fact reconciler: Agent classification is a proposal and cannot mutate the graph", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "familyTrips");
  const old = addStatement(graph, dimension, "Family trip to Hawaii");
  const fresh = addStatement(graph, dimension, "Snorkeled during the Hawaii trip");
  const driver = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: old.id,
          relation: "refines",
          confidence: 0.91,
          reason: "adds a compatible activity detail",
        },
      ],
    }),
  ]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.equal(result.proposals[0]?.relation, "refines");
  assert.equal(result.proposals[0]?.basis, "agent");
  assert.equal(result.proposals[0]?.requiresApproval, true);
  assert.equal(graph.queryEdges({ type: "core:refines" }).length, 0);
  assert.equal(graph.getNode(old.id)?.state, "accepted");
  assert.equal(graph.getNode(fresh.id)?.state, "accepted");
});

test("fact reconciler: omitted Agent decisions stay unresolved", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "familyTrips");
  const hawaii = addStatement(graph, dimension, "Family trip to Hawaii", "accepted", "2024-01-01T00:00:00.000Z");
  const paris = addStatement(graph, dimension, "Family trip to Paris", "accepted", "2024-02-01T00:00:00.000Z");
  const fresh = addStatement(graph, dimension, "The kids preferred Paris", "accepted", "2024-03-01T00:00:00.000Z");
  const driver = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: paris.id,
          relation: "refines",
          confidence: 0.8,
          reason: "adds preference detail to the Paris trip",
        },
      ],
    }),
  ]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.unresolvedIds, [hawaii.id]);
});

test("fact reconciler: Agent proposal requires human approval before materialization", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "familyTrips");
  const old = addStatement(graph, dimension, "Family trip to Hawaii");
  const fresh = addStatement(graph, dimension, "Snorkeled during the Hawaii trip");
  const proposal: FactRelationProposal = {
    subjectId: fresh.id,
    objectId: old.id,
    relation: "refines",
    basis: "agent",
    confidence: 0.9,
    reason: "compatible added detail",
    requiresApproval: false,
  };

  assert.throws(() => applyFactRelationProposal(graph, proposal), /requires approvedBy human:<id>/);
  const result = applyFactRelationProposal(graph, proposal, { approvedBy: "human:alice" });
  assert.ok(result.edgeId);
  assert.equal(graph.queryEdges({ type: "core:refines" }).length, 1);
});

test("fact reconciler: applying a contradiction opens the existing conflict docket", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative");
  const proposal = (await reconcileStatement(graph, fresh.id)).proposals[0];
  assert.ok(proposal);

  applyFactRelationProposal(graph, proposal);

  assert.equal(graph.getNode(dimension.id)?.state, "conflict");
  assert.equal(graph.queryEdges({ type: "core:contradicts", from: fresh.id, to: old.id }).length, 1);
  const docket = listConflicts(graph);
  assert.equal(docket.length, 1);
  assert.deepEqual(new Set(docket[0]?.participantIds), new Set([fresh.id, old.id]));
});

test("fact reconciler: approved supersession promotes the new fact and preserves history", () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative");
  const proposal: FactRelationProposal = {
    subjectId: fresh.id,
    objectId: old.id,
    relation: "supersedes",
    basis: "agent",
    confidence: 0.95,
    reason: "the user explicitly said they moved",
    requiresApproval: true,
  };

  const result = applyFactRelationProposal(graph, proposal, { approvedBy: "human:alice" });

  assert.equal(result.subjectState, "accepted");
  assert.equal(result.objectState, "superseded");
  assert.equal(graph.queryEdges({ type: "core:supersedes", from: fresh.id, to: old.id }).length, 1);
});

test("fact reconciler: an Agent can turn capture's conflict flag into an approved update", async () => {
  const graph = new MemoryGraph();
  const context = {
    created_by: "agent:ingestion:1",
    source_refs: ["session:move"],
    scope: actorScope,
  };
  const old = capture(
    graph,
    { dimensionKey: "homeCity", value: "Shenzhen", cardinality: "single", saidBy: "user" },
    context,
  );
  const fresh = capture(
    graph,
    { dimensionKey: "homeCity", value: "Shanghai", cardinality: "single", saidBy: "user" },
    context,
  );
  assert.equal(graph.getNode(old.dimensionId)?.state, "conflict");
  assert.equal(graph.queryEdges({ type: "core:contradicts" }).length, 1);
  const driver = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: old.statementId,
          relation: "supersedes",
          confidence: 0.97,
          reason: "the new statement explicitly updates the current home city",
        },
      ],
    }),
  ]);

  const reconciliation = await reconcileStatement(graph, fresh.statementId as string, { driver });
  assert.equal(reconciliation.proposals[0]?.relation, "supersedes");
  const result = applyFactRelationProposal(graph, reconciliation.proposals[0]!, {
    approvedBy: "human:alice",
  });

  assert.equal(result.subjectState, "accepted");
  assert.equal(result.objectState, "superseded");
  assert.equal(graph.getNode(old.dimensionId)?.state, "accepted");
  assert.deepEqual(listConflicts(graph), []);
});

test("fact reconciler: shared core:about target links candidates across Dimensions", async () => {
  const graph = new MemoryGraph();
  const trip = graph.addNode({
    type: "travel:trip",
    key: "hawaii-2024",
    scope: actorScope,
    state: "accepted",
    created_by: "agent:test:1",
  });
  const tripDimension = addDimension(graph, "familyTrips");
  const activityDimension = addDimension(graph, "tripActivities");
  const old = addStatement(graph, tripDimension, "Family trip to Hawaii");
  const fresh = addStatement(graph, activityDimension, "Went snorkeling");
  for (const statement of [old, fresh]) {
    graph.addEdge({
      type: "core:about",
      from: statement.id,
      to: trip.id,
      scope: actorScope,
      created_by: "agent:test:1",
    });
  }
  const driver = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: old.id,
          relation: "independent",
          confidence: 0.98,
          reason: "the activity and trip occurrence are separate compatible facts",
        },
      ],
    }),
  ]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.equal(result.proposals[0]?.objectId, old.id);
  assert.equal(result.proposals[0]?.relation, "independent");
  assert.equal(result.proposals[0]?.requiresApproval, false);
});

test("fact reconciler: unrelated Statements never become Agent candidates", async () => {
  const graph = new MemoryGraph();
  addStatement(graph, addDimension(graph, "familyTrips"), "Family trip to Hawaii");
  const fresh = addStatement(graph, addDimension(graph, "favoriteDatabase"), "PostgreSQL");
  const driver = new MockDriver(["unused"]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.unresolvedIds, []);
  assert.equal(driver.remaining, 1);
});

test("fact reconciler: forged deterministic proposals cannot join unrelated facts", () => {
  const graph = new MemoryGraph();
  const trip = addStatement(graph, addDimension(graph, "familyTrips"), "Hawaii");
  const database = addStatement(graph, addDimension(graph, "favoriteDatabase"), "PostgreSQL");
  const forged: FactRelationProposal = {
    subjectId: database.id,
    objectId: trip.id,
    relation: "contradicts",
    basis: "deterministic",
    confidence: 1,
    reason: "forged",
    requiresApproval: false,
  };

  assert.throws(
    () => applyFactRelationProposal(graph, forged),
    /shared Dimension or core:about target/,
  );
  assert.equal(graph.queryEdges({ type: "core:contradicts" }).length, 0);
});

test("fact reconciler: relation application has MemoryGraph and SQLite parity", async () => {
  const run = async (graph: GraphStore, label: string): Promise<void> => {
    const dimension = addDimension(graph, "homeCity", "single");
    const old = addStatement(graph, dimension, "Shenzhen");
    const fresh = addStatement(graph, dimension, "Shanghai", "tentative");
    const proposal = (await reconcileStatement(graph, fresh.id)).proposals[0];
    assert.ok(proposal, label);
    applyFactRelationProposal(graph, proposal);
    assert.equal(graph.getNode(dimension.id)?.state, "conflict", label);
    assert.equal(graph.queryEdges({ type: "core:contradicts" }).length, 1, label);
  };

  await run(new MemoryGraph(), "MemoryGraph");
  const directory = mkdtempSync(join(tmpdir(), "edgelore-reconciler-"));
  const sqlite = new SqliteGraph(join(directory, "graph.db"));
  try {
    await run(sqlite, "SqliteGraph");
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
