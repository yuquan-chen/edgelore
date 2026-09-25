// edgelore · M3 — capture primitive tests.
//
// Every case follows the user-mandated pattern: one CaptureContent input (+ an
// injected CaptureContext) -> assert the resulting graph state. No trigger /
// extraction logic is exercised. Each case runs against BOTH backends
// (in-memory MemoryGraph and durable SqliteGraph) to guarantee parity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGraph, type GraphStore } from "../src/model/store.js";
import { SqliteGraph } from "../src/store/sqlite.js";
import { capture, type CaptureContext } from "../src/agent/capture.js";

const ctx: CaptureContext = { created_by: "agent:workbuddy:1", source_refs: ["msg:1"] };

/**
 * Run `fn` against both backends, cleaning up the SQLite temp file afterwards.
 * The in-memory store needs no cleanup.
 */
function forBackend(fn: (g: GraphStore, name: string) => void): void {
  fn(new MemoryGraph(), "MemoryGraph");
  const dir = mkdtempSync(join(tmpdir(), "edgelore-m3-"));
  const path = join(dir, "t.db");
  const g = new SqliteGraph(path);
  try {
    fn(g, "SqliteGraph");
  } finally {
    g.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. First capture of a key → dimension created (multi default) + accepted stmt.
test("capture: first capture creates dimension (multi) + accepted statement", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    assert.equal(r.created, true);
    assert.equal(r.deduplicated, false);
    assert.equal(r.conflict, false);
    assert.ok(r.dimensionId);
    assert.ok(r.statementId);
    const dim = g.getNode(r.dimensionId);
    assert.equal(dim?.type, "core:dimension");
    assert.equal(dim?.cardinality, "multi");
    const stmt = g.getNode(r.statementId!) as { type: string; value: unknown; state: string };
    assert.equal(stmt.type, "core:statement");
    assert.equal(stmt.value, "charles");
    assert.equal(stmt.state, "accepted");
  });
});

// 2. Exact duplicate → no new statement, deduplicated: true.
test("capture: exact duplicate is deduplicated (no new statement)", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    const before = g.queryNodes({ type: "core:statement" }).length;
    const r2 = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.statementId, r1.statementId);
    assert.equal(g.queryNodes({ type: "core:statement" }).length, before);
  });
});

// 3. Multi-cardinality, distinct values → both accepted, no conflict.
test("capture: multi-cardinality distinct values both accepted, no conflict", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "tags", value: "a" }, ctx);
    const r2 = capture(g, { dimensionKey: "tags", value: "b" }, ctx);
    assert.equal(r1.conflict, false);
    assert.equal(r2.conflict, false);
    const stmts = g.queryNodes({ type: "core:statement" });
    assert.equal(stmts.length, 2);
    assert.ok(stmts.every((s) => s.state === "accepted"));
  });
});

// 4. Single-cardinality, conflicting value → new tentative, old accepted,
//    dimension flagged conflict, conflict: true.
test("capture: single-cardinality conflicting value -> tentative + dimension flagged", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "owner", value: "alice", cardinality: "single" }, ctx);
    assert.equal(r1.conflict, false);
    const oldStmt = g.getNode(r1.statementId!) as { state: string };
    assert.equal(oldStmt.state, "accepted");
    const r2 = capture(g, { dimensionKey: "owner", value: "bob", cardinality: "single" }, ctx);
    assert.equal(r2.conflict, true);
    assert.equal(r2.deduplicated, false);
    const newStmt = g.getNode(r2.statementId!) as { state: string };
    assert.equal(newStmt.state, "tentative");
    assert.equal(oldStmt.state, "accepted"); // untouched
    const dim = g.getNode(r1.dimensionId) as { state: string };
    assert.equal(dim.state, "conflict");
    assert.equal(g.queryNodes({ type: "core:statement" }).length, 2);
    const contradictions = g.queryEdges({
      type: "core:contradicts",
      from: r2.statementId!,
      to: r1.statementId!,
    });
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0]?.attributes.reason, "single-cardinality incompatible values");
  });
});

// 5. Single-cardinality, same value after conflict → still deduplicated.
test("capture: single-cardinality same value after conflict is deduplicated", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "owner", value: "alice", cardinality: "single" }, ctx);
    capture(g, { dimensionKey: "owner", value: "bob", cardinality: "single" }, ctx); // clash
    const r3 = capture(g, { dimensionKey: "owner", value: "alice", cardinality: "single" }, ctx);
    assert.equal(r3.deduplicated, true);
    assert.equal(r3.conflict, false);
    assert.equal(r3.statementId, r1.statementId);
  });
});

// 6. Provenance auto-filled from ctx, never from content.
test("capture: provenance comes from ctx (created_by / source_refs)", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    const stmt = g.getNode(r.statementId!) as { created_by: string; source_refs: string[] };
    assert.equal(stmt.created_by, "agent:workbuddy:1");
    assert.deepEqual(stmt.source_refs, ["msg:1"]);
  });
});

