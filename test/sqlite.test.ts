// edgelore · M2 — SqliteGraph tests.
//
// Two tracks (docs/shared-memory-m2-spec.md §6):
//   behavior parity — add / transition / Q01 / evaluate behave exactly like
//                     the in-memory reference store
//   persistence     — write, close, reopen a fresh SqliteGraph on the same
//                     file, and the graph (and rule evaluation) survives

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraph } from "../src/store/sqlite.js";
import type { ExpressionNode } from "../src/model/types.js";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edgelore-m2-"));
  return {
    path: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const AVG_LE_5000: ExpressionNode = {
  op: "<=",
  args: [{ op: "avg", args: [{ ref: "x1" }] }, 5000],
};

/** Seed a dimension + three numeric statements + a proposed constraint. */
function seed(g: SqliteGraph): { dimId: string; constraintId: string } {
  const dim = g.addNode({ type: "core:dimension", key: "design_cost", created_by: "agent:x:1" });
  for (const v of [3000, 4000, 2000]) {
    g.addNode({
      type: "core:statement",
      dimension_id: dim.id,
      value: v,
      unit: "CNY",
      created_by: "agent:x:1",
    });
  }
  const c = g.addConstraint({
    participants: [dim.id],
    bindings: { x1: dim.id },
    expression: AVG_LE_5000,
    created_by: "agent:x:1",
  });
  return { dimId: dim.id, constraintId: c.id };
}

// --- behavior parity --------------------------------------------------------

test("sqlite: add / query / evaluate behave like the in-memory store", () => {
  const { path, cleanup } = tempDb();
  try {
    const g = new SqliteGraph(path);
    const { constraintId } = seed(g);
    assert.equal(g.queryNodes({ type: "core:statement" }).length, 3);
    assert.equal(g.evaluateConstraint(constraintId), "satisfied");
    g.close();
  } finally {
    cleanup();
  }
});

test("sqlite: fact-node state machine is enforced", () => {
  const { path, cleanup } = tempDb();
  try {
    const g = new SqliteGraph(path);
    const dim = g.addNode({ type: "core:dimension", key: "k", created_by: "agent:x:1" });
    g.transitionNodeState(dim.id, "accepted");
    assert.equal(g.getNode(dim.id)?.state, "accepted");
    assert.throws(() => g.transitionNodeState(dim.id, "tentative"), /illegal fact-node transition/);
    g.close();
  } finally {
    cleanup();
  }
});

test("sqlite: Q01 — activation requires a human approver", () => {
  const { path, cleanup } = tempDb();
  try {
    const g = new SqliteGraph(path);
    const { constraintId } = seed(g);
    assert.throws(() => g.transitionConstraintState(constraintId, "active"), /Q01/);
    assert.throws(
      () => g.transitionConstraintState(constraintId, "active", { approved_by: "agent:x:1" }),
      /Q01: approved_by must be a human:<id>/,
    );
    const c = g.transitionConstraintState(constraintId, "active", { approved_by: "human:charles" });
    assert.equal(c.activation_state, "active");
    assert.equal(c.approved_by, "human:charles");
    g.close();
  } finally {
    cleanup();
  }
});

// --- persistence ------------------------------------------------------------

test("sqlite: graph survives close + reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    let dimId: string;
    let constraintId: string;
    {
      const g = new SqliteGraph(path);
      ({ dimId, constraintId } = seed(g));
      g.transitionConstraintState(constraintId, "active", { approved_by: "human:charles" });
      g.close();
    }
    {
      const g = new SqliteGraph(path);
      const dim = g.getNode(dimId);
      assert.ok(dim, "dimension must survive reopen");
      assert.equal(dim?.type, "core:dimension");
      assert.equal(g.queryNodes({ type: "core:statement" }).length, 3);
      const c = g.getConstraint(constraintId);
      assert.equal(c?.activation_state, "active");
      assert.equal(c?.approved_by, "human:charles");
      assert.equal(g.evaluateConstraint(constraintId), "satisfied");
      g.close();
    }
  } finally {
    cleanup();
  }
});

test("sqlite: state transitions persist across reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    let nodeId: string;
    {
      const g = new SqliteGraph(path);
      const n = g.addNode({ type: "core:project", created_by: "agent:x:1" });
      nodeId = n.id;
      g.transitionNodeState(nodeId, "accepted");
      g.close();
    }
    {
      const g = new SqliteGraph(path);
      assert.equal(g.getNode(nodeId)?.state, "accepted");
      g.close();
    }
  } finally {
    cleanup();
  }
});

test("sqlite: evaluation still reflects live writes after reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    let constraintId: string;
    let dimId: string;
    {
      const g = new SqliteGraph(path);
      ({ constraintId, dimId } = seed(g));
      g.close();
    }
    {
      const g = new SqliteGraph(path);
      // Push the average above the threshold after reopen:
      // (3000+4000+2000+12000)/4 = 5250 > 5000.
      g.addNode({
        type: "core:statement",
        dimension_id: dimId,
        value: 12000,
        unit: "CNY",
        created_by: "agent:x:1",
      });
      assert.equal(g.evaluateConstraint(constraintId), "violated");
      g.close();
    }
  } finally {
    cleanup();
  }
});
