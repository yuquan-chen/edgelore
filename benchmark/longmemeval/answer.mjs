// edgelore · LongMemEval answering — one hypothesis per question.
//
// For each dataset question: retrieve from the shared memory store and answer
// strictly grounded in it (abstains with 不知道 when insufficient — the
// benchmark's abstention questions test exactly this). Resumable: already-
// answered question_ids in the JSONL are skipped.
//
// Usage: node benchmark/longmemeval/answer.mjs [--limit N] [--k 10]

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  OpenAiCompatDriver,
  OpenAiCompatEmbeddingDriver,
  SqliteVectorStore,
  answerQuestion,
} from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv(join(here, "..", "..", ".env.local"));
const BASE = env.OPENAI_BASE_URL ?? "https://api.dogrouter.ai/v1";
const KEY = env.OPENAI_API_KEY;
const MODEL = env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";
if (!KEY || !MODEL) {
  console.error("missing OPENAI_API_KEY / EDGELORE_MODEL");
  process.exit(1);
}

const dataDir = join(here, "data");
const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const graph = new SqliteGraph(join(dataDir, "memory.db"));
const driver = new OpenAiCompatDriver({ baseUrl: BASE, apiKey: KEY, model: MODEL, maxTokens: 16000 });

const retrieval = env.EDGELORE_EMBEDDING_MODEL
  ? {
      embedder: new OpenAiCompatEmbeddingDriver({
        baseUrl: env.OPENAI_EMBEDDING_BASE_URL ?? BASE,
        apiKey: env.OPENAI_EMBEDDING_API_KEY ?? KEY,
        model: env.EDGELORE_EMBEDDING_MODEL,
        dimensions: Number(env.EDGELORE_EMBEDDING_DIMENSIONS ?? 1024),
      }),
      vectors: new SqliteVectorStore(graph),
    }
  : undefined;

// resume support
const hypPath = join(dataDir, "hypotheses.jsonl");
const answered = new Set();
if (existsSync(hypPath)) {
  for (const line of readFileSync(hypPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { answered.add(JSON.parse(line).question_id); } catch {}
  }
}

const args = process.argv;
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 ? Number(args[i + 1]) : fallback;
}
const k = argVal("--k", 10);
const limitIdx = args.indexOf("--limit");
const maxQ = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
const randomSample = args.includes("--random");

// --random 时打乱题目顺序（均匀覆盖五种能力）
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const questions = randomSample ? shuffle(dataset).slice(0, maxQ) : dataset;

// --- tqdm-style progress bar ---
const t0 = Date.now();
function bar(current, total, extra = "") {
  const w = 25;
  const filled = Math.min(w, Math.round(w * current / total));
  const bar = "█".repeat(filled) + "░".repeat(w - filled);
  const pct = ((current / total) * 100).toFixed(1);
  const elapsed = (Date.now() - t0) / 1000;
  const rate = current > 0 ? current / elapsed : 0;
  const eta = current > 0 ? Math.round((total - current) / rate) : 0;
  const etaStr = eta > 60 ? `${Math.floor(eta / 60)}m${eta % 60}s` : `${eta}s`;
  const elStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s` : `${Math.round(elapsed)}s`;
  process.stdout.write(`\r${bar} ${pct}% | ${current}/${total} | ${rate.toFixed(1)} q/s | 已用 ${elStr} 剩余~${etaStr} | ${extra}`);
}

// --- main loop ---
const todo = (randomSample ? shuffle(dataset).slice(0, maxQ) : dataset).filter((q) => !answered.has(q.question_id));
console.log(`待回答: ${todo.length}/${dataset.length} 题 | 模型: ${MODEL}\n`);

let done = 0;
let abstain = 0;
let errors = 0;
for (const q of todo) {
  if (done >= maxQ) break;
  try {
    const r = await answerQuestion(graph, q.question, driver, { retrieval, k });
    appendFileSync(hypPath, JSON.stringify({ question_id: q.question_id, hypothesis: r.answer }) + "\n");
    done += 1;
    if (r.answer === "不知道") abstain += 1;
  } catch (err) {
    errors += 1;
    process.stdout.write(`\n[warn] ${q.question_id}: ${err.message.slice(0, 80)}\n`);
  }
  bar(done + errors, Math.min(todo.length + errors, 500), `${abstain} 拒答 ${errors} 错误`);
}

console.log(`\n\n完成: ${done} 回答 | ${abstain} 拒答 | ${errors} 错误`);
