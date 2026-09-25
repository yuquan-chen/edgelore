import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegratedGraphExtractionPrompt,
  normalizeIntegratedGraphExtractionReply,
} from "../../src/agent/graph-batch.js";

test("integrated graph batch: one response preserves Claims and subject-bound organization", () => {
  const raw = {
    contents: [
      {
        factRef: "car-color",
        subjectRef: "car",
        dimensionKey: "NEW:carColor",
        value: "black",
        saidBy: "user",
        cardinality: "single",
      },
    ],
    eventDecisions: [],
    entities: [
      { ref: "car", type: "vehicle:car", key: "user-honda", value: "User's Honda" },
    ],
    relations: [{ type: "core:about", from: "car-color", to: "car" }],
  };
  const result = normalizeIntegratedGraphExtractionReply(raw, 0);
  assert.equal(result.batch.contents.length, 1);
  assert.equal(result.plan.facts[0]?.content.subjectRef, "car");
  assert.equal(result.plan.facts[0]?.content.dimensionKey, "carColor");
  assert.equal(result.plan.relations[0]?.from, "fact:0");
  assert.equal(result.plan.relations[0]?.to, "car");
});

test("integrated graph batch: missing subject safely defaults to scope owner", () => {
  const result = normalizeIntegratedGraphExtractionReply({
    contents: [{ factRef: "trip", dimensionKey: "NEW:familyTrips", value: "Hawaii" }],
    eventDecisions: [],
    entities: [],
    relations: [],
  }, 0);
  assert.equal(result.plan.facts[0]?.content.subjectRef, "$scopeOwner");
});

test("integrated graph batch: duplicate event facts retain every relation alias", () => {
  const fact = {
    factRef: "ticket",
    subjectRef: "$scopeOwner",
    dimensionKey: "NEW:parkingTickets",
    value: "Parking ticket, $50 (2023-05-08)",
    saidBy: "user",
  };
  const result = normalizeIntegratedGraphExtractionReply({
    contents: [fact],
    eventDecisions: [
      { eventId: "E1", decision: "keep", content: { ...fact, factRef: undefined } },
    ],
    entities: [{ ref: "ticketEvent", type: "event:ticket", key: "ticket-2023-05-08" }],
    relations: [{ type: "core:about", from: "ticket", to: "ticketEvent" }],
  }, 1);
  assert.equal(result.batch.contents.length, 1);
  assert.equal(result.plan.relations[0]?.from, "fact:0");
});

test("integrated graph batch: prompt requests one combined response", () => {
  const prompt = buildIntegratedGraphExtractionPrompt({
    transcript: "[user] My Honda is black.",
    knownDimensions: [],
    maxFacts: 12,
    entityHints: [],
    relationTypes: [],
  });
  assert.match(prompt, /part of the SAME response/);
  assert.match(prompt, /subjectRef/);
  assert.match(prompt, /entities, and relations/);
});

test("integrated graph batch: same-call mappings consolidate compatible Properties", () => {
  const result = normalizeIntegratedGraphExtractionReply({
    contents: [
      { factRef: "hawaii", dimensionKey: "NEW:familyTripHawaii", value: "Hawaii trip" },
      { factRef: "paris", dimensionKey: "NEW:familyTripParis", value: "Paris trip" },
    ],
    eventDecisions: [],
    factMappings: [
      { factRef: "hawaii", subjectRef: "$scopeOwner", dimensionKey: "NEW:familyTrips" },
      { factRef: "paris", subjectRef: "$scopeOwner", dimensionKey: "NEW:familyTrips" },
    ],
    entities: [],
    relations: [],
  }, 0);
  assert.deepEqual(
    result.batch.contents.map((content) => content.dimensionKey),
    ["familyTrips", "familyTrips"],
  );
});

test("integrated graph batch: concrete extracted subject beats owner mapping fallback", () => {
  const result = normalizeIntegratedGraphExtractionReply({
    contents: [
      { factRef: "color", subjectRef: "car", dimensionKey: "NEW:carColor", value: "black" },
    ],
    eventDecisions: [],
    factMappings: [
      { factRef: "color", subjectRef: "$scopeOwner", dimensionKey: "carColor" },
    ],
    entities: [{ ref: "car", type: "vehicle:car", key: "user-car" }],
    relations: [{ type: "core:about", from: "color", to: "car" }],
  }, 0);
  assert.equal(result.plan.facts[0]?.content.subjectRef, "car");
});
