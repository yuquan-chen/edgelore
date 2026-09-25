// Zero-API ablation for the bounded Entity/Relation retrieval expansion.
//
// The same database, questions, lexical retriever, scope, dates, Slot grouping,
// Episode recovery, and context budgets are used on both sides. The only
// variable is maxGraphExpansionHits: 0 (off) versus the configured/default
// bounded one-hop core:about expansion (on).

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../lib/boot.mjs";
import { SqliteGraph, retrievalContext } from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const { cfg } = boot();

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = resolve(
  option("--db", join(dataDir, "runs", "v7-slot-episode-onepass-20260923", "memory.db")),
);
const outputPath = resolve(option("--output", join(dataDir, "graph-retrieval-ablation-v7.json")));
const limit = Number(option("--limit", "0"));
const expansionHits = Number(
  option("--expansion-hits", String(cfg.retrieval.maxGraphExpansionHits ?? 4)),
);

if (!Number.isFinite(limit) || limit < 0) throw new Error("--limit must be zero or positive");
if (!Number.isFinite(expansionHits) || expansionHits <= 0) {
  throw new Error("--expansion-hits must be positive");
}

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const questions = limit > 0 ? dataset.slice(0, limit) : dataset;
const graph = new SqliteGraph(dbPath);
const allNodes = graph.queryNodes({});
const allClaims = graph.queryNodes({ type: "core:statement" });
const allDimensions = graph.queryNodes({ type: "core:dimension" });
const allEdges = graph.queryEdges({});
const aboutEdges = graph.queryEdges({ type: "core:about" });

function isoDay(raw) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(raw ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function retrievalK(question) {
  return /\bhow many\b|\btotal\b|\border of\b|\bmost money\b|\bhigher percentage\b/i.test(
    question,
  )
    ? 30
    : 10;
}

function serializedValue(value) {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

const stopWords = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "have",
  "had",
  "was",
  "were",
  "are",
  "for",
  "but",
  "not",
  "you",
  "your",
  "did",
  "when",
  "what",
  "which",
  "who",
  "how",
  "about",
  "into",
  "after",
  "before",
  "most",
  "more",
  "than",
  "then",
  "currently",
  "current",
]);

function termsOf(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g)
      ?.filter((term) => (term.length >= 3 || /^\d+$/.test(term)) && !stopWords.has(term)) ?? [],
  );
}

function answerTurns(question) {
  const wanted = new Set(question.answer_session_ids ?? []);
  const turns = [];
  question.haystack_session_ids.forEach((sessionId, sessionIndex) => {
    if (!wanted.has(sessionId)) return;
    for (const turn of question.haystack_sessions[sessionIndex] ?? []) {
      if (turn.has_answer) turns.push(turn.content);
    }
  });
  return turns;
}

function answerSignal(question, addedLines) {
  const addedTerms = termsOf(addedLines.join("\n"));
  const questionTerms = termsOf(question.question);
  const expectedTerms = termsOf(
    typeof question.answer === "string" ? question.answer : JSON.stringify(question.answer),
  );
  const evidenceTerms = termsOf(answerTurns(question).join("\n"));
  const distinctiveEvidenceTerms = [...evidenceTerms].filter((term) => !questionTerms.has(term));
  const expectedMatches = [...expectedTerms].filter((term) => addedTerms.has(term));
  const evidenceMatches = distinctiveEvidenceTerms.filter((term) => addedTerms.has(term));
  const abstention = question.question_id.endsWith("_abs");
  const expectedCoverage = expectedTerms.size === 0 ? 0 : expectedMatches.length / expectedTerms.size;
  const evidenceCoverage =
    distinctiveEvidenceTerms.length === 0
      ? 0
      : evidenceMatches.length / distinctiveEvidenceTerms.length;
  // Numeric-only answers are too collision-prone to count by themselves.
  // For ordinary answers, require most of the expected answer phrase. For
  // derived/long answers, allow several distinctive gold-turn details.
  const meaningfulExpected = [...expectedTerms].some((term) => !/^\d+$/.test(term));
  const expectedMatch =
    !abstention &&
    meaningfulExpected &&
    expectedMatches.length >= Math.min(2, expectedTerms.size) &&
    expectedCoverage >= 0.6;
  const evidenceMatch = evidenceMatches.length >= 3 && evidenceCoverage >= 0.2;
  return {
    expectedMatch,
    evidenceMatch,
    likelyUseful: expectedMatch || evidenceMatch,
    expectedCoverage,
    evidenceCoverage,
    expectedMatches,
    evidenceMatches,
  };
}

function visibleGoldClaims(lines, claims) {
  const text = lines.join("\n");
  return claims.filter((claim) => text.includes(serializedValue(claim.value))).map((claim) => claim.id);
}

