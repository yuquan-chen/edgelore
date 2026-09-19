// edgelore · LongMemEval — merge shard databases into one memory.db.
//
// The 4 parallel ingestion workers each wrote their own SQLite file (avoiding
// write contention). Node/constraint ids are UUIDs and embedding rows are
// keyed by node id, so the row-level INSERT OR REPLACE pass is collision-free.
//
// BUT: parallel workers each mint their OWN dimension node for the same
// concept key (knownDimensions only sees the worker's own shard) — a naive
// row merge leaves "billieEilishConcertAttendance" as 2-4 duplicate dimension
// nodes, splitting one concept's statements (and its grouped count header!)
// across shards. The old library had 167 such keys / 350 duplicate nodes.
// So after the row copy we UNIFY dimensions by key: pick a canonical node,
// remap every statement's dimension_id, merge descriptions, drop duplicates.
// This is the harness-scale version of the product's key-identity +
// reconciliation story (multi-writer shared memory): value clashes surface
// as multi-accepted dimensions and are left to the ask layer's rules
// ("latest accepted = truth"; "count everything that happened").
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

// --- 按 key 统一维度（跨分片重复铸造的调和步骤） -------------------------------

const dims = target
  .prepare("SELECT id, data FROM nodes WHERE type = 'core:dimension'")
  .all()
  .map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
const byKey = new Map();
for (const d of dims) {
  if (!byKey.has(d.key)) byKey.set(d.key, []);
  byKey.get(d.key).push(d);
}

const remapStmt = target.prepare(
  "UPDATE nodes SET dimension_id = ?, data = json_set(data, '$.dimension_id', ?) WHERE id = ?",
);
const updateDim = target.prepare("UPDATE nodes SET data = ? WHERE id = ?");
const deleteNode = target.prepare("DELETE FROM nodes WHERE id = ?");
const deleteVector = target.prepare("DELETE FROM embeddings WHERE node_id = ?");

let unifiedKeys = 0;
let droppedDims = 0;
let remappedStmts = 0;
for (const group of byKey.values()) {
  if (group.length === 1) continue;
  unifiedKeys += 1;
  // canonical = deterministic first-seen; description = longest non-empty
  const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = sorted[0];
  const bestDesc = sorted
    .map((d) => d.attributes?.description)
    .filter((s) => typeof s === "string" && s.length > 0)
    .sort((a, b) => b.length - a.length)[0];
  if (bestDesc && bestDesc !== canonical.attributes?.description) {
    canonical.attributes = { ...canonical.attributes, description: bestDesc };
    updateDim.run(JSON.stringify({ ...canonical, attributes: canonical.attributes }), canonical.id);
  }
  for (const dup of sorted.slice(1)) {
    const moved = target
      .prepare("SELECT id FROM nodes WHERE type = 'core:statement' AND dimension_id = ?")
      .all(dup.id);
    for (const s of moved) {
      remapStmt.run(canonical.id, canonical.id, s.id);
      remappedStmts += 1;
    }
    deleteNode.run(dup.id);
    deleteVector.run(dup.id);
    droppedDims += 1;
  }
}

// --- 合并后报告 ----------------------------------------------------------------

const finalCounts = target
  .prepare("SELECT type, COUNT(*) c FROM nodes GROUP BY type")
  .all()
  .map((r) => `${r.type}=${r.c}`)
  .join(", ");

// 可见的跨分片值冲突：single 卡维度上 >1 个 accepted。
// capture() 本会给这类写入标 conflict，但行级合并绕过了它——这里补上标记，
// 恢复不变量：这些案子由此进入 listConflicts 裁决台，resolve（人审）与
// autoresolve（约束裁判）从此可接管。benchmark 无人在环，标记本身不改
// 语句状态（ask 规则 3/4 照常工作）；产品侧由人工/规则在裁决台消化。
const clashDims = target
  .prepare(
    `SELECT d.id, d.data FROM nodes d WHERE d.type='core:dimension' AND d.state != 'conflict'
     AND json_extract(d.data,'$.cardinality')='single'
     AND (SELECT COUNT(*) FROM nodes s WHERE s.type='core:statement'
          AND json_extract(s.data,'$.dimension_id')=d.id
          AND s.state='accepted') > 1`,
  )
  .all();
const flagClash = target.prepare(
  "UPDATE nodes SET state = 'conflict', data = json_set(data, '$.state', 'conflict', '$.updated_at', ?) WHERE id = ?",
);
const nowIso = new Date().toISOString();
for (const d of clashDims) flagClash.run(nowIso, d.id);

console.log(`\n维度按 key 统一: ${unifiedKeys} 个 key 调和, ${droppedDims} 个重复节点删除, ${remappedStmts} 条语句重挂`);
console.log(`跨分片值冲突已标记 conflict（进入裁决台，resolve/autoresolve 可接管）: ${clashDims.length}`);
console.log(`merged store: ${finalCounts}, edges=${totals.edges}, constraints=${totals.constraints}, vectors=${totals.embeddings}`);
target.close();
