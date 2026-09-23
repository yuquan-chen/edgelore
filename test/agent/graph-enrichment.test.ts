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
        subjectRef: "$scopeOwner",
        dimensionKey: "familyTrips",
        dimensionDescription: "Family travel experiences",
        cardinality: "multi",
      },
      {
        factRef: "fact:1",
        subjectRef: "$scopeOwner",
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

test("graph enrichment: prompt exposes stored dimension examples and NEW protocol", async () => {
  const graph = new MemoryGraph();
  commitGraphWritePlan(
    graph,
    {
      entities: [],
      facts: [
        {
          ref: "fact",
          content: { dimensionKey: "gasMileage", value: "32 miles per gallon", saidBy: "user" },
        },
      ],
      relations: [],
    },
    { created_by: "agent:ingestion:1", source_refs: ["session:old"] },
  );
  let seenPrompt = "";
  const driver = {
    async complete(prompt: string): Promise<string> {
      seenPrompt = prompt;
      return JSON.stringify({
        factMappings: [{ factRef: "fact:0", subjectRef: "$scopeOwner", dimensionKey: "gasMileage" }],
        entities: [],
        relations: [],
      });
    },
  };
  await runGraphEnrichment({
    text: "The car gets 32 mpg",
    contents: [{ dimensionKey: "carPerformance", value: "The car gets 32 mpg" }],
    knownDimensions: [
      { key: "gasMileage", description: "Vehicle fuel economy", cardinality: "multi" },
    ],
    graph,
    driver,
  });
  assert.match(seenPrompt, /32 miles per gallon/);
  assert.match(seenPrompt, /NEW:<lowerCamelCase>/);
});

test("graph enrichment: rejects broad remaps but keeps compatible family reuse", async () => {
  const graph = new MemoryGraph();
  const driver = new MockDriver([
    JSON.stringify({
      factMappings: [
        { factRef: "fact:0", subjectRef: "$scopeOwner", dimensionKey: "productivityStrategies" },
        { factRef: "fact:1", subjectRef: "$scopeOwner", dimensionKey: "familyTrips" },
      ],
      entities: [],
      relations: [],
    }),
  ]);
  const original = [
    { dimensionKey: "dataVizCommunicationTips", value: "Tell a clear data story" },
    { dimensionKey: "familyTripHawaii", value: "Family trip to Hawaii" },
  ];
  const plan = await runGraphEnrichment({
    text: "Data storytelling and a family trip",
    contents: original,
    knownDimensions: [
      { key: "productivityStrategies", description: "Ways to work productively", cardinality: "multi" },
      { key: "familyTrips", description: "Family travel experiences", cardinality: "multi" },
    ],
    graph,
    driver,
  });
  assert.equal(plan.facts[0]?.content.dimensionKey, "dataVizCommunicationTips");
  assert.equal(plan.facts[1]?.content.dimensionKey, "familyTrips");
  assert.match(plan.warnings.at(-1) ?? "", /unsafe dimension remap rejected/);
});

test("graph enrichment: rejects a newly invented catch-all dimension", async () => {
  const plan = await runGraphEnrichment({
    text: "Bought a car and used it to help a friend move",
    contents: [
      { dimensionKey: "carPurchase", value: "Bought a silver Honda Civic" },
      { dimensionKey: "friendMoveHelp", value: "Used the car to help Emily move" },
    ],
    knownDimensions: [],
    graph: new MemoryGraph(),
    driver: new MockDriver([
      JSON.stringify({
        factMappings: [
          { factRef: "fact:0", subjectRef: "$scopeOwner", dimensionKey: "NEW:carUse" },
          { factRef: "fact:1", subjectRef: "$scopeOwner", dimensionKey: "NEW:carUse" },
        ],
        entities: [],
        relations: [],
      }),
    ]),
  });
  assert.deepEqual(plan.facts.map((fact) => fact.content.dimensionKey), [
    "carPurchase",
    "friendMoveHelp",
  ]);
  assert.equal(plan.warnings.length, 2);
});

test("graph enrichment: rejected Property remaps also reject the proposed subject", async () => {
  const plan = await runGraphEnrichment({
    text: "I bought a silver Honda Civic on February 10.",
    contents: [
      { dimensionKey: "carAccessories", value: "Silver Honda Civic, bought on 2023-02-10" },
    ],
    knownDimensions: [],
    graph: new MemoryGraph(),
    driver: new MockDriver([
      JSON.stringify({
        factMappings: [
          { factRef: "fact:0", subjectRef: "car", dimensionKey: "NEW:carIdentity" },
        ],
        entities: [
          { ref: "car", type: "car:vehicle", key: "car", value: "User's car" },
        ],
        relations: [
          { type: "core:about", from: "fact:0", to: "car" },
        ],
      }),
    ]),
  });

  assert.equal(plan.facts[0]?.content.dimensionKey, "carAccessories");
  assert.equal(plan.facts[0]?.content.subjectRef, undefined);
  assert.match(plan.warnings.at(-1) ?? "", /unsafe dimension remap rejected/);
});

test("graph enrichment: refuses to lose a fact", () => {
  const parsed = JSON.parse(reply()) as { factMappings: unknown[] };
  parsed.factMappings.pop();
  assert.throws(
    () => normalizeGraphEnrichment(parsed, contents),
    /omitted factRef: fact:1/,
  );
});

test("graph enrichment: entity relations are projected onto their supporting statement", () => {
  const parsed = JSON.parse(reply()) as {
    relations: Array<{ type: string; from: string; to: string }>;
  };
  parsed.relations.push({
    type: "travel:destination",
    from: "hawaiiTrip",
    to: "hawaii",
  });
  const plan = normalizeGraphEnrichment(parsed, contents);
  const projected = plan.relations.at(-1);
  assert.equal(projected?.from, "fact:0");
  assert.equal(projected?.to, "hawaii");
  assert.match(plan.warnings[0] ?? "", /projected from entity hawaiiTrip/);
});

test("graph enrichment: malformed relations are skipped without losing graph facts", () => {
  const parsed = JSON.parse(reply()) as {
    relations: Array<{ type: string; from: string; to: string }>;
  };
  parsed.relations.push({ type: "tradeIn", from: "fact:0", to: "hawaii" });
  parsed.relations.push({ type: "travel:uses", from: "fact:0", to: "missing-car" });
  parsed.relations.push({ type: "core:contradicts", from: "fact:1", to: "fact:0" });
  const plan = normalizeGraphEnrichment(parsed, contents);
  assert.equal(plan.facts.length, 2);
  assert.equal(plan.relations.length, 4);
  assert.equal(plan.warnings.length, 3);
  assert.match(plan.warnings[0] ?? "", /must be namespaced/);
  assert.match(plan.warnings[1] ?? "", /unknown to ref/);
  assert.match(plan.warnings[2] ?? "", /governed statement relation skipped/);
});

test("graph enrichment: assistant-only entities inherit tentative trust", () => {
  const graph = new MemoryGraph();
  const plan = normalizeGraphEnrichment(
    {
      factMappings: [
        { factRef: "fact:0", subjectRef: "$scopeOwner", dimensionKey: "travelRecommendations", cardinality: "multi" },
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
