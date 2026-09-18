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

test("capture: no description -> attributes stay empty", () => {
  forBackend((g) => {
    const r = capture(g, { dimensionKey: "author", value: "charles" }, ctx);
    const dim = g.getNode(r.dimensionId) as { attributes: Record<string, unknown> };
    assert.deepEqual(dim.attributes, {});
  });
});
