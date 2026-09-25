// Draft stage-by-stage failure labels from the retrieval audit bundle.
// This is an analysis helper, not a benchmark judge: its output must be
// reviewed before architectural conclusions are accepted.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const tag = process.argv.includes("--tag")
  ? process.argv[process.argv.indexOf("--tag") + 1]
  : "v7-episode-graph-read-20260923";
const inputPath = join(dataDir, `failure-attribution-input-${tag}.json`);
const outputPath = join(dataDir, `failure-attribution-draft-${tag}.json`);
const audit = JSON.parse(readFileSync(inputPath, "utf8"));
const { cfg } = boot();
const apiKey = cfg.embedding?.apiKey;
const baseUrl = cfg.embedding?.baseUrl;
if (!apiKey || !baseUrl) throw new Error("configured OpenAI-compatible credential required");

function clipped(value, max) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function packet(row) {
  return {
    questionId: row.questionId,
    type: row.type,
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    wrongAnswer: clipped(row.hypothesis, 1_800),
    answerBearingRawTurns: row.answerTurns.map((turn) => ({
      source: `${turn.sessionId}#${turn.turnIndex}`,
      role: turn.role,
      content: clipped(turn.content, 2_400),
    })),
    claimsExtractedFromAnswerSessions: row.sourceClaims.map((claim) => ({
      state: claim.state,
      saidBy: claim.saidBy,
      text: clipped(claim.text, 700),
    })),
    contextActuallyRecalled: row.recalledLines.map((line) => clipped(line, 1_800)),
  };
}

const rubric = `
You are auditing a staged memory system. Every supplied item was judged wrong.
For each item decide where the information pipeline failed, using ONLY the supplied material.

Stages:
1 source: answer-bearing raw turns contain sufficient evidence for the expected answer.
2 ingestion: extracted Claims preserve all facts required to answer.
3 recall: the context actually recalled contains sufficient evidence to answer.
4 answer: the final agent must reason only from recalled context.

For abstention items, the expected behavior is to say information is insufficient. Do not call
source/ingestion missing a failure. Determine whether retrieval supplied misleading but unrelated
facts, or the answer agent made an unsupported join/inference. If the wrong answer is actually
semantically acceptable for the question, use judge_or_dataset.

Return a JSON object with key "items". For every input item return exactly:
{
  "questionId": string,
  "sourceSufficient": boolean,
  "claimsSufficient": boolean,
  "recallSufficient": boolean,
  "primaryCause": one of [
    "ingestion_loss",
    "retrieval_miss",
    "retrieval_noise_or_state",
    "answer_reasoning",
    "abstention_failure",
    "judge_or_dataset"
  ],
  "secondaryCauses": array using the same labels,
  "explanationZh": one short, concrete Chinese sentence naming the missing or misused fact,
  "confidence": number from 0 to 1
}

Use ingestion_loss when required facts exist in raw turns but not Claims. Use retrieval_miss when
required facts exist in Claims/raw evidence but are absent from recalled context. Use
answer_reasoning when recalled context itself is sufficient but the answer calculates, compares,
deduplicates, interprets time/state, or follows instructions incorrectly. Use
retrieval_noise_or_state when recalled context over-surfaces stale, assistant-authored, unrelated,
or duplicated material that causes the error. Multiple stages may fail; primaryCause should be the
earliest material cause, with later effects in secondaryCauses. Do not infer unseen context.
`;

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

async function classify(batch) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      temperature: 0,
      max_tokens: 16_000,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: rubric },
        { role: "user", content: JSON.stringify(batch.map(packet)) },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`classification API ${response.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("classification API returned no content");
  return { items: parseJson(content).items, usage: json.usage };
}

const labels = [];
const usages = [];
const batchSize = 4;
for (let start = 0; start < audit.failures.length; start += batchSize) {
  const batch = audit.failures.slice(start, start + batchSize);
  const result = await classify(batch);
  labels.push(...result.items);
  usages.push(result.usage);
  writeFileSync(
    outputPath,
    JSON.stringify({ tag, generatedAt: new Date().toISOString(), labels, usages }, null, 2),
  );
  process.stdout.write(`\rclassified ${labels.length}/${audit.failures.length}`);
}
console.log(`\n${labels.length} draft labels -> ${outputPath}`);

