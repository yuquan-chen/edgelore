import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyAgentFactRelationProposal,
  applyFactRelationProposal,
  reconcileStatement,
  type FactRelationProposal,
} from "../../src/agent/fact-reconciler.js";
import { capture } from "../../src/agent/capture.js";
import { listConflicts } from "../../src/agent/conflicts.js";
import type {
  ChoiceDecision,
  ChoiceQuestion,
  DecisionDriver,
} from "../../src/agent/decision.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { MemoryGraph, type GraphStore } from "../../src/model/store.js";
import type { DimensionNode, StatementNode } from "../../src/model/types.js";
import { SqliteGraph } from "../../src/store/sqlite.js";

const actorScope = { owner_id: "actor:alice" };

function fakeDecision(
  choose: (
    state: string,
    questions: Record<string, ChoiceQuestion>,
  ) => Promise<Record<string, ChoiceDecision>>,
): DecisionDriver {
  return {
    async noul(): Promise<number> {
      return 0;
    },
    async choice(): Promise<string> {
      return "";
    },
    async noulFanOut(): Promise<Record<string, number>> {
      return {};
    },
    choiceFanOut: choose,
  };
}

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

test("fact reconciler: high-confidence Jev choice skips the chat fallback", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen", "accepted", "2024-01-01");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative", "2024-02-01");
  const chat = new MockDriver(["unused"]);
  let calls = 0;
  const decision = fakeDecision(async (state, questions) => {
    calls += 1;
    assert.match(state, /Shenzhen/);
    assert.match(state, /Shanghai/);
    assert.equal(Object.keys(questions).length, 1);
    return {
      candidate_0: { choice: "supersedes", confidence: 0.96 },
    };
  });

  const result = await reconcileStatement(graph, fresh.id, {
    decision,
    driver: chat,
  });

  assert.equal(calls, 1);
  assert.equal(chat.remaining, 1);
  assert.equal(result.proposals[0]?.objectId, old.id);
  assert.equal(result.proposals[0]?.relation, "supersedes");
  assert.equal(result.proposals[0]?.confidence, 0.96);
  assert.deepEqual(result.unresolvedIds, []);
  assert.equal(graph.getNode(old.id)?.state, "accepted");
  assert.equal(graph.getNode(fresh.id)?.state, "tentative");
});

test("fact reconciler: uncertain Jev choice falls back to the read-capable Agent", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen", "accepted", "2024-01-01");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative", "2024-02-01");
  const decision = fakeDecision(async () => ({
    candidate_0: { choice: "supersedes", confidence: 0.62 },
  }));
  const chat = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: old.id,
          relation: "supersedes",
          confidence: 0.95,
          reason: "later value from the same authority and speaker",
        },
      ],
    }),
  ]);

  const result = await reconcileStatement(graph, fresh.id, {
    decision,
    driver: chat,
  });

  assert.equal(chat.remaining, 0);
  assert.equal(result.proposals[0]?.relation, "supersedes");
  assert.equal(result.proposals[0]?.confidence, 0.95);
  assert.deepEqual(result.unresolvedIds, []);
});

test("fact reconciler: conflict mode excludes related Claims outside the exact Slot", async () => {
  const graph = new MemoryGraph();
  const city = addDimension(graph, "homeCity", "single");
  const job = addDimension(graph, "employer", "single");
  const oldCity = addStatement(graph, city, "Shenzhen", "accepted", "2024-01-01");
  const relatedJob = addStatement(graph, job, "Acme", "accepted", "2024-01-15");
  const fresh = addStatement(graph, city, "Shanghai", "tentative", "2024-02-01");
  const person = graph.addNode({
    type: "world:person",
    value: "Alice",
    state: "accepted",
    scope: actorScope,
    created_by: "agent:test:1",
  });
  for (const statement of [fresh, oldCity, relatedJob]) {
    graph.addEdge({
      type: "core:about",
      from: statement.id,
      to: person.id,
      scope: actorScope,
      created_by: "agent:test:1",
    });
  }
  let questionCount = 0;
  const decision = fakeDecision(async (_state, questions) => {
    questionCount = Object.keys(questions).length;
    return { candidate_0: { choice: "supersedes", confidence: 0.96 } };
  });

  const result = await reconcileStatement(graph, fresh.id, {
    decision,
    sameDimensionOnly: true,
  });

  assert.equal(questionCount, 1);
  assert.equal(result.proposals[0]?.objectId, oldCity.id);
  assert.ok(!result.proposals.some((proposal) => proposal.objectId === relatedJob.id));
});

