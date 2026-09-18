// edgelore · LongMemEval answering — one hypothesis per question.
//
// For each dataset question: retrieve from the shared memory store and answer
// strictly grounded in it (abstains with 不知道 when insufficient — the
// benchmark's abstention questions test exactly this). Resumable: already-
// answered question_ids in the JSONL are skipped.
//
// Usage: node benchmark/longmemeval/answer.mjs [--limit N] [--k 10]

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
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
const BASE = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const KEY = env.OPENAI_API_KEY;
const MODEL = env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";
if (!KEY || !MODEL) {
  console.error("missing OPENAI_API_KEY / EDGELORE_MODEL");
  process.exit(1);
}

const dataDir = join(here, "data");
const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const graph = new SqliteGraph(join(dataDir, "memory.db"));
const driver = new OpenAiCompatDriver({ baseUrl: BASE, apiKey: KEY, model: MODEL });

const retrieval = env.EDGELORE_EMBEDDING_MODEL
  ? {
      embedder: new OpenAiCompatEmbeddingDriver({
        baseUrl: env.OPENAI_EMBEDDING_BASE_URL ?? BASE,
        apiKey: KEY,
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
    try {
      answered.add(JSON.parse(line).question_id);
    } catch {}
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

let done = 0;
const t0 = Date.now();
for (const q of dataset) {
  if (answered.has(q.question_id)) continue;
  if (done >= maxQ) break;
  try {
    const r = await answerQuestion(graph, q.question, driver, { retrieval, k });
    appendFileSync(hypPath, JSON.stringify({ question_id: q.question_id, hypothesis: r.answer }) + "\n");
    done += 1;
    if (done % 20 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`progress: ${done} answered, ${rate.toFixed(2)} q/s (abstentions included)`);
    }
  } catch (err) {
    console.log(`[warn] question ${q.question_id}: ${err.message} — rerun to retry`);
  }
}
console.log(`done: ${done} answers this run; total file lines: ${answered.size + done}`);
writeFileSync(join(dataDir, "answer-done"), "ok");
