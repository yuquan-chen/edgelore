// edgelore · LongMemEval 总控：并行启动 4 个摄入 worker，合并渲染一个大进度条。
//
// 用法（在项目根目录）：
//   node benchmark/longmemeval/run-all.mjs
//
// 会实时显示：总进度条 / 已摄入会话数 / 已存记忆条数 / 预计剩余时间。
// 中断后重跑同一命令即可断点续跑（已完成的会话自动跳过）。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const sessionIds = new Set();
for (const q of dataset) for (const sid of q.haystack_session_ids) sessionIds.add(sid);
const TOTAL = sessionIds.size; // 940 个唯一会话（不是 500 道题）

// 并行启动 4 个 worker（各自分库 + 各自 checkpoint）
const workers = [0, 1, 2, 3].map((i) =>
  spawn(
    process.execPath,
    [join(here, "ingest.mjs"), "--shard", `${i}/4`, "--db", join(dataDir, `memory-shard-${i}.db`)],
    { stdio: ["ignore", "inherit", "inherit"] }, // worker 的 [warn] 直接透传显示
  ),
);

// 读取某个 shard 的 checkpoint：兼容旧数组格式和新 {done, facts} 格式
function readShard(i) {
  const p = join(dataDir, `ingest-checkpoint-${i}-4.json`);
  if (!existsSync(p)) return { done: 0, facts: 0 };
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(raw) ? { done: raw.length, facts: 0 } : { done: raw.done.length, facts: raw.facts ?? 0 };
}

function render(t0) {
  let done = 0;
  let facts = 0;
  const perShard = [];
  for (let i = 0; i < 4; i++) {
    const s = readShard(i);
    done += s.done;
    facts += s.facts;
    perShard.push(`${s.done}`);
  }
  const width = 30;
  const filled = Math.max(0, Math.min(width, Math.round((width * done) / TOTAL)));
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  const elapsed = (Date.now() - t0) / 1000;
  const rate = done / elapsed; // 会话/秒
  const etaSec = done > 0 ? ((TOTAL - done) / rate) : 0;
  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m${Math.round(s % 60)}s`;
  };
  process.stdout.write(
    `\r[${bar}] ${((done / TOTAL) * 100).toFixed(1)}%  ` +
      `${done}/${TOTAL} 会话 | ${facts} 条记忆 | ` +
      `分片 [${perShard.join(",")}] | ` +
      `已用 ${fmt(elapsed)} 剩余约 ${fmt(etaSec)}   `,
  );
}

const t0 = Date.now();
const timer = setInterval(() => render(t0), 1500);
render(t0);

// 全部 worker 退出 = 摄入完成
await Promise.all(workers.map((w) => new Promise((res) => w.on("exit", res))));
clearInterval(timer);
render(t0);
const s = readShard(0);
console.log(
  `\n\n全部摄入完成 ✓  分片计数 [${[0, 1, 2, 3].map((i) => readShard(i).done).join(", ")}]  ` +
    `总记忆 ${[0, 1, 2, 3].reduce((a, i) => a + readShard(i).facts, 0)} 条\n` +
    `下一步：node benchmark/longmemeval/answer.mjs`,
);
