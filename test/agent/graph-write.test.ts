import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitGraphWritePlan, type GraphWritePlan } from "../../src/agent/graph-write.js";
import type { CaptureContext } from "../../src/agent/capture.js";
import { MemoryGraph, type GraphStore } from "../../src/model/store.js";
import { SqliteGraph } from "../../src/store/sqlite.js";

function forBackend(fn: (graph: GraphStore) => void): void {
  fn(new MemoryGraph());
  const dir = mkdtempSync(join(tmpdir(), "edgelore-graph-write-"));
  const graph = new SqliteGraph(join(dir, "graph.db"));
  try {
    fn(graph);
  } finally {
    graph.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const aliceCtx: CaptureContext = {
  created_by: "agent:ingestion:1",
  createdAt: "2023-05-24T00:00:00.000Z",
  source_refs: ["session:hawaii"],
  scope: { owner_id: "actor:alice" },
};

function hawaiiPlan(): GraphWritePlan {
  return {
    entities: [
      { ref: "user", type: "core:actor", key: "alice", value: "Alice", state: "accepted" },
      { ref: "family", type: "social:group", key: "alice-family", value: "Alice's family", state: "accepted" },
      { ref: "trip", type: "travel:trip", key: "alice-hawaii-2023-05", state: "accepted" },
      { ref: "hawaii", type: "geo:place", key: "hawaii", value: "Hawaii", state: "accepted", scope: "global" },
      { ref: "snorkeling", type: "travel:activity", key: "snorkeling", value: "snorkeling", state: "accepted", scope: "global" },
      { ref: "source", type: "core:message", key: "session-hawaii-turn-1", value: "Went to Hawaii with family and went snorkeling.", state: "accepted" },
    ],
    facts: [
      {
        ref: "claim",
        content: {
          dimensionKey: "familyTrips",
          cardinality: "multi",
          value: "Went to Hawaii with family and went snorkeling (2023-05)",
          saidBy: "user",
        },
      },
    ],
    relations: [
      { type: "core:about", from: "claim", to: "trip" },
      { type: "core:said_by", from: "claim", to: "user" },
      { type: "core:has_source", from: "claim", to: "source" },
      { type: "travel:participant", from: "claim", to: "family" },
      { type: "travel:destination", from: "claim", to: "hawaii" },
      { type: "travel:activity", from: "claim", to: "snorkeling" },
    ],
  };
}

test("graph write: family trips share one dimension and reuse the same event", () => {
  forBackend((graph) => {
    const first = commitGraphWritePlan(graph, hawaiiPlan(), aliceCtx);

    const supplement = commitGraphWritePlan(
      graph,
      {
        entities: [
          { ref: "trip", type: "travel:trip", key: "alice-hawaii-2023-05", state: "accepted" },
          { ref: "islandHopping", type: "travel:activity", key: "island-hopping", value: "island hopping", state: "accepted", scope: "global" },
        ],
        facts: [
          {
            ref: "claim",
            content: {
              dimensionKey: "familyTrips",
              value: "Also went island hopping during the Hawaii family trip",
              saidBy: "user",
            },
          },
        ],
        relations: [
          { type: "core:about", from: "claim", to: "trip" },
          { type: "travel:activity", from: "claim", to: "islandHopping" },
        ],
      },
      { ...aliceCtx, source_refs: ["session:hawaii-followup"] },
    );

    const paris = commitGraphWritePlan(
      graph,
      {
        entities: [
          { ref: "trip", type: "travel:trip", key: "alice-paris-2024-04", state: "accepted" },
          { ref: "paris", type: "geo:place", key: "paris", value: "Paris", state: "accepted", scope: "global" },
        ],
        facts: [
          {
            ref: "claim",
            content: {
              dimensionKey: "familyTrips",
              value: "Took another family trip to Paris (2024-04)",
              saidBy: "user",
            },
          },
        ],
        relations: [
          { type: "core:about", from: "claim", to: "trip" },
          { type: "travel:destination", from: "claim", to: "paris" },
        ],
      },
      { ...aliceCtx, source_refs: ["session:paris"] },
    );

    const dimensions = graph.queryNodes({ type: "core:dimension", owner_id: "actor:alice" });
    assert.equal(dimensions.length, 1);
    assert.equal(dimensions[0]?.key, "familyTrips");
    assert.equal(graph.queryNodes({ type: "travel:trip", owner_id: "actor:alice" }).length, 2);
    assert.equal(graph.queryNodes({ type: "core:statement", owner_id: "actor:alice" }).length, 3);

    const firstTrip = first.refs.trip;
    assert.equal(supplement.refs.trip, firstTrip, "follow-up must resolve to the same Hawaii trip");
    assert.notEqual(paris.refs.trip, firstTrip, "Paris is a different trip instance");
    assert.equal(graph.queryEdges({ type: "core:about", to: firstTrip }).length, 2);

    for (const edge of graph.queryEdges({})) {
      if (!edge.type.startsWith("travel:")) continue;
      assert.equal(graph.getNode(edge.from)?.type, "core:statement", "claim-sensitive relations originate at statements");
    }
    assert.ok(dimensions.every((node) => !/hawaii|paris/i.test(node.key ?? "")));
  });
});

test("graph write: entity and dimension identity are isolated by owner scope", () => {
  forBackend((graph) => {
    const alice = commitGraphWritePlan(graph, hawaiiPlan(), aliceCtx);
    const bob = commitGraphWritePlan(graph, hawaiiPlan(), {
      ...aliceCtx,
      source_refs: ["session:bob-hawaii"],
      scope: { owner_id: "actor:bob" },
    });
    assert.notEqual(alice.refs.trip, bob.refs.trip);
    assert.notEqual(alice.captures[0]?.dimensionId, bob.captures[0]?.dimensionId);
    assert.equal(alice.refs.hawaii, bob.refs.hawaii, "explicitly global place nodes may be reused");
  });
});

test("graph write: harmless entity-key spelling differences reuse identity", () => {
  forBackend((graph) => {
    const first = commitGraphWritePlan(
      graph,
      {
        entities: [
          { ref: "place", type: "geo:place", key: "Washington D.C.", value: "Washington D.C.", scope: "global" },
        ],
        facts: [],
        relations: [],
      },
      aliceCtx,
    );
    const second = commitGraphWritePlan(
      graph,
      {
        entities: [
          { ref: "place", type: "geo:place", key: "washington-d-c", value: "Washington, DC", scope: "global" },
        ],
        facts: [],
        relations: [],
      },
      aliceCtx,
    );
    assert.equal(second.refs.place, first.refs.place);
    assert.equal(graph.queryNodes({ type: "geo:place" }).length, 1);
  });
});

test("graph write: a failed relation rolls the whole plan back", () => {
  forBackend((graph) => {
    const bad = hawaiiPlan();
    bad.relations.push({ type: "not-namespaced", from: "claim", to: "trip" });
    assert.throws(() => commitGraphWritePlan(graph, bad, aliceCtx), /namespaced/);
    assert.equal(graph.queryNodes({}).length, 0);
    assert.equal(graph.queryEdges({}).length, 0);
  });
});
