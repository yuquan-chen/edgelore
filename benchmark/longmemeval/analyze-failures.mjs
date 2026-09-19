// edgelore · LongMemEval — temporal reasoning failure deep-dive.
//
// For every temporal-reasoning question: show the question, gold answer,
// our hypothesis, what memories existed, and WHY we might have failed.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteGraph } from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const hyps = new Map(
  readFileSync(join(dataDir, "hypotheses.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
    const h = JSON.parse(l);
    return [h.question_id, h.hypothesis];
  })
);
const verdicts = JSON.parse(readFileSync(join(dataDir, "judge-verdicts.json"), "utf8"));
const graph = new SqliteGraph(join(dataDir, "memory.db"));

// 只看时间推理题
const temporal = dataset.filter((q) => q.question_type === "temporal-reasoning");
console.log(`时间推理题总数: ${temporal.length}\n`);

let correct = 0, wrong = 0, abstain = 0, noHyp = 0;
const failures = [];

for (const q of temporal) {
  const hyp = hyps.get(q.question_id);
  const verdict = verdicts[q.question_id];

  if (hyp === undefined) { noHyp++; continue; }
  if (hyp === "不知道") { abstain++; continue; }
  if (verdict === 1) { correct++; continue; }
  wrong++;

  // 找记忆库里跟这道题最相关的记忆（用金证据会话的 source_refs 反查）
  const evidenceSids = new Set(q.haystack_session_ids);
  const evidenceStmts = [];
  for (const s of graph.queryNodes({ type: "core:statement" })) {
    for (const ref of s.source_refs ?? []) {
      if (evidenceSids.has(ref)) {
        evidenceStmts.push({ value: s.value, createdAt: s.created_at?.slice(0, 10), dim: s.dimension_id });
        break;
      }
    }
  }

  failures.push({
    question_id: q.question_id,
    question: q.question.slice(0, 100),
    gold: (typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer)).slice(0, 100),
    hyp: (hyp ?? "").slice(0, 100),
    evidenceStmts: evidenceStmts.slice(0, 5),
    evidenceCount: evidenceStmts.length,
  });
}

console.log(`✓ 正确: ${correct}  ✗ 错误: ${wrong}  🚫 拒答: ${abstain}  无回答: ${noHyp}\n`);

console.log("===== 错误样本（前 15 个）=====\n");
for (const f of failures.slice(0, 15)) {
  console.log(`Q: ${f.question}`);
  console.log(`   金标准: ${f.gold}`);
  console.log(`   我们答: ${f.hyp}`);
  console.log(`   证据会话中可用记忆 (${f.evidenceCount} 条):`);
  for (const e of f.evidenceStmts.slice(0, 3)) {
    console.log(`     → ${JSON.stringify(e.value)} [${e.createdAt}]`);
  }
  console.log();
}

// 按错误模式分类
console.log("===== 初步分类 =====");
const abstainInWrong = failures.filter((f) => f.hyp === "不知道").length;
const emptyHyp = failures.filter((f) => !f.hyp || f.hyp.trim() === "").length;
console.log(`错误总数: ${failures.length}`);
console.log(`其中拒答但被判错: ${abstainInWrong}`);
console.log(`其中空回答: ${emptyHyp}`);
console.log(`其中答了但答错: ${failures.length - abstainInWrong - emptyHyp}`);
