// EdgeLore · LongMemEval-S scoped recall and answer probe.
//
// Reads an existing S ingestion run. Recall is always executed and is free
// apart from the configured query embedding. `--answer` adds one chat call
// per selected question. Results stay inside the run directory.

//   node benchmark/longmemeval/evaluate-s.mjs --run-dir <dir>
//   node benchmark/longmemeval/evaluate-s.mjs --run-dir <dir> --answer

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SqliteGraph,
  SqliteVectorStore,
  buildAskPrompt,
  embeddingDriver,
  recall,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";
import { loadQuestions } from "./dataset.mjs";

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const runDirArg = argValue("--run-dir");
if (!runDirArg) throw new Error("--run-dir is required");

const runDir = resolve(runDirArg);
const selectionPath = join(runDir, "selection.json");
const databasePath = join(runDir, "memory.db");
if (!existsSync(selectionPath) || !existsSync(databasePath)) {
  throw new Error(`run is missing selection.json or memory.db: ${runDir}`);
}

const withAnswer = args.includes("--answer");
const requestedQuestionId = argValue("--question-id");
const { cfg } = boot();
const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
const selectedIds = requestedQuestionId
  ? selection.selected_ids.filter((id) => id === requestedQuestionId)
  : selection.selected_ids;
if (selectedIds.length === 0)
  throw new Error(`question is not part of this run: ${requestedQuestionId}`);

const questions = await loadQuestions(selection.dataset, selectedIds);
const graph = new SqliteGraph(databasePath);
const retrieval = cfg.embedding
  ? {
      ...cfg.retrieval,
      k: Number(argValue("--k") ?? cfg.retrieval.k ?? 10),
      embedder: embeddingDriver(cfg),
      vectors: new SqliteVectorStore(graph),
    }
  : { ...cfg.retrieval, mode: "lexical" };

const forcedThinking = /glm-5\.3/i.test(cfg.llm?.model ?? "");
const answerDriver = withAnswer
  ? requireChat(cfg, {
      maxTokens: 2_000,
      timeoutMs: 120_000,
      maxRetries: 0,
      extraBody: forcedThinking ? { reasoning_effort: "low" } : { thinking: { type: "disabled" } },
    })
  : undefined;

function isoDay(raw) {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function scopeFor(questionId) {
  return {
    owner_id: "actor:longmemeval-s",
    project_id: `question:${questionId}`,
    phase_id: "history",
  };
}

function normalizeSourceId(questionId, sourceId) {
  const prefix = `longmemeval-s:${questionId}:`;
  return sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
}

const results = [];
for (const question of questions) {
  const scope = scopeFor(question.question_id);
  const sessionIds = question.haystack_session_ids.map(
    (sessionId) => `longmemeval-s:${question.question_id}:${sessionId}`,
  );
  const capsule = await recall(graph, question.question, {
    scope: { ...scope, sessionIds },
    retrieval: {
      ...retrieval,
      dateTo: isoDay(question.question_date),
    },
  });

  const recalledSources = new Set([
    ...capsule.evidence.map((item) => normalizeSourceId(question.question_id, item.sourceId)),
    ...capsule.claims.flatMap((item) =>
      item.sourceRefs.map((sourceId) => normalizeSourceId(question.question_id, sourceId)),
    ),
  ]);
  const expectedSources = question.answer_session_ids ?? [];
  const matchedExpectedSources = expectedSources.filter((sourceId) =>
    recalledSources.has(sourceId),
  );
  const answerTurns = new Map();
  for (const sourceId of expectedSources) {
    const sessionIndex = question.haystack_session_ids.indexOf(sourceId);
    const turns = question.haystack_sessions[sessionIndex] ?? [];
    answerTurns.set(
      sourceId,
      new Set(turns.flatMap((turn, turnIndex) => (turn.has_answer ? [turnIndex] : []))),
    );
  }
  const exactEvidenceSources = new Set(
    capsule.evidence.flatMap((item) => {
      const sourceId = normalizeSourceId(question.question_id, item.sourceId);
      return item.turnIndex !== undefined && answerTurns.get(sourceId)?.has(item.turnIndex)
        ? [sourceId]
        : [];
    }),
  );
  const answer = answerDriver
    ? (
        await answerDriver.complete(
          buildAskPrompt(question.question, capsule.context, isoDay(question.question_date)),
        )
      ).trim()
    : undefined;

  results.push({
    question_id: question.question_id,
    question_type: question.question_type,
    question: question.question,
    expected_answer: question.answer,
    expected_source_count: expectedSources.length,
    matched_expected_sources: matchedExpectedSources,
    source_recall:
      expectedSources.length === 0 ? null : matchedExpectedSources.length / expectedSources.length,
    matched_answer_turn_sources: expectedSources.filter((sourceId) =>
      exactEvidenceSources.has(sourceId),
    ),
    answer_turn_recall:
      expectedSources.length === 0 ? null : exactEvidenceSources.size / expectedSources.length,
    capsule: {
      claims: capsule.claims,
      slots: capsule.slots,
      evidence: capsule.evidence,
      context: capsule.context,
    },
    ...(answer !== undefined ? { answer } : {}),
  });
  console.log(
    `${question.question_id}: sources ${matchedExpectedSources.length}/${expectedSources.length}` +
      (answer !== undefined ? `; answer ${JSON.stringify(answer)}` : ""),
  );
}

const output = {
  run_dir: runDir,
  database: databasePath,
  model: withAnswer ? (cfg.llm?.model ?? null) : null,
  embedding_model: cfg.embedding?.model ?? null,
  answered: withAnswer,
  usage: usageTotals(),
  evaluated_at: new Date().toISOString(),
  results,
};
const outputPath = join(runDir, withAnswer ? "answer-probe.json" : "recall-probe.json");
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`result -> ${outputPath}`);