// 7. Durable — run on SqliteGraph, close, reopen, assert the same state.
test("capture: survives close + reopen on SqliteGraph", () => {
  const dir = mkdtempSync(join(tmpdir(), "edgelore-m3-"));
  const path = join(dir, "t.db");
  let dimId: string;
  let stmtId: string;
  try {
    {
      const g = new SqliteGraph(path);
      const r = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
      dimId = r.dimensionId;
      stmtId = r.statementId!;
      g.close();
    }
    {
      const g = new SqliteGraph(path);
      const dim = g.getNode(dimId);
      assert.ok(dim, "dimension must survive reopen");
      assert.equal(dim?.type, "core:dimension");
      assert.equal(dim?.cardinality, "multi");
      const stmt = g.getNode(stmtId) as { value: unknown; state: string } | undefined;
      assert.ok(stmt, "statement must survive reopen");
      assert.equal(stmt?.value, "charles");
      assert.equal(stmt?.state, "accepted");
      g.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 8. description rides into dimension attributes on CREATE only.
test("capture: description is stored as attributes.description on new dimensions", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "owner", value: "charles", description: "项目负责人" }, ctx);
    const dim = g.getNode(r.dimensionId) as { attributes: Record<string, unknown> };
    assert.equal(dim.attributes.description, "项目负责人");
    // description on an EXISTING dimension is ignored (no overwrite)
    capture(g, { dimensionKey: "owner", value: "alice", description: "another meaning" }, ctx);
    const dim2 = g.getNode(r.dimensionId) as { attributes: Record<string, unknown> };
    assert.equal(dim2.attributes.description, "项目负责人");
  });
});

test("capture: new dimensions carry compatibility Slot coordinates", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    const dim = g.getNode(r.dimensionId) as { attributes: Record<string, unknown> };
    assert.deepEqual(dim.attributes, {
      propertyKey: "author",
      subjectRef: "$scopeOwner",
    });
  });
});

// --- W2: saidBy content-axis attribution + trust policy -----------------------

// 9. Assistant-authored statement -> tentative, dimension NOT flagged conflict.
test("capture: saidBy=assistant enters tentative without flagging conflict", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "db_choice", value: "PostgreSQL", saidBy: "assistant" }, ctx);
    assert.equal(r.state, "tentative");
    assert.equal(r.conflict, false);
    const stmt = g.getNode(r.statementId!) as { state: string; saidBy?: string };
    assert.equal(stmt.state, "tentative");
    assert.equal(stmt.saidBy, "assistant");
  });
});

// 10. Assistant claim clashing with an accepted incumbent: tentative, but the
//     dimension stays OUT of the human adjudication queue.
test("capture: assistant clash on single-cardinality dimension does not flag conflict", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "db", value: "MySQL", cardinality: "single" }, ctx);
    const r2 = capture(g, { dimensionKey: "db", value: "PostgreSQL", saidBy: "assistant" }, ctx);
    assert.equal(r2.state, "tentative");
    assert.equal(r2.conflict, false);
    const dim = g.getNode(r1.dimensionId) as { state: string };
    assert.notEqual(dim.state, "conflict");
  });
});

// 11. saidBy=user keeps the legacy accepted path (trust policy keys off saidBy).
test("capture: saidBy=user keeps the legacy accepted path", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "owner", value: "alice", saidBy: "user" }, ctx);
    assert.equal(r.state, "accepted");
    assert.equal(r.conflict, false);
    const stmt = g.getNode(r.statementId!) as { state: string; saidBy?: string };
    assert.equal(stmt.state, "accepted");
    assert.equal(stmt.saidBy, "user");
  });
});

// 12. User restating an assistant's tentative value = confirmation (flip).
test("capture: user restating an assistant value confirms it (tentative -> accepted)", () => {
  forBackend((g) => {
    const a = capture(g, { dimensionKey: "db", value: "PostgreSQL", saidBy: "assistant" }, ctx);
    assert.equal(a.state, "tentative");
    const u = capture(g, { dimensionKey: "db", value: "PostgreSQL" }, ctx);
    assert.equal(u.deduplicated, true);
    assert.equal(u.state, "accepted");
    const stmt = g.getNode(u.statementId!) as { state: string };
    assert.equal(stmt.state, "accepted");
  });
});

