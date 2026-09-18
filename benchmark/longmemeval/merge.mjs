// edgelore · LongMemEval — merge shard databases into one memory.db.
//
// The 4 parallel ingestion workers each wrote their own SQLite file (avoiding
// write contention). All node/constraint ids are UUIDs and embedding rows are
// keyed by node id, so a row-level INSERT OR REPLACE merge is collision-free.
//
// Usage: node benchmark/longmemeval/merge.mjs

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");

const shards = [0, 1, 2, 3].map((i) => join(dataDir, `memory-shard-${i}.db`));
for (const p of shards) {
  if (!existsSync(p)) {
    console.error(`missing shard db: ${p}`);
    process.exit(1);
  }
}

const target = new DatabaseSync(join(dataDir, "memory.db"));
target.exec("PRAGMA journal_mode = WAL");

// 目标库可能残留旧数据：清空重来（合并是幂等的全量重建）
target.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM constraints; DELETE FROM embeddings;");

const copy = (srcDb, table, columns) => {
  const rows = srcDb.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  const placeholders = columns.map(() => "?").join(", ");
  const stmt = target.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  for (const row of rows) stmt.run(...columns.map((c) => row[c]));
  return rows.length;
};

let totals = { nodes: 0, edges: 0, constraints: 0, embeddings: 0 };
for (const p of shards) {
  const src = new DatabaseSync(p, { readOnly: true });
  totals.nodes += copy(src, "nodes", ["id", "type", "state", "dimension_id", "data"]);
  totals.edges += copy(src, "edges", ["id", "type", "from_id", "to_id", "data"]);
  totals.constraints += copy(src, "constraints", ["id", "kind", "state", "data"]);
  totals.embeddings += copy(src, "embeddings", ["node_id", "dim", "vector"]);
  src.close();
  console.log(`merged: ${p.split("/").pop()} ✓`);
}

const finalCounts = target
  .prepare("SELECT type, COUNT(*) c FROM nodes GROUP BY type")
  .all()
  .map((r) => `${r.type}=${r.c}`)
  .join(", ");
console.log(`\nmerged store: ${finalCounts}, edges=${totals.edges}, constraints=${totals.constraints}, vectors=${totals.embeddings}`);
target.close();
