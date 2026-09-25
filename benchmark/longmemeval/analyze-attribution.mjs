// Produce a no-answer-model audit bundle for failed LongMemEval questions.
// It re-runs only retrieval, then aligns the returned context with the
// benchmark's answer-bearing source turns and the Claims extracted from them.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../lib/boot.mjs";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  retrievalContext,
  statementText,
} from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const tag = process.argv.includes("--tag")
  ? process.argv[process.argv.indexOf("--tag") + 1]
  : "v7-episode-graph-read-20260923";
const verdictTag = process.argv.includes("--verdict-tag")
  ? process.argv[process.argv.indexOf("--verdict-tag") + 1]
  : tag;
const dbPath = resolve(
  process.argv.includes("--db")
    ? process.argv[process.argv.indexOf("--db") + 1]
    : join(dataDir, "runs", "v7-slot-episode-onepass-20260923", "memory.db"),
);
const lexicalOnly = process.argv.includes("--lexical");

const { cfg } = boot();
if (!lexicalOnly && !cfg.embedding) {
  throw new Error("embedding config is required to reproduce hybrid retrieval");
}

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const hypotheses = new Map(
  readFileSync(join(dataDir, `hypotheses-${tag}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return [row.question_id, row.hypothesis];
    }),
);
const verdicts = JSON.parse(
  readFileSync(join(dataDir, `judge-verdicts-${verdictTag}.json`), "utf8"),
);

function verdictFor(questionId, hypothesis) {
  const digest = createHash("sha256").update(hypothesis).digest("hex").slice(0, 12);
  return verdicts[`${questionId}:${digest}`];
}

function isoDay(raw) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(raw ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

// The answer run used an intent router to widen set/aggregation questions to
// k=30. This deterministic approximation avoids another chat-model call while
// reproducing the relevant retrieval budget for failure analysis.
function retrievalK(question) {
  return /\bhow many\b|\btotal\b|\border of\b|\bmost money\b|\bhigher percentage\b/i.test(question)
    ? 30
    : 10;
}

function answerTurns(question) {
  const wanted = new Set(question.answer_session_ids ?? []);
  const turns = [];
  question.haystack_session_ids.forEach((sessionId, sessionIndex) => {
    if (!wanted.has(sessionId)) return;
    const session = question.haystack_sessions[sessionIndex] ?? [];
    session.forEach((turn, turnIndex) => {
      if (turn.has_answer) {
        turns.push({ sessionId, turnIndex, role: turn.role, content: turn.content });
      }
    });
  });
  return turns;
}

const graph = new SqliteGraph(dbPath);
const vectors = new SqliteVectorStore(graph);
const embedder = lexicalOnly ? undefined : embeddingDriver(cfg);
const allClaims = graph.queryNodes({ type: "core:statement" });
const failures = dataset.filter((question) => {
  const hypothesis = hypotheses.get(question.question_id);
  return hypothesis && verdictFor(question.question_id, hypothesis) === 0;
});

const rows = [];
for (let index = 0; index < failures.length; index += 1) {
  const question = failures[index];
  const expectedSources = new Set(question.answer_session_ids ?? []);
  const sourceClaims = allClaims
    .filter((claim) => (claim.source_refs ?? []).some((sourceRef) => expectedSources.has(sourceRef)))
    .map((claim) => ({
      id: claim.id,
      dimensionId: claim.dimension_id,
      text: statementText(graph, claim),
      value: claim.value,
      state: claim.state,
      saidBy: claim.saidBy,
      createdAt: claim.created_at,
      sourceRefs: claim.source_refs,
    }));
  const k = retrievalK(question.question);
  const recalled = await retrievalContext(graph, question.question, {
    ...cfg.retrieval,
    ...(lexicalOnly ? { mode: "lexical" } : {}),
    k,
    dateTo: isoDay(question.question_date),
    scopeSessionIds: question.haystack_session_ids,
    embedder,
    vectors,
  });
  rows.push({
    questionId: question.question_id,
    type: question.question_id.endsWith("_abs") ? "abstention" : question.question_type,
    question: question.question,
    expectedAnswer: question.answer,
    hypothesis: hypotheses.get(question.question_id),
    questionDate: question.question_date,
    retrievalK: k,
    answerSessionIds: question.answer_session_ids,
    answerTurns: answerTurns(question),
    sourceClaims,
    recalledLines: recalled.lines,
    similarDimensions: recalled.similarDimensions,
  });
  process.stdout.write(`\rretrieval audit ${index + 1}/${failures.length}`);
}

const outputPath = join(dataDir, `failure-attribution-input-${tag}.json`);
writeFileSync(
  outputPath,
  JSON.stringify(
    {
      tag,
      verdictTag,
      database: dbPath,
      generatedAt: new Date().toISOString(),
      note: lexicalOnly
        ? "No model calls. Lexical-only diagnostic because the configured embedding API had no quota."
        : "No answer-model calls. Set-question k is reproduced with a deterministic heuristic.",
      failures: rows,
    },
    null,
    2,
  ),
);
graph.close();
console.log(`\n${rows.length} failures -> ${outputPath}`);

