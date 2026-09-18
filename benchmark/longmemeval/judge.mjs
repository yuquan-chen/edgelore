// edgelore · LongMemEval judging — faithful node port of the official
// evaluate_qa.py (xiaowu0162/LongMemEval): task-specific leniency templates,
// binary yes/no LLM judge, temperature 0, max_tokens 10.
//
// Judge model: any OpenAI-compatible chat endpoint. The official model_zoo is
// gpt-4o / gpt-4o-mini / llama-3.1-70b — our relay serves none of those, so
// set EDGELORE_JUDGE_MODEL (the strongest model available) and document it:
// judge quality bounds the measured score's credibility.
//
// Usage: node benchmark/longmemeval/judge.mjs [--limit N]

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAiCompatDriver } from "../../dist/src/index.js";

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
const JUDGE_MODEL = env.EDGELORE_JUDGE_MODEL ?? env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";

const dataDir = join(here, "data");
const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const hypPath = join(dataDir, "hypotheses.jsonl");
if (!existsSync(hypPath)) {
  console.error("no hypotheses.jsonl — run answer.mjs first");
  process.exit(1);
}
const hyps = readFileSync(hypPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ref = new Map(dataset.map((q) => [q.question_id, q]));

const judge = new OpenAiCompatDriver({ baseUrl: BASE, apiKey: KEY, model: JUDGE_MODEL, maxTokens: 10, maxRetries: 2 });

// --- official templates (verbatim from evaluate_qa.py) ------------------------

const T_COMMON =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
const T_TEMPORAL =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.";
const T_KNOWLEDGE_UPDATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.";
const T_PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.";
const T_ABSTENTION =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.";
const TAIL = "\n\nIs the model response correct? Answer yes or no only.";

function anscheckPrompt(task, question, answer, response, abstention) {
  let template;
  if (!abstention) {
    if (task === "temporal-reasoning") template = T_TEMPORAL;
    else if (task === "knowledge-update") template = T_KNOWLEDGE_UPDATE;
    else if (task === "single-session-preference") template = T_PREFERENCE;
    else if (["single-session-user", "single-session-assistant", "multi-session"].includes(task)) template = T_COMMON;
    else throw new Error(`unknown task: ${task}`);
    return `${template}\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}${TAIL}`;
  }
  return `${T_ABSTENTION}\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
}

// --- resumable verdicts --------------------------------------------------------

const cachePath = join(dataDir, "judge-verdicts.json");
const verdicts = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

const args = process.argv;
const limitIdx = args.indexOf("--limit");
const maxN = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;

let judged = 0;
for (const h of hyps) {
  if (judged >= maxN) break;
  if (verdicts[h.question_id] !== undefined) continue;
  const q = ref.get(h.question_id);
  if (!q) continue;
  const abstention = h.question_id.endsWith("_abs");
  const prompt = anscheckPrompt(q.question_type, q.question, q.answer, h.hypothesis, abstention);
  try {
    const resp = (await judge.complete(prompt)).trim().toLowerCase();
    verdicts[h.question_id] = resp.includes("yes") ? 1 : 0;
    judged += 1;
    if (judged % 25 === 0) {
      writeFileSync(cachePath, JSON.stringify(verdicts));
      console.log(`progress: ${judged} judged`);
    }
  } catch (err) {
    console.log(`[warn] judge ${h.question_id}: ${err.message} — rerun to retry`);
  }
}
writeFileSync(cachePath, JSON.stringify(verdicts));

// --- report ---------------------------------------------------------------------

const byType = {};
let total = 0;
let correct = 0;
for (const q of dataset) {
  const v = verdicts[q.question_id];
  if (v === undefined) continue;
  total += 1;
  correct += v;
  const t = q.question_id.endsWith("_abs") ? "abstention" : q.question_type;
  byType[t] = byType[t] ?? { n: 0, correct: 0 };
  byType[t].n += 1;
  byType[t].correct += v;
}
console.log(`\njudge model: ${JUDGE_MODEL}`);
console.log(`OVERALL: ${((correct / total) * 100).toFixed(1)}%  (${correct}/${total})`);
for (const [t, s] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${t}: ${((s.correct / s.n) * 100).toFixed(1)}%  (${s.correct}/${s.n})`);
}
writeFileSync(
  join(dataDir, "judge-result.json"),
  JSON.stringify({ judge_model: JUDGE_MODEL, overall: { correct, total }, by_type: byType }, null, 2),
);
console.log("saved: data/judge-result.json");
