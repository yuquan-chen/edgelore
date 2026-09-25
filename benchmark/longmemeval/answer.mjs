// edgelore · LongMemEval answering — one hypothesis per question.
//
// For each dataset question: retrieve from the shared memory store and answer
// strictly grounded in it (abstains with 不知道 when insufficient — the
// benchmark's abstention questions test exactly this). Resumable: already-
// answered question_ids in the tagged JSONL are skipped.
//
// Sampling is SEEDED (mulberry32): the same --seed picks the same subset, so
// a before/after comparison compares the same exam. The old Math.random
// sampling made every run a different exam — historical cross-run numbers
// were not paired. `--random` is kept as a deprecated alias.
//
// Each question's `question_date` is passed to the answering layer as "now"
// (pure string transform — never through new Date(), whose UTC conversion
// shifts pre-08:00 timestamps a day back on UTC+8 machines).
//
// Usage:
//   node benchmark/longmemeval/answer.mjs --db data/runs/<run>/memory.db --tag <name>
//   node benchmark/longmemeval/answer.mjs --sample 100 --seed 20260919 --tag s1
//   node benchmark/longmemeval/answer.mjs --ids data/stage1-ids.txt --tag s1
//   node benchmark/longmemeval/answer.mjs --limit 50              (sequential head)
//   node benchmark/longmemeval/answer.mjs --ids ... --dry-run     (zero API calls)
//
// --tag NAME writes hypotheses-NAME.jsonl + answer-meta-NAME.json (and
// resumes from the tagged JSONL); without it the legacy filenames are used.

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, requireChat } from "../lib/boot.mjs";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  decisionDriver,
  answerQuestion,
} from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const { cfg } = boot();

// --- args ----------------------------------------------------------------------

const args = process.argv;
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const k = argVal("--k") ? Number(argVal("--k")) : Number(process.env.EDGELORE_RETRIEVAL_K) || 10;
const seed = Number(argVal("--seed") ?? 20260919);
const idsArg = argVal("--ids");
const tag = argVal("--tag");
const dbPath = resolve(argVal("--db") ?? join(dataDir, "memory.db"));
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const maxQ = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
const legacyRandom = args.includes("--random");
const sampleArg = argVal("--sample");
const sampleSize = sampleArg !== undefined ? Number(sampleArg) : legacyRandom ? maxQ : undefined;
if (legacyRandom) {
  console.warn(
    "[warn] --random is deprecated (it was unseeded — every run a different exam); use --sample N --seed S",
  );
}

// --- subset selection: --ids wins, then --sample (seeded), else sequential --limit

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));