test("fact reconciler: prompt fixes relation direction as new Statement to candidate", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "mortgagePreapproval");
  const old = addStatement(graph, dimension, "Pre-approved for $350,000 on 2022-02-10");
  const fresh = addStatement(graph, dimension, "Pre-approved for up to $350,000");
  let prompt = "";
  const driver = {
    async complete(input: string): Promise<string> {
      prompt = input;
      return JSON.stringify({
        decisions: [
          {
            statementId: old.id,
            relation: "duplicate",
            confidence: 0.9,
            reason: "same core claim; the candidate contains the omitted date",
          },
        ],
      });
    },
  };

  await reconcileStatement(graph, fresh.id, { driver });

  assert.match(prompt, /New Statement -> Candidate/);
  assert.match(prompt, /New Statement adds compatible detail to the Candidate/);
  assert.match(prompt, /Candidate contains details omitted by the New Statement/);
  assert.match(prompt, /Judge memory truth relative to provenance/);
  assert.match(prompt, /"dimensionId":/);
  assert.match(prompt, /"propertyKey":"mortgagePreapproval"/);
  assert.match(prompt, /"subjectRef":"\$scopeOwner"/);
  assert.match(prompt, /"createdBy":"agent:test:1"/);
  assert.match(prompt, /"sourceRefs":\["session:test"\]/);
  assert.match(prompt, /"scope":\{"owner_id":"actor:alice"\}/);
});

test("fact reconciler: Agent can request bounded read-only evidence before deciding", async () => {
  const graph = new MemoryGraph();
  graph.putEpisode({
    id: "session:test",
    turns: [
      {
        role: "user",
        content: "I used to live in Shenzhen. I have now moved to Shanghai.",
      },
    ],
    created_by: "human:alice",
    scope: actorScope,
  });
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(
    graph,
    dimension,
    "Shenzhen",
    "accepted",
    "2024-01-01T00:00:00.000Z",
  );
  const fresh = addStatement(
    graph,
    dimension,
    "Shanghai",
    "tentative",
    "2024-02-01T00:00:00.000Z",
  );
  const prompts: string[] = [];
  const replies = [
    JSON.stringify({
      reads: [{ tool: "episode_evidence", statementId: old.id }],
    }),
    JSON.stringify({
      decisions: [
        {
          statementId: old.id,
          relation: "supersedes",
          confidence: 0.97,
          reason: "the source explicitly says the user moved",
        },
      ],
    }),
  ];
  const driver = {
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected extra Agent call");
      return reply;
    },
  };

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.equal(prompts.length, 2);
  assert.deepEqual(result.readRequests, [
    { tool: "episode_evidence", statementId: old.id },
  ]);
  assert.equal(result.proposals[0]?.relation, "supersedes");
  assert.match(prompts[1] ?? "", /READ-ONLY requests/);
  assert.match(prompts[1] ?? "", /moved to Shanghai/);
  assert.equal(graph.getNode(old.id)?.state, "accepted");
  assert.equal(graph.getNode(fresh.id)?.state, "tentative");
  assert.equal(graph.queryEdges({ type: "core:supersedes" }).length, 0);
});

test("fact reconciler: unsupported write-like requests cannot access the graph", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative");
  const driver = new MockDriver([
    JSON.stringify({
      reads: [{ tool: "transition_state", statementId: old.id }],
    }),
  ]);

  await assert.rejects(
    () => reconcileStatement(graph, fresh.id, { driver }),
    /field "decisions" must be an array/,
  );
  assert.equal(graph.getNode(old.id)?.state, "accepted");
  assert.equal(graph.getNode(fresh.id)?.state, "tentative");
  assert.equal(graph.queryEdges({}).length, 0);
});

test("fact reconciler: read-only local graph never crosses scope", async () => {
  const graph = new MemoryGraph();
  const person = graph.addNode({
    type: "world:person",
    key: "shared-person",
    created_by: "agent:test:1",
  });
  const visible = graph.addNode({
    type: "world:organization",
    key: "visible-company",
    scope: actorScope,
    created_by: "agent:test:1",
  });
  const hidden = graph.addNode({
    type: "world:organization",
    key: "bob-secret-company",
    scope: { owner_id: "actor:bob" },
    created_by: "agent:test:1",
  });
  graph.addEdge({
    type: "world:employed_by",
    from: person.id,
    to: visible.id,
    scope: actorScope,
    created_by: "agent:test:1",
  });
  graph.addEdge({
    type: "world:employed_by",
    from: person.id,
    to: hidden.id,
    scope: { owner_id: "actor:bob" },
    created_by: "agent:test:1",
  });
  const dimension = graph.addNode({
    type: "core:dimension",
    key: "employer",
    cardinality: "single",
    state: "conflict",
    scope: actorScope,
    attributes: { propertyKey: "employer", subjectRef: person.id },
    created_by: "agent:test:1",
  }) as DimensionNode;
  const old = addStatement(graph, dimension, "Old Company");
  const fresh = addStatement(graph, dimension, "New Company", "tentative");
  const prompts: string[] = [];
  const replies = [
    JSON.stringify({ reads: [{ tool: "local_graph", statementId: old.id }] }),
    JSON.stringify({
      decisions: [
        {
          statementId: old.id,
          relation: "contradicts",
          confidence: 0.8,
          reason: "the relationship remains ambiguous",
        },
      ],
    }),
  ];
  const driver = {
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected extra Agent call");
      return reply;
    },
  };

  await reconcileStatement(graph, fresh.id, { driver });

  assert.match(prompts[1] ?? "", /visible-company/);
  assert.doesNotMatch(prompts[1] ?? "", /bob-secret-company/);
});

