import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGraphEnrichment,
  runGraphEnrichment,
} from "../../src/agent/graph-enrichment.js";
import { commitGraphWritePlan } from "../../src/agent/graph-write.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { MemoryGraph } from "../../src/model/store.js";

const contents = [
  {
    dimensionKey: "familyTripHawaii",
    value: "Went to Hawaii with family and went snorkeling",
    saidBy: "user" as const,
  },
  {
    dimensionKey: "familyTripParis",
    value: "Took another family trip to Paris",
    saidBy: "user" as const,
  },
];

function reply(): string {
  return JSON.stringify({
    factMappings: [
      {
        factRef: "fact:0",
        dimensionKey: "familyTrips",
        dimensionDescription: "Family travel experiences",
        cardinality: "multi",
      },
      {
        factRef: "fact:1",
        dimensionKey: "familyTrips",
        cardinality: "multi",
      },
    ],
    entities: [
      { ref: "hawaiiTrip", type: "travel:trip", key: "hawaii-family-trip", scope: "context" },
      { ref: "parisTrip", type: "travel:trip", key: "paris-family-trip", scope: "context" },
      { ref: "hawaii", type: "geo:place", key: "hawaii", value: "Hawaii", scope: "global" },
      { ref: "paris", type: "geo:place", key: "paris", value: "Paris", scope: "global" },
    ],
    relations: [
      { type: "core:about", from: "fact:0", to: "hawaiiTrip" },
      { type: "travel:destination", from: "fact:0", to: "hawaii" },
      { type: "core:about", from: "fact:1", to: "parisTrip" },
      { type: "travel:destination", from: "fact:1", to: "paris" },
    ],
  });
}

test("graph enrichment: collapses event-specific keys without rewriting facts", async () => {
  const graph = new MemoryGraph();
  const plan = await runGraphEnrichment({
    text: "I went to Hawaii with family. Later we took a family trip to Paris.",
    contents,
    knownDimensions: [],
    graph,
    driver: new MockDriver([reply()]),
    scope: { owner_id: "actor:alice" },
  });

  assert.deepEqual(
    plan.facts.map((fact) => fact.content.value),
    contents.map((content) => content.value),
    "the enrichment pass cannot rewrite extraction payloads",
  );
  assert.deepEqual(plan.facts.map((fact) => fact.content.dimensionKey), ["familyTrips", "familyTrips"]);

  commitGraphWritePlan(graph, plan, {
    created_by: "agent:ingestion:1",
    source_refs: ["session:family-trips"],
    scope: { owner_id: "actor:alice" },
  });
  assert.equal(graph.queryNodes({ type: "core:dimension" }).length, 1);
  assert.equal(graph.queryNodes({ type: "travel:trip" }).length, 2);
  assert.equal(graph.queryEdges({ type: "core:about" }).length, 2);
});

test("graph enrichment: refuses to lose a fact", () => {
  const parsed = JSON.parse(reply()) as { factMappings: unknown[] };
  parsed.factMappings.pop();
  assert.throws(
    () => normalizeGraphEnrichment(parsed, contents),
    /omitted factRef: fact:1/,
  );
});

test("graph enrichment: relations cannot bypass statement trust", () => {
  const parsed = JSON.parse(reply()) as {
    relations: Array<{ type: string; from: string; to: string }>;
  };
  parsed.relations.push({
    type: "travel:destination",
    from: "hawaiiTrip",
    to: "hawaii",
  });
  assert.throws(
    () => normalizeGraphEnrichment(parsed, contents),
    /must start at a factRef/,
  );
});

test("graph enrichment: assistant-only entities inherit tentative trust", () => {
  const graph = new MemoryGraph();
  const plan = normalizeGraphEnrichment(
    {
      factMappings: [
        { factRef: "fact:0", dimensionKey: "travelRecommendations", cardinality: "multi" },
      ],
      entities: [
        { ref: "trip", type: "travel:trip", key: "suggested-tybee-trip", scope: "context" },
      ],
      relations: [{ type: "core:about", from: "fact:0", to: "trip" }],
    },
    [
      {
        dimensionKey: "travelRecommendations",
        value: "Tybee Island would be a good choice",
        saidBy: "assistant",
      },
    ],
  );
  const result = commitGraphWritePlan(graph, plan, {
    created_by: "agent:ingestion:1",
    source_refs: ["session:suggestion"],
    scope: { owner_id: "actor:alice" },
  });
  assert.equal(graph.getNode(result.refs["fact:0"]!)?.state, "tentative");
  assert.equal(graph.getNode(result.refs.trip!)?.state, "tentative");
});
