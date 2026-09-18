// edgelore · LongMemEval — coverage verification (the ONE true ledger).
//
// Instead of trusting any checkpoint file, this script checks ground truth:
// which of the dataset's 940 unique session ids actually have statements in
// the store. Prints covered / missing, with the missing ids listed so a
// targeted completion run can fill exactly the gaps.
//
// Usage: node benchmark/longmemeval/coverage.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteGraph } from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const sessionIds = new Set();
for (const q of dataset) for (const sid of q.haystack_session_ids) sessionIds.add(sid);

const graph = new SqliteGraph(join(dataDir, "memory.db"));
const covered = new Set();
for (const s of graph.queryNodes({ type: "core:statement" })) {
  for (const ref of s.source_refs ?? []) covered.add(ref);
}

const missing = [...sessionIds].filter((sid) => !covered.has(sid));
console.log(`数据集唯一会话: ${sessionIds.size}`);
console.log(`已覆盖: ${covered.size & sessionIds.size ? [...covered].filter((s) => sessionIds.has(s)).length : 0}`);
console.log(`缺失: ${missing.length}`);
if (missing.length > 0 && missing.length <= 50) {
  console.log("缺失会话 ID:");
  for (const sid of missing) console.log("  " + sid);
} else if (missing.length > 50) {
  console.log("缺失会话 ID（前 20 个）:");
  for (const sid of missing.slice(0, 20)) console.log("  " + sid);
}
console.log(`\n覆盖率: ${(((sessionIds.size - missing.length) / sessionIds.size) * 100).toFixed(1)}%`);
writeFileSync(join(dataDir, "missing-sessions.json"), JSON.stringify(missing));
console.log("saved: data/missing-sessions.json");
