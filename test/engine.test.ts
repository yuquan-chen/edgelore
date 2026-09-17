// edgelore · M1 — engine tests.
//
// Covers the four evaluation states, the D09 whitelist, aggregation, missing-
// data propagation, and the store-level wiring (evaluateConstraint).

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type EvalContext } from "../src/engine/evaluate.js";
import { MemoryGraph } from "../src/model/store.js";
import type { ExpressionNode } from "../src/model/types.js";

// A graph-agnostic context: x1 has data, x2 is empty (no data yet).
const ctx: EvalContext = {
  resolveRef: (name: string): number[] | null => {
    if (name === "x1") return [3000, 4000, 2000];
    if (name === "x2") return [];
    return null; // undeclared binding
  },
};

test("satisfied: simple comparison holds", () => {
  const expr: ExpressionNode = { op: "<", args: [3, 5] };
  assert.equal(evaluate(expr, ctx), "satisfied");
});

test("violated: simple comparison fails", () => {
  const expr: ExpressionNode = { op: "<", args: [5, 3] };
  assert.equal(evaluate(expr, ctx), "violated");
});

test("indeterminate: aggregation over empty dimension", () => {
  const expr: ExpressionNode = { op: "<=", args: [{ op: "avg", args: [{ ref: "x2" }] }, 5000] };
  assert.equal(evaluate(expr, ctx), "indeterminate");
});

test("error: operator outside the D09 whitelist", () => {
  const expr: ExpressionNode = { op: "^", args: [2, 3] } as ExpressionNode;
  assert.equal(evaluate(expr, ctx), "error");
});

test("error: division by zero", () => {
  const expr: ExpressionNode = { op: "==", args: [{ op: "/", args: [1, 0] }, 1] };
  assert.equal(evaluate(expr, ctx), "error");
});

test("error: top-level expression is numeric, not boolean", () => {
  const expr: ExpressionNode = { op: "+", args: [1, 2] };
  assert.equal(evaluate(expr, ctx), "error");
});

test("error: bare ref used outside aggregation", () => {
  const expr: ExpressionNode = { op: "<", args: [{ ref: "x1" }, 5] };
  assert.equal(evaluate(expr, ctx), "error");
});

test("error: undeclared binding inside aggregation", () => {
  const expr: ExpressionNode = { op: "<", args: [{ op: "sum", args: [{ ref: "missing" }] }, 10] };
  assert.equal(evaluate(expr, ctx), "error");
});

test("logical and: both true", () => {
  const expr: ExpressionNode = {
    op: "and",
    args: [
      { op: "<", args: [1, 2] },
      { op: ">", args: [3, 2] },
    ],
  };
  assert.equal(evaluate(expr, ctx), "satisfied");
});

test("logical or: one side indeterminate propagates", () => {
  const expr: ExpressionNode = {
    op: "or",
    args: [
      { op: "<", args: [5, 3] }, // violated
      { op: "<=", args: [{ op: "avg", args: [{ ref: "x2" }] }, 1] }, // indeterminate
    ],
  };
  assert.equal(evaluate(expr, ctx), "indeterminate");
});

test("not: negates a boolean sub-tree", () => {
  const expr: ExpressionNode = { op: "not", args: [{ op: "<", args: [5, 3] }] };
  assert.equal(evaluate(expr, ctx), "satisfied");
});

test("aggregation: sum equals the total", () => {
  const expr: ExpressionNode = { op: "==", args: [{ op: "sum", args: [{ ref: "x1" }] }, 9000] };
  assert.equal(evaluate(expr, ctx), "satisfied");
});

test("aggregation: count of statements", () => {
  const expr: ExpressionNode = { op: "==", args: [{ op: "count", args: [{ ref: "x1" }] }, 3] };
  assert.equal(evaluate(expr, ctx), "satisfied");
});

// --- store-level wiring ----------------------------------------------------

function buildGraph(values: number[], withExpression: ExpressionNode | undefined): MemoryGraph {
  const g = new MemoryGraph();
  const dim = g.addNode({
    type: "core:dimension",
    key: "design_cost",
    created_by: "agent:x:1",
  });
  for (const v of values) {
    g.addNode({
      type: "core:statement",
      dimension_id: dim.id,
      value: v,
      unit: "CNY",
      created_by: "agent:x:1",
    });
  }
  g.addConstraint({
    participants: [dim.id],
    bindings: { x1: dim.id },
    expression: withExpression,
    created_by: "agent:x:1",
  });
  return g;
}

test("store: avg below threshold is satisfied", () => {
  const g = buildGraph([3000, 4000, 2000], {
    op: "<=",
    args: [{ op: "avg", args: [{ ref: "x1" }] }, 5000],
  });
  const c = g.getAllConstraints()[0];
  assert.equal(g.evaluateConstraint(c.id), "satisfied");
});

test("store: avg above threshold is violated", () => {
  const g = buildGraph([3000, 4000, 2000], {
    op: "<=",
    args: [{ op: "avg", args: [{ ref: "x1" }] }, 2500],
  });
  const c = g.getAllConstraints()[0];
  assert.equal(g.evaluateConstraint(c.id), "violated");
});

test("store: no statements yet is indeterminate", () => {
  const g = buildGraph([], {
    op: "<=",
    args: [{ op: "avg", args: [{ ref: "x1" }] }, 5000],
  });
  const c = g.getAllConstraints()[0];
  assert.equal(g.evaluateConstraint(c.id), "indeterminate");
});

test("store: constraint without expression is error", () => {
  const g = buildGraph([100], undefined);
  const c = g.getAllConstraints()[0];
  assert.equal(g.evaluateConstraint(c.id), "error");
});

test("store: unknown constraint id throws ModelError", () => {
  const g = buildGraph([100], { op: "<=", args: [{ op: "avg", args: [{ ref: "x1" }] }, 5] });
  assert.throws(() => g.evaluateConstraint("constraint:does-not-exist"), /constraint not found/);
});
