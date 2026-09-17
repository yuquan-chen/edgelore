// edgelore · M2 — Durable graph backend (SQLite, zero external deps).
//
// SqliteGraph extends MemoryGraph — the reference implementation of all model
// enforcement (provenance, ids, state machines, Q01) — and adds durability:
//
//   on open       create tables if missing; load every row into memory
//   on mutation   delegate to super (full enforcement), then write-through
//
// Schema: JSON blob + a few index columns (open-world typing means the column
// set must stay open, so the full object rides in `data`; type evolution never
// needs a migration). See docs/shared-memory-m2-spec.md §3.
//
// Engine: Node's built-in `node:sqlite` (experimental — prints a warning to
// stderr; stdout/JSON contracts are unaffected). Escape hatch if the API ever
// breaks: better-sqlite3 behind this same class API (documented, not built).

import { DatabaseSync } from "node:sqlite";
import {
  MemoryGraph,
  type AddConstraintInput,
  type AddEdgeInput,
  type AddNodeInput,
} from "../model/store.js";
import type {
  Constraint,
  ConstraintState,
  FactNodeState,
  GraphEdge,
  GraphNode,
  StatementNode,
} from "../model/types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  state        TEXT NOT NULL,
  dimension_id TEXT,
  data         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  data    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS constraints (
  id    TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,
  state TEXT NOT NULL,
  data  TEXT NOT NULL
);
`;

/** Row shape returned by `SELECT data ...` queries. */
interface DataRow {
  data: string;
}

/**
 * A MemoryGraph whose every mutation is also persisted to a SQLite file.
 * The whole graph is resident in memory (durable write-through cache); lazy
 * loading for very large graphs is out of M2 scope.
 */
export class SqliteGraph extends MemoryGraph {
  private db: DatabaseSync;

  constructor(path: string) {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    this.loadAll();
  }

  /** Close the underlying database (tests / CLI shutdown). */
  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------- loading

  private loadAll(): void {
    for (const row of this.db.prepare("SELECT data FROM nodes").all() as unknown as DataRow[]) {
      const n = JSON.parse(row.data) as GraphNode;
      this.nodes.set(n.id, n);
    }
    for (const row of this.db.prepare("SELECT data FROM edges").all() as unknown as DataRow[]) {
      const e = JSON.parse(row.data) as GraphEdge;
      this.edges.set(e.id, e);
    }
    for (const row of this.db
      .prepare("SELECT data FROM constraints")
      .all() as unknown as DataRow[]) {
      const c = JSON.parse(row.data) as Constraint;
      this.constraints.set(c.id, c);
    }
  }

  // -------------------------------------------------------- write-through

  override addNode(input: AddNodeInput): GraphNode {
    const n = super.addNode(input);
    const dimensionId = n.type === "core:statement" ? (n as StatementNode).dimension_id : null;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO nodes (id, type, state, dimension_id, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(n.id, n.type, n.state, dimensionId, JSON.stringify(n));
    return n;
  }

  override addEdge(input: AddEdgeInput): GraphEdge {
    const e = super.addEdge(input);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO edges (id, type, from_id, to_id, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.id, e.type, e.from, e.to, JSON.stringify(e));
    return e;
  }

  override addConstraint(input: AddConstraintInput): Constraint {
    const c = super.addConstraint(input);
    this.persistConstraint(c);
    return c;
  }

  override transitionNodeState(id: string, to: FactNodeState): GraphNode {
    const n = super.transitionNodeState(id, to);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO nodes (id, type, state, dimension_id, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        n.id,
        n.type,
        n.state,
        n.type === "core:statement" ? (n as StatementNode).dimension_id : null,
        JSON.stringify(n),
      );
    return n;
  }

  override transitionConstraintState(
    id: string,
    to: ConstraintState,
    opts?: { approved_by?: string },
  ): Constraint {
    const c = super.transitionConstraintState(id, to, opts);
    this.persistConstraint(c);
    return c;
  }

  private persistConstraint(c: Constraint): void {
    this.db
      .prepare("INSERT OR REPLACE INTO constraints (id, kind, state, data) VALUES (?, ?, ?, ?)")
      .run(c.id, c.kind, c.activation_state, JSON.stringify(c));
  }
}