/** "2023/04/10 (Mon) 23:07" -> "2023-04-10". Pure string transform on purpose. */
function isoDay(raw) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(raw ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Deterministic PRNG + Fisher-Yates: same seed -> same permutation. */
function mulberry32(s) {
  let a = s >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let mode = "sequential";
let questions;
if (idsArg) {
  mode = "ids";
  const candidates = [idsArg, join(dataDir, idsArg)].filter((p) => isAbsolute(p) || existsSync(p));
  const idsPath = candidates.find((p) => existsSync(p));
  if (!idsPath) {
    console.error(`--ids file not found: ${idsArg}`);
    process.exit(1);
  }
  const byId = new Map(dataset.map((q) => [q.question_id, q]));
  const wanted = readFileSync(idsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    console.error(`--ids file has ${unknown.length} ids not in the dataset, e.g. ${unknown[0]}`);
    process.exit(1);
  }
  questions = wanted.map((id) => byId.get(id));
} else if (sampleSize !== undefined) {
  mode = "sample";
  questions = seededShuffle(dataset, mulberry32(seed)).slice(0, sampleSize);
} else {
  questions = Number.isFinite(maxQ) ? dataset.slice(0, maxQ) : dataset;
}

// --- tagged output paths ---------------------------------------------------------

const hypPath = tag ? join(dataDir, `hypotheses-${tag}.jsonl`) : join(dataDir, "hypotheses.jsonl");
const metaPath = tag ? join(dataDir, `answer-meta-${tag}.json`) : join(dataDir, "answer-meta.json");

// --- meta (written for both dry-run and real runs: the exam paper of record) -----

const meta = {
  tag: tag ?? null,
  mode,
  seed: mode === "sample" ? seed : null,
  sample_size: mode === "sample" ? sampleSize : null,
  ids_file: idsArg ?? null,
  k,
  model: cfg.llm?.model ?? null,
  base_url: cfg.llm?.baseUrl ?? null,
  embedding_model: cfg.embedding?.model ?? null,
  database: dbPath,
  dataset_size: dataset.length,
  selected_ids: questions.map((q) => q.question_id),
  started_at: new Date().toISOString(),
};

if (dryRun) {
  const byType = {};
  for (const q of questions) {
    const t = q.question_id.endsWith("_abs") ? "abstention" : q.question_type;
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log(`[dry-run] mode=${mode}${mode === "sample" ? ` seed=${seed}` : ""} 题数=${questions.length}`);
  console.log(`能力分布: ${JSON.stringify(byType)}`);
  console.log(`将写入: ${hypPath}`);
  console.log(`meta -> ${metaPath}`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  process.exit(0);
}

// --- plumbing --------------------------------------------------------------------

requireChat(cfg, { maxTokens: 16000 }); // fail fast with a readable message
const driver = requireChat(cfg, { maxTokens: 16000 });
if (!existsSync(dbPath)) {
  console.error(`memory database not found: ${dbPath}`);
  process.exit(1);
}
const graph = new SqliteGraph(dbPath);
// A9: env 旋钮（mode/k/rrfSmoothing/maxEntriesPerDimension/maxContextLines）接线——
// k 显式由 --k / EDGELORE_RETRIEVAL_K 决定（上方），其余旋钮从 config 透传
const retrieval = cfg.embedding
  ? {
      ...cfg.retrieval,
      k: undefined, // k 由 AskOptions 单独传（--k / env / 默认 10），避免 config 默认 8 混淆
      embedder: embeddingDriver(cfg),
      vectors: new SqliteVectorStore(graph),
    }
  : undefined;
// 决策层（可选）：Jev 意图路由——聚合题自动放大窗口
const decision = cfg.decision ? decisionDriver(cfg) : undefined;

// resume support
const answered = new Set();
if (existsSync(hypPath)) {
  for (const line of readFileSync(hypPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      answered.add(JSON.parse(line).question_id);
    } catch {}
  }
}
const todo = questions.filter((q) => !answered.has(q.question_id));
console.log(`database: ${dbPath}`);
console.log(`待回答: ${todo.length}/${questions.length} 题 | 模型: ${cfg.llm?.model} | mode=${mode}\n`);

// --- tqdm-style progress bar -------------------------------------------------------

const t0 = Date.now();
function bar(current, total, extra = "") {
  const w = 25;
  const filled = Math.min(w, Math.round((w * current) / Math.max(total, 1)));
  const fill = "█".repeat(filled) + "░".repeat(w - filled);
  const pct = ((current / Math.max(total, 1)) * 100).toFixed(1);
  const elapsed = (Date.now() - t0) / 1000;
  const rate = current > 0 ? current / elapsed : 0;
  const eta = current > 0 ? Math.round((total - current) / rate) : 0;
  const etaStr = eta > 60 ? `${Math.floor(eta / 60)}m${eta % 60}s` : `${eta}s`;
  const elStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s` : `${Math.round(elapsed)}s`;
  process.stdout.write(
    `\r${fill} ${pct}% | ${current}/${total} | ${rate.toFixed(1)} q/s | 已用 ${elStr} 剩余~${etaStr} | ${extra}`,
  );
}

// --- main loop ----------------------------------------------------------------------

let done = 0;
let abstain = 0;
let errors = 0;
for (const q of todo) {
  if (done >= maxQ) break;
  try {
    const r = await answerQuestion(graph, q.question, driver, {
      retrieval,
      k,
      now: isoDay(q.question_date), // honored by the answering layer (W4); ignored before
      dateTo: isoDay(q.question_date), // A4: 题目时刻之后的话不能被"回忆"起来
      scopeSessionIds: q.haystack_session_ids, // A5: 只在该题的会话集（= 该虚拟用户的账本）内检索
      decision, // Jev 决策层：聚合题自动放大窗口
    });
    appendFileSync(hypPath, JSON.stringify({ question_id: q.question_id, hypothesis: r.answer }) + "\n");
    done += 1;
    if (r.answer === "不知道") abstain += 1;
  } catch (err) {
    errors += 1;
    process.stdout.write(`\n[warn] ${q.question_id}: ${err.message.slice(0, 80)}\n`);
  }
  bar(done + errors, todo.length, `${abstain} 拒答 ${errors} 错误`);
}

meta.finished_at = new Date().toISOString();
meta.answered = done;
meta.abstained = abstain;
meta.errors = errors;
writeFileSync(metaPath, JSON.stringify(meta, null, 2));

console.log(`\n\n完成: ${done} 回答 | ${abstain} 拒答 | ${errors} 错误`);
console.log(`hypotheses -> ${hypPath}`);
console.log(`meta -> ${metaPath}`);
