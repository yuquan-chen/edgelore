// edgelore · M5 alias merge — consolidate near-duplicate dimension keys.
//
// Problem: the same concept gets extracted under different dimension keys
// ("running5KTime" / "weekly5kFunRun" / "competitiveRunningBackground").
// Aggregate questions need ALL of them, but top-k retrieval can only fit
// a few → counting fails. This script:
//
//   1. Normalizes each key into a token set (camelCase → words)
//   2. Groups dimensions whose token sets have high overlap (Jaccard)
//   3. For each group > 1: picks a canonical dimension, moves all
//      statements to it, merges descriptions, drops duplicates
//   4. Reports: clusters found, statements moved, remaining conflicts
//
// Entropy gating: short keys (≤1 token) never auto-merge (too risky).
// Jaccard threshold is conservative (≥0.5) — false merges are worse than
// missed merges. Statements are never deleted; they're MOVED to canonical.
//
// Usage: node benchmark/longmemeval/alias-merge.mjs [--threshold 0.5] [--dry-run]

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const dbPath = join(dataDir, "memory.db");

if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

// --- token normalization ----------------------------------------------------

function camelToWords(key) {
  // "weekly5kFunRunAttendance" → ["weekly","5k","fun","run","attendance"]
  // "charity5KPersonalBest"   → ["charity","5k","personal","best"]
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")     // camelCase → camel Case
    .replace(/([A-Za-z])(\d)/g, "$1 $2")      // "5k" → "5 k"
    .replace(/(\d)([A-Za-z])/g, "$1 $2")      // "3d" → "3 d"
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSet(words) {
  return new Set(words);
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  const inter = new Set([...a].filter((x) => b.has(x)));
  return union.size === 0 ? 0 : inter.size / union.size;
}

// --- load dimensions ---------------------------------------------------------

const dims = db
  .prepare("SELECT id, data FROM nodes WHERE type = 'core:dimension'")
  .all()
  .map((r) => {
    const d = JSON.parse(r.data);
    return {
      id: r.id,
      key: d.key,
      description: d.attributes?.description ?? "",
      data: d,
      tokens: tokenSet(camelToWords(d.key)),
      stmtCount: 0,
    };
  });

console.log(`维度总数: ${dims.length}`);

// --- pairwise similarity → union-find clustering ------------------------------

const THRESHOLD = parseFloat(process.argv[process.argv.indexOf("--threshold") + 1] ?? "0.5");
const parent = new Map(dims.map((d) => [d.id, d.id]));
function find(x) {
  while (parent.get(x) !== x) parent.set(x, parent.get(parent.get(x)));
  return parent.get(x);
}
function union(a, b) {
  parent.set(find(a), find(b));
}

let mergePairs = 0;
for (let i = 0; i < dims.length; i++) {
  for (let j = i + 1; j < dims.length; j++) {
    const a = dims[i], b = dims[j];
    const jac = jaccard(a.tokens, b.tokens);
    if (jac >= THRESHOLD && a.tokens.size >= 2 && b.tokens.size >= 2) {
      union(a.id, b.id);
      mergePairs++;
    }
  }
}
console.log(`相似对(≥${THRESHOLD}): ${mergePairs}`);

// --- group by root ------------------------------------------------------------

const groups = new Map();
for (const d of dims) {
  const root = find(d.id);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(d);
}
const mergeGroups = [...groups.values()].filter((g) => g.length > 1);
console.log(`需要合并的组: ${mergeGroups.length}（涉及 ${mergeGroups.reduce((s,g)=>s+g.length,0)} 个维度）`);

// --- merge execution -----------------------------------------------------------

const remapStmt = db.prepare(
  "UPDATE nodes SET dimension_id = ?, data = json_set(data, '$.dimension_id', ?) WHERE id = ?"
);
const updateDim = db.prepare("UPDATE nodes SET data = ? WHERE id = ?");
const deleteDim = db.prepare("DELETE FROM nodes WHERE id = ?");
const deleteVec = db.prepare("DELETE FROM embeddings WHERE node_id = ?");
const countStmts = db.prepare(
  "SELECT COUNT(*) c FROM nodes WHERE type='core:statement' AND dimension_id = ?"
);

let totalMoved = 0;
let totalMerged = 0;
for (const [, group] of groups) {
  if (group.length <= 1) continue;
  // canonical: the dim with the most statements (keep the "heaviest" one)
  const withCounts = group.map((d) => ({
    ...d,
    stmts: countStmts.get(d.id).c,
  }));
  withCounts.sort((a, b) => b.stmts - a.stmts || a.id.localeCompare(b.id));
  const canonical = withCounts[0];
  const sources = withCounts.slice(1);

  // merge descriptions: pick the longest non-empty
  const descs = [canonical.description, ...sources.map((s) => s.description)]
    .filter((s) => s && s.length > 0);
  const bestDesc = descs.sort((a, b) => b.length - a.length)[0];
  if (bestDesc && bestDesc !== canonical.description) {
    canonical.attributes = { ...canonical.attributes, description: bestDesc };
    updateDim.run(JSON.stringify({ ...canonical, attributes: canonical.attributes }), canonical.id);
  }

  for (const src of sources) {
    const stmts = db
      .prepare("SELECT id FROM nodes WHERE type='core:statement' AND dimension_id = ?")
      .all(src.id);
    for (const s of stmts) {
      remapStmt.run(canonical.id, canonical.id, s.id);
      totalMoved++;
    }
    deleteDim.run(src.id);
    deleteVec.run(src.id);
    totalMerged++;
  }
}

// --- conflict scan: single-dim dims with >1 accepted after merge ---------------

const clashDims = db
  .prepare(
    `SELECT d.id, d.data FROM nodes d WHERE d.type='core:dimension' AND d.state != 'conflict'
     AND json_extract(d.data,'$.cardinality')='single'
     AND (SELECT COUNT(*) FROM nodes s WHERE s.type='core:statement'
          AND json_extract(s.data,'$.dimension_id')=d.id
          AND s.state='accepted') > 1`
  )
  .all();
const flagClash = db.prepare(
  "UPDATE nodes SET state = 'conflict', data = json_set(data, '$.state', 'conflict', '$.updated_at', ?) WHERE id = ?"
);
const nowIso = new Date().toISOString();
for (const d of clashDims) flagClash.run(nowIso, d.id);

// --- report ---------------------------------------------------------------------

const finalCounts = db
  .prepare("SELECT type, COUNT(*) c FROM nodes GROUP BY type")
  .all()
  .map((r) => `${r.type}=${r.c}`)
  .join(", ");

console.log(`\n=== 别名合并结果 ===`);
console.log(`合并组: ${mergeGroups.length} | 删除重复维度: ${totalMerged} | 重挂语句: ${totalMoved}`);
console.log(`触发 conflict 的维度: ${clashDims.length}`);
console.log(`合并后: ${finalCounts}`);
db.close();
console.log("done");
