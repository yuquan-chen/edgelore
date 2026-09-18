// 合并所有摄入账本（主账本 + 4 个分片账本）的进度为一个总账本。
// 用法：node benchmark/longmemeval/merge-checkpoints.mjs
// 先确认没有正在运行的 ingest 进程，再执行。

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");

const files = [
  join(dataDir, "ingest-checkpoint-main.json"),
  ...[0, 1, 2, 3].map((i) => join(dataDir, `ingest-checkpoint-${i}-4.json`)),
];

const done = new Set();
for (const p of files) {
  if (!existsSync(p)) continue;
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    const ids = Array.isArray(c) ? c : c.done;
    for (const sid of ids) done.add(sid);
    console.log(`read ${ids.length} from ${p.split("\\").pop()}`);
  } catch {}
}

const out = join(dataDir, "ingest-checkpoint-main.json");
writeFileSync(out, JSON.stringify([...done]));
console.log(`\n合并完成: 总账本现有 ${done.size} 个已完成会话`);