// 13. ...but the flip never mints a second accepted on a single dimension:
//     restating against an incumbent flags the conflict for resolve instead.
test("capture: user restatement clashing with an incumbent flags conflict", () => {
  forBackend((g) => {
    const u1 = capture(g, { dimensionKey: "db", value: "MySQL", cardinality: "single" }, ctx);
    const a = capture(g, { dimensionKey: "db", value: "PostgreSQL", saidBy: "assistant" }, ctx);
    const u2 = capture(g, { dimensionKey: "db", value: "PostgreSQL" }, ctx);
    assert.equal(u2.deduplicated, true);
    assert.equal(u2.conflict, true);
    assert.equal(u2.state, "tentative"); // NOT promoted — a clash needs resolve
    const dim = g.getNode(u1.dimensionId) as { state: string };
    assert.equal(dim.state, "conflict");
    const pg = g.getNode(a.statementId!) as { state: string };
    assert.equal(pg.state, "tentative"); // untouched, awaiting resolve
    assert.equal(
      g.queryEdges({
        type: "core:contradicts",
        from: a.statementId!,
        to: u1.statementId!,
      }).length,
      1,
    );
  });
});

// 14. No flip while an adjudication is already running (dimension conflict).
test("capture: no confirmation flip while the dimension is in conflict", () => {
  forBackend((g) => {
    const r1 = capture(g, { dimensionKey: "budget", value: 5000, cardinality: "single" }, ctx);
    capture(g, { dimensionKey: "budget", value: 8000, cardinality: "single" }, ctx); // user clash
    const dim = g.getNode(r1.dimensionId) as { state: string };
    assert.equal(dim.state, "conflict");
    const a = capture(g, { dimensionKey: "budget", value: 8000, saidBy: "assistant" }, ctx);
    assert.equal(a.deduplicated, true);
    assert.equal(a.state, "tentative"); // the user-vs-user clash stays as-is
  });
});

// 15. Invalid attribution fails loud at the boundary.
test("capture: invalid saidBy is rejected", () => {
  forBackend((g) => {
    assert.throws(
      () => capture(g, { dimensionKey: "db", value: "x", saidBy: "system" as never }, ctx),
      /saidBy/,
    );
  });
});

test("capture: equal keys in different owner scopes create different dimensions", () => {
  forBackend((g) => {
    const alice = capture(g, { dimensionKey: "familyTrips", value: "Hawaii" }, {
      ...ctx,
      scope: { owner_id: "actor:alice" },
    });
    const bob = capture(g, { dimensionKey: "familyTrips", value: "Hawaii" }, {
      ...ctx,
      scope: { owner_id: "actor:bob" },
    });
    assert.notEqual(alice.dimensionId, bob.dimensionId);
    assert.equal(g.getNode(alice.dimensionId)?.scope?.owner_id, "actor:alice");
    assert.equal(g.getNode(bob.dimensionId)?.scope?.owner_id, "actor:bob");
  });
});

test("capture: equal keys in the same owner scope reuse one dimension", () => {
  forBackend((g) => {
    const scoped = { ...ctx, scope: { owner_id: "actor:alice" } };
    const first = capture(g, { dimensionKey: "familyTrips", value: "Hawaii" }, scoped);
    const second = capture(g, { dimensionKey: "familyTrips", value: "Paris" }, scoped);
    assert.equal(first.dimensionId, second.dimensionId);
    assert.equal(g.queryNodes({ type: "core:dimension", owner_id: "actor:alice" }).length, 1);
  });
});

test("capture: equal Property keys on different subjects create isolated Slots", () => {
  forBackend((g) => {
    const scoped = { ...ctx, scope: { owner_id: "actor:alice" } };
    const carA = capture(g, {
      dimensionKey: "carColor",
      subjectRef: "node:vehicle:car:a",
      value: "black",
      cardinality: "single",
    }, scoped);
    const carB = capture(g, {
      dimensionKey: "carColor",
      subjectRef: "node:vehicle:car:b",
      value: "white",
      cardinality: "single",
    }, scoped);
    assert.notEqual(carA.dimensionId, carB.dimensionId);
    assert.equal(carA.conflict, false);
    assert.equal(carB.conflict, false);
    const dimensions = g.queryNodes({ type: "core:dimension", owner_id: "actor:alice" });
    assert.equal(dimensions.length, 2);
    assert.deepEqual(
      dimensions.map((dimension) => dimension.attributes.subjectRef).sort(),
      ["node:vehicle:car:a", "node:vehicle:car:b"],
    );
  });
});

test("capture: equal Property key and subject reuse one Slot", () => {
  forBackend((g) => {
    const scoped = { ...ctx, scope: { owner_id: "actor:alice" } };
    const first = capture(g, {
      dimensionKey: "carColor",
      subjectRef: "node:vehicle:car:a",
      value: "black",
      cardinality: "single",
    }, scoped);
    const second = capture(g, {
      dimensionKey: "carColor",
      subjectRef: "node:vehicle:car:a",
      value: "blue",
      cardinality: "single",
    }, scoped);
    assert.equal(first.dimensionId, second.dimensionId);
    assert.equal(second.conflict, true);
  });
});
