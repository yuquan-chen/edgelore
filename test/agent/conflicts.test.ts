// edgelore · Agent Memory layer — conflict listing & adjudication tests.
//
// Covers the docket (listConflicts), human resolution (winner accepted,
// losers superseded, core:supersedes audit edges attributed to the human,
// dimension restored), governance rejects (agent resolver, non-conflicted
// dimension, foreign/terminal winner), constraint-guided auto resolution
// (decides when a rule separates candidates, escalates otherwise), and
// backend parity (MemoryGraph + SqliteGraph).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGraph, type GraphStore } from "../../src/model/store.js";
import { SqliteGraph } from "../../src/store/sqlite.js";
import { capture } from "../../src/agent/capture.js";
import {
  autoResolveConstraintGuided,
  listConflicts,
  resolveConflict,
} from "../../src/agent/conflicts.js";

const ctx = { created_by: "human:charles", source_refs: ["t:1"] };

/** Build a conflicted budget dimension: 5000 accepted vs 8000 tentative. */
function buildConflict(g: MemoryGraph): { dimensionId: string; acceptedId: string; tentativeId: string } {
  const r1 = capture(g, { dimensionKey: "budget", value: 5000, cardinality: "single", unit: "CNY" }, ctx);
  const r2 = capture(g, { dimensionKey: "budget", value: 8000 }, ctx); // clash
  return { dimensionId: r1.dimensionId, acceptedId: r1.statementId as string, tentativeId: r2.statementId as string };
}

test("conflicts: clean graph has an empty docket", () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  assert.deepEqual(listConflicts(graph), []);
});

test("conflicts: docket shows dimension with incumbents and challengers", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const cases = listConflicts(graph);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.dimensionId, c.dimensionId);
  assert.equal(cases[0]?.dimensionKey, "budget");
  assert.equal(cases[0]?.incumbents[0]?.value, 5000);
  assert.equal(cases[0]?.incumbents[0]?.createdBy, "human:charles");
  assert.equal(cases[0]?.challengers[0]?.value, 8000);
});

test("conflicts: challenger wins — accepted, incumbent superseded, dimension restored, audit edge", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const r = resolveConflict(graph, c.dimensionId, c.tentativeId, {
    resolvedBy: "human:charles",
    note: "price updated",
  });
  assert.equal(r.winnerId, c.tentativeId);
  assert.deepEqual(r.supersededIds, [c.acceptedId]);
  assert.equal((graph.getNode(c.tentativeId) as { state: string }).state, "accepted");
  assert.equal((graph.getNode(c.acceptedId) as { state: string }).state, "superseded");
  const dim = graph.getNode(c.dimensionId) as { state: string };
  assert.equal(dim.state, "accepted");
  // audit: a core:supersedes edge attributed to the human resolver
  const audit = graph.getAllEdges().find((e) => e.type === "core:supersedes");
  assert.equal(audit?.from, c.tentativeId);
  assert.equal(audit?.to, c.acceptedId);
  assert.equal(audit?.created_by, "human:charles");
  assert.equal(audit?.attributes.note, "price updated");
});

test("conflicts: incumbent wins — challenger superseded, winner untouched", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const r = resolveConflict(graph, c.dimensionId, c.acceptedId, { resolvedBy: "human:charles" });
  assert.equal(r.winnerId, c.acceptedId);
  assert.deepEqual(r.supersededIds, [c.tentativeId]);
  assert.equal((graph.getNode(c.acceptedId) as { state: string }).state, "accepted");
  assert.equal((graph.getNode(c.tentativeId) as { state: string }).state, "superseded");
});

test("conflicts: agent resolver is rejected (Q01 governance)", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  assert.throws(
    () => resolveConflict(graph, c.dimensionId, c.tentativeId, { resolvedBy: "agent:edgelore:1" }),
    /human:<id>/,
  );
});

test("conflicts: resolving a non-conflicted dimension is rejected", () => {
  const graph = new MemoryGraph();
  const r = capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  assert.throws(
    () => resolveConflict(graph, r.dimensionId, r.statementId as string, { resolvedBy: "human:x" }),
    /not in conflict/,
  );
});

test("conflicts: foreign or terminal winner is rejected", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const foreign = capture(graph, { dimensionKey: "owner", value: "charles" }, ctx);
  assert.throws(
    () => resolveConflict(graph, c.dimensionId, foreign.statementId as string, { resolvedBy: "human:x" }),
    /does not belong/,
  );
  // terminal statement cannot be revived
  graph.transitionNodeState(c.tentativeId, "rejected");
  assert.throws(
    () => resolveConflict(graph, c.dimensionId, c.tentativeId, { resolvedBy: "human:x" }),
    /terminal/,
  );
});

test("autoresolve: constraint separates candidates — 5000 satisfied, 8000 violated", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const constraint = graph.addConstraint({
    participants: [c.dimensionId],
    bindings: { x1: c.dimensionId },
    expression: { op: "<=", args: [{ op: "avg", args: [{ ref: "x1" }] }, 6000] },
    created_by: "human:charles",
  });
  graph.transitionConstraintState(constraint.id, "active", { approved_by: "human:charles" });

  const outcome = autoResolveConstraintGuided(graph, c.dimensionId);
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.result?.winnerId, c.acceptedId); // 5000 satisfies <= 6000
  assert.match(outcome.reason, /satisfied/);
  assert.match(outcome.reason, /8000=violated/);
});

test("autoresolve: rule satisfied by BOTH candidates escalates", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const constraint = graph.addConstraint({
    participants: [c.dimensionId],
    bindings: { x1: c.dimensionId },
    expression: { op: "<=", args: [{ op: "avg", args: [{ ref: "x1" }] }, 100000] },
    created_by: "human:charles",
  });
  graph.transitionConstraintState(constraint.id, "active", { approved_by: "human:charles" });

  const outcome = autoResolveConstraintGuided(graph, c.dimensionId);
  assert.equal(outcome.status, "escalated");
  assert.match(outcome.reason, /no active constraint separates/);
});

test("autoresolve: no constraint escalates", () => {
  const graph = new MemoryGraph();
  const c = buildConflict(graph);
  const outcome = autoResolveConstraintGuided(graph, c.dimensionId);
  assert.equal(outcome.status, "escalated");
  assert.match(outcome.reason, /no active .* constraint/);
});

test("conflicts: resolution parity across both backends", () => {
  const run = (g: GraphStore, name: string): void => {
    const mg = g as MemoryGraph;
    const c = buildConflict(mg);
    const r = resolveConflict(mg, c.dimensionId, c.tentativeId, { resolvedBy: "human:charles" });
    assert.equal(r.supersededIds.length, 1, name);
    assert.equal((mg.getNode(c.dimensionId) as { state: string }).state, "accepted", name);
  };
  run(new MemoryGraph(), "MemoryGraph");
  const dir = mkdtempSync(join(tmpdir(), "edgelore-conflicts-"));
  const g = new SqliteGraph(join(dir, "t.db"));
  try {
    run(g, "SqliteGraph");
  } finally {
    g.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
