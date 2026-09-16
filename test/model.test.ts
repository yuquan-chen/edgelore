import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryGraph,
  ModelError,
  canTransitionFact,
  canTransitionConstraint,
  validateType,
  validateCreatedBy,
  nodeId,
  constraintId,
} from "../src/model/index.js";
import { SCHEMA_VERSION } from "../src/model/types.js";

const HUMAN = "human:owner";
const AGENT = "agent:claude:abc";

test("M0: provenance is mandatory — missing created_by throws", () => {
  const g = new MemoryGraph();
  assert.throws(
    () => g.addNode({ type: "core:actor" } as any),
    (e: unknown) => e instanceof ModelError && /created_by/.test((e as Error).message),
  );
});

test("M0: open-world type accepted (codex:task), defaults applied", () => {
  const g = new MemoryGraph();
  const n = g.addNode({ type: "codex:task", created_by: AGENT });
  assert.equal(n.type, "codex:task");
  assert.equal(n.state, "tentative"); // default initial state
  assert.equal(n.schema_version, SCHEMA_VERSION);
  assert.deepEqual(n.source_refs, []);
  assert.ok(n.id.startsWith("node:codex:task:"));
});

test("M0: core:dimension requires `key`; core:statement requires dimension_id + value", () => {
  const g = new MemoryGraph();
  assert.throws(() => g.addNode({ type: "core:dimension", created_by: AGENT }), ModelError);
  const dim = g.addNode({ type: "core:dimension", created_by: AGENT, key: "design_cost", project_id: "P1" });
  assert.ok(dim.id);

  assert.throws(
    () => g.addNode({ type: "core:statement", created_by: AGENT, dimension_id: dim.id } as any),
    ModelError,
  );
  const stmt = g.addNode({ type: "core:statement", created_by: HUMAN, dimension_id: dim.id, value: 5000, unit: "CNY" });
  assert.equal((stmt as any).value, 5000);
});

test("M0: invalid type / created_by are rejected", () => {
  assert.equal(validateType("codex:task").ok, true);
  assert.equal(validateType("actor").ok, false); // not namespaced
  assert.equal(validateCreatedBy("agent:claude:abc").ok, true);
  assert.equal(validateCreatedBy("charles").ok, false);

  const g = new MemoryGraph();
  assert.throws(() => g.addNode({ type: "noscope", created_by: AGENT }), ModelError);
});

test("M0: fact-node state machine rejects illegal transitions", () => {
  assert.equal(canTransitionFact("tentative", "accepted"), true);
  assert.equal(canTransitionFact("rejected", "accepted"), false); // terminal
  assert.equal(canTransitionFact("superseded", "accepted"), false); // terminal

  const g = new MemoryGraph();
  const n = g.addNode({ type: "core:actor", created_by: AGENT });
  g.transitionNodeState(n.id, "accepted");
  assert.equal(g.getNode(n.id)!.state, "accepted");
  // accepted -> rejected IS allowed by the state machine; test a truly illegal
  // one instead: a terminal state (rejected) cannot go back to accepted.
  const n2 = g.addNode({ type: "core:actor", created_by: AGENT });
  g.transitionNodeState(n2.id, "rejected");
  assert.throws(() => g.transitionNodeState(n2.id, "accepted"), ModelError);
});

test("M0: Q01 — constraint cannot go active without a human approver", () => {
  const g = new MemoryGraph();
  // created directly as active with no approver -> rejected
  assert.throws(
    () =>
      g.addConstraint({
        participants: ["node:core:dimension:x"],
        bindings: { x1: "node:core:dimension:x" },
        activation_state: "active",
        created_by: AGENT,
      }),
    (e: unknown) => e instanceof ModelError && /Q01/.test((e as Error).message),
  );

  // proposed first, then activated by an agent -> still rejected
  const c = g.addConstraint({
    participants: ["node:core:dimension:x"],
    bindings: { x1: "node:core:dimension:x" },
    created_by: AGENT,
  });
  assert.equal(c.activation_state, "proposed");
  assert.throws(() => g.transitionConstraintState(c.id, "active", { approved_by: AGENT }), ModelError);

  // activated by a human -> ok
  g.transitionConstraintState(c.id, "active", { approved_by: HUMAN });
  const active = g.getConstraint(c.id)!;
  assert.equal(active.activation_state, "active");
  assert.equal(active.approved_by, HUMAN);
  assert.ok(active.approved_at);
});

test("M0: constraint participants are N-ary (the honest hyperedge)", () => {
  const g = new MemoryGraph();
  const c = g.addConstraint({
    participants: ["node:core:dimension:a", "node:core:dimension:b", "node:core:dimension:c"],
    bindings: { x1: "node:core:dimension:a", x2: "node:core:dimension:b", x3: "node:core:dimension:c" },
    created_by: AGENT,
  });
  assert.equal(c.participants.length, 3);
  assert.throws(
    () => g.addConstraint({ participants: [], bindings: {}, created_by: AGENT }),
    ModelError,
  );
});

test("M0: constraint state machine", () => {
  assert.equal(canTransitionConstraint("proposed", "active"), true);
  assert.equal(canTransitionConstraint("retired", "active"), false);
  assert.equal(canTransitionConstraint("active", "deprecated"), true);
});

test("M0: edge requires existing endpoints", () => {
  const g = new MemoryGraph();
  const a = g.addNode({ type: "core:actor", created_by: AGENT });
  const b = g.addNode({ type: "core:project", created_by: AGENT });
  const e = g.addEdge({ type: "core:belongs_to", from: a.id, to: b.id, created_by: AGENT });
  assert.ok(e.id.startsWith("edge:"));
  assert.throws(
    () => g.addEdge({ type: "core:belongs_to", from: "node:core:actor:ghost", to: b.id, created_by: AGENT }),
    ModelError,
  );
});

test("M0: id generators are well-formed & unique", () => {
  const a = nodeId("core:dimension");
  const b = nodeId("core:dimension");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("node:core:dimension:"));
  assert.ok(constraintId().startsWith("constraint:"));
});