function difference(left, right) {
  const rightCounts = new Map();
  for (const line of right) rightCounts.set(line, (rightCounts.get(line) ?? 0) + 1);
  return left.filter((line) => {
    const count = rightCounts.get(line) ?? 0;
    if (count === 0) return true;
    rightCounts.set(line, count - 1);
    return false;
  });
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const rows = [];
for (let index = 0; index < questions.length; index += 1) {
  const question = questions[index];
  const expectedSources = new Set(question.answer_session_ids ?? []);
  const questionDay = isoDay(question.question_date);
  const goldClaims = allClaims.filter((claim) => {
    if (!(claim.source_refs ?? []).some((sourceRef) => expectedSources.has(sourceRef))) return false;
    const claimDay = claim.created_at.slice(0, 10).replace(/\//g, "-");
    return !questionDay || claimDay <= questionDay;
  });
  const baseConfig = {
    ...cfg.retrieval,
    mode: "lexical",
    k: retrievalK(question.question),
    dateTo: questionDay,
    scopeSessionIds: question.haystack_session_ids,
  };
  const [withoutGraph, withGraph] = await Promise.all([
    retrievalContext(graph, question.question, { ...baseConfig, maxGraphExpansionHits: 0 }),
    retrievalContext(graph, question.question, {
      ...baseConfig,
      maxGraphExpansionHits: expansionHits,
    }),
  ]);
  const offGold = new Set(visibleGoldClaims(withoutGraph.lines, goldClaims));
  const onGold = new Set(visibleGoldClaims(withGraph.lines, goldClaims));
  const gainedGoldClaimIds = [...onGold].filter((id) => !offGold.has(id));
  const lostGoldClaimIds = [...offGold].filter((id) => !onGold.has(id));
  const addedLines = difference(withGraph.lines, withoutGraph.lines);
  const removedLines = difference(withoutGraph.lines, withGraph.lines);
  const signal = answerSignal(question, addedLines);
  rows.push({
    questionId: question.question_id,
    type: question.question_id.endsWith("_abs") ? "abstention" : question.question_type,
    question: question.question,
    expectedAnswer: question.answer,
    changed: addedLines.length > 0 || removedLines.length > 0,
    lineCount: { withoutGraph: withoutGraph.lines.length, withGraph: withGraph.lines.length },
    charCount: {
      withoutGraph: withoutGraph.lines.join("\n").length,
      withGraph: withGraph.lines.join("\n").length,
    },
    goldClaims: {
      available: goldClaims.length,
      visibleWithoutGraph: offGold.size,
      visibleWithGraph: onGold.size,
      gainedClaimIds: gainedGoldClaimIds,
      lostClaimIds: lostGoldClaimIds,
    },
    answerSignal: signal,
    addedLines,
    removedLines,
  });
  process.stdout.write(`\rgraph retrieval ablation ${index + 1}/${questions.length}`);
}

const changed = rows.filter((row) => row.changed);
const improved = rows.filter(
  (row) => row.goldClaims.gainedClaimIds.length > row.goldClaims.lostClaimIds.length,
);
const regressed = rows.filter(
  (row) => row.goldClaims.lostClaimIds.length > row.goldClaims.gainedClaimIds.length,
);
const neutralGold = changed.filter(
  (row) => row.goldClaims.gainedClaimIds.length === row.goldClaims.lostClaimIds.length,
);
const likelyUseful = changed.filter((row) => row.answerSignal.likelyUseful);
const byType = {};
for (const row of rows) {
  const bucket = (byType[row.type] ??= {
    total: 0,
    changed: 0,
    likelyUseful: 0,
    improved: 0,
    regressed: 0,
  });
  bucket.total += 1;
  if (row.changed) bucket.changed += 1;
  if (row.answerSignal.likelyUseful) bucket.likelyUseful += 1;
  if (row.goldClaims.gainedClaimIds.length > row.goldClaims.lostClaimIds.length) bucket.improved += 1;
  if (row.goldClaims.lostClaimIds.length > row.goldClaims.gainedClaimIds.length) bucket.regressed += 1;
}

const entityNodes = allNodes.filter(
  (node) => !["core:dimension", "core:statement", "core:message"].includes(node.type),
);
const connectedClaimIds = new Set(aboutEdges.map((edge) => edge.from));
const connectedTargetIds = new Set(aboutEdges.map((edge) => edge.to));
const graphPayloadBytes = Buffer.byteLength(JSON.stringify({ nodes: entityNodes, edges: aboutEdges }));
const report = {
  generatedAt: new Date().toISOString(),
  database: dbPath,
  mode: "lexical-only; zero API/model calls",
  controlledVariable: `maxGraphExpansionHits: 0 versus ${expansionHits}`,
  questions: rows.length,
  graphInventory: {
    databaseBytes: statSync(dbPath).size,
    claims: allClaims.length,
    slots: allDimensions.length,
    entityOrEventNodes: entityNodes.length,
    edges: allEdges.length,
    aboutEdges: aboutEdges.length,
    claimsConnectedByAbout: connectedClaimIds.size,
    aboutTargets: connectedTargetIds.size,
    serializedEntityAndAboutPayloadBytes: graphPayloadBytes,
  },
  outcome: {
    contextsChanged: changed.length,
    likelyUsefulChanges: likelyUseful.length,
    changedWithoutAnswerSignal: changed.length - likelyUseful.length,
    goldClaimCoverageImproved: improved.length,
    goldClaimCoverageRegressed: regressed.length,
    changedButGoldCoverageNeutral: neutralGold.length,
    meanAddedLinesWhenChanged: average(changed.map((row) => row.addedLines.length)),
    meanRemovedLinesWhenChanged: average(changed.map((row) => row.removedLines.length)),
    meanCharacterDeltaWhenChanged: average(
      changed.map((row) => row.charCount.withGraph - row.charCount.withoutGraph),
    ),
  },
  byType,
  decisiveCases: rows.filter(
    (row) =>
      row.answerSignal.likelyUseful ||
      row.goldClaims.gainedClaimIds.length > 0 ||
      row.goldClaims.lostClaimIds.length > 0,
  ),
  changedCases: changed,
};

writeFileSync(outputPath, JSON.stringify(report, null, 2));
graph.close();
console.log(`\n${rows.length} questions -> ${outputPath}`);
console.log(
  JSON.stringify(
    {
      graphInventory: report.graphInventory,
      outcome: report.outcome,
      byType: report.byType,
    },
    null,
    2,
  ),
);