test("fact reconciler: malformed Agent rows are ignored and remain unresolved", async () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = addStatement(graph, dimension, "Shenzhen");
  const fresh = addStatement(graph, dimension, "Shanghai", "tentative");
  const driver = new MockDriver([
    JSON.stringify({
      decisions: [
        {
          statementId: "hallucinated-id",
          relation: "supersedes",
          confidence: 0.99,
          reason: "invalid row",
        },
      ],
    }),
  ]);

  const result = await reconcileStatement(graph, fresh.id, { driver });

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.unresolvedIds, [old.id]);
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

test("fact reconciler: provenance-gated Agent resolution can apply a newer trusted value", () => {
  const graph = new MemoryGraph();
  const old = capture(
    graph,
    { dimensionKey: "homeCity", value: "Shenzhen", cardinality: "single", saidBy: "user" },
    {
      created_by: "agent:ingestion:1",
      source_refs: ["session:old"],
      createdAt: "2024-01-01T00:00:00.000Z",
      scope: actorScope,
    },
  );
  const fresh = capture(
    graph,
    { dimensionKey: "homeCity", value: "Shanghai", cardinality: "single", saidBy: "user" },
    {
      created_by: "agent:ingestion:1",
      source_refs: ["session:new"],
      createdAt: "2024-02-01T00:00:00.000Z",
      scope: actorScope,
    },
  );
  const proposal: FactRelationProposal = {
    subjectId: fresh.statementId as string,
    objectId: old.statementId as string,
    relation: "supersedes",
    basis: "agent",
    confidence: 0.92,
    reason: "later claim from the same trusted provenance channel",
    requiresApproval: true,
  };

  const result = applyAgentFactRelationProposal(graph, proposal, {
    resolvedBy: "agent:edgelore:reconciler",
  });

  assert.equal(result.subjectState, "accepted");
  assert.equal(result.objectState, "superseded");
  assert.equal(graph.getNode(old.dimensionId)?.state, "accepted");
  assert.deepEqual(listConflicts(graph), []);
  const edge = graph.queryEdges({
    type: "core:supersedes",
    from: proposal.subjectId,
    to: proposal.objectId,
  })[0];
  assert.equal(edge?.created_by, "agent:edgelore:reconciler");
});

test("fact reconciler: Agent resolution refuses weak or mismatched provenance", () => {
  const graph = new MemoryGraph();
  const dimension = addDimension(graph, "homeCity", "single");
  const old = graph.addNode({
    type: "core:statement",
    dimension_id: dimension.id,
    value: "Shenzhen",
    state: "accepted",
    scope: actorScope,
    saidBy: "user",
    created_by: "agent:ingestion:old",
    source_refs: ["session:old"],
    created_at: "2024-01-01T00:00:00.000Z",
  }) as StatementNode;
  const fresh = graph.addNode({
    type: "core:statement",
    dimension_id: dimension.id,
    value: "Shanghai",
    state: "tentative",
    scope: actorScope,
    saidBy: "user",
    created_by: "agent:ingestion:new",
    source_refs: ["session:new"],
    created_at: "2024-02-01T00:00:00.000Z",
  }) as StatementNode;
  const proposal: FactRelationProposal = {
    subjectId: fresh.id,
    objectId: old.id,
    relation: "supersedes",
    basis: "agent",
    confidence: 0.8,
    reason: "untrusted replacement",
    requiresApproval: true,
  };

  assert.throws(
    () =>
      applyAgentFactRelationProposal(graph, proposal, {
        resolvedBy: "agent:edgelore:reconciler",
      }),
    /below 0.85/,
  );
  proposal.confidence = 0.95;
  assert.throws(
    () =>
      applyAgentFactRelationProposal(graph, proposal, {
        resolvedBy: "agent:edgelore:reconciler",
      }),
    /same authority and speaker channel/,
  );
  assert.equal(graph.getNode(old.id)?.state, "accepted");
  assert.equal(graph.getNode(fresh.id)?.state, "tentative");
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
