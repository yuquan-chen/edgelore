// Read-only probe: can the existing v7 Episodes recover the exact payloads
// behind the nine suspected ingestion failures?
//
// Selection uses only the question, the virtual user's haystack session ids,
// and ordinary Claim retrieval. Gold answers / answer_session_ids are used
// only after ranking to score the result and never influence candidate order.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../lib/boot.mjs";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  retrieveRelevant,
  retrievalContext,
  statementText,
} from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const dbPath = resolve(
  process.argv.includes("--db")
    ? process.argv[process.argv.indexOf("--db") + 1]
    : join(dataDir, "runs", "v7-slot-episode-onepass-20260923", "memory.db"),
);
const outputPath = join(dataDir, "episode-recovery-probe-v7-20260923.json");
const maxUnits = Number(process.env.EDGELORE_PROBE_MAX_UNITS ?? 8);
const maxChars = Number(process.env.EDGELORE_PROBE_MAX_CHARS ?? 4_000);

const probes = {
  dd2973ad: [[/2\s*AM/i], [/doctor'?s appointment/i]],
  edced276: [[/10-day so far/i], [/five days/i]],
  "89527b6b": [[/plesiosaur/i, /blue/i]],
  "18dcd5a5": [[/mummies\s*\(4\)/i]],
  "5809eb10": [[/construction/i, /2014/i]],
  eaca4986: [[/C\s+D\s+E\s+F\s+G\s+A\s+B\s+A\s+G\s+F\s+E\s+D\s+C/i]],
  "75499fd8": [[/golden retriever/i]],
  gpt4_1e4a8aec: [[/12/i, /tomato/i]],
  "73d42213": [[/7\s*AM/i], [/two hours/i]],
};

const { cfg } = boot();
if (!cfg.embedding) throw new Error("embedding configuration is required");
const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));
const wanted = new Set(Object.keys(probes));
const questions = dataset.filter((item) => wanted.has(item.question_id));
if (questions.length !== wanted.size) throw new Error("one or more probe ids are missing from dataset");

const graph = new SqliteGraph(dbPath);
const vectors = new SqliteVectorStore(graph);
const embedder = embeddingDriver(cfg);
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const stopWords = new Set([
  "the", "and", "that", "this", "with", "from", "what", "when", "where", "which", "who",
  "why", "how", "did", "does", "was", "were", "are", "for", "you", "your", "their", "they",
  "have", "has", "had", "about", "into", "would", "could", "should", "can", "our", "use", "used",
  "kind", "remind", "mentioned", "previous", "conversation", "looking", "back", "tell", "went",
]);

function termsOf(text) {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
}

function overlap(a, b) {
  let count = 0;
  for (const term of a) if (b.has(term)) count += 1;
  return count;
}

function isoDay(raw) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(raw ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function evidenceRole(query) {
  if (/\b(?:you|assistant)\b.{0,40}\b(?:created|said|told|mentioned|wrote|gave|generated)\b/i.test(query)) {
    return "assistant";
  }
  if (/\b(?:i|my|me|mine)\b/i.test(query)) return "user";
  return undefined;
}

function unitsOf(content) {
  const units = [];
  const blocks = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const block of blocks) {
    // Keep list/table/code/chord-shaped lines intact. Prose is sentence split.
    if (/^(?:[-*+]\s+|\d+[.)]\s+|\|)|```|(?:\b[A-G](?:#|b)?(?:m|maj|min|sus|dim|aug|\d)*\b\s*){4,}/i.test(block)) {
      units.push(block);
      continue;
    }
    const sentences = [...segmenter.segment(block)]
      .map((entry) => entry.segment.trim())
      .filter(Boolean);
    units.push(...(sentences.length > 0 ? sentences : [block]));
  }
  return units;
}

function payloadRecovered(selected, requirements) {
  const text = selected.map((unit) => unit.text).join("\n");
  return requirements.every((group) => group.every((pattern) => pattern.test(text)));
}

function requirementDiagnostics(candidates, requirements, sourceRank) {
  return requirements.map((group) => {
    const index = candidates.findIndex((candidate) =>
      group.every((pattern) => pattern.test(candidate.text)),
    );
    if (index === -1) return { rank: null, text: null };
    const candidate = candidates[index];
    const withinSourceRank =
      candidates.filter((item) => item.sourceRef === candidate.sourceRef).indexOf(candidate) + 1;
    const sourceCandidates = candidates.filter((item) => item.sourceRef === candidate.sourceRef);
    const turns = [...new Set(sourceCandidates.map((item) => item.turnIndex))]
      .map((turnIndex) => ({
        turnIndex,
        score: Math.max(
          ...sourceCandidates.filter((item) => item.turnIndex === turnIndex).map((item) => item.score),
        ),
      }))
      .sort((a, b) => b.score - a.score || a.turnIndex - b.turnIndex);
    const withinSourceTurnRank = turns.findIndex((turn) => turn.turnIndex === candidate.turnIndex) + 1;
    return {
      rank: index + 1,
      withinSourceRank,
      withinSourceTurnRank,
      turnIndex: candidate.turnIndex,
      text: candidate.text,
      sourceRef: candidate.sourceRef,
      claimAnchorRank: sourceRank.get(candidate.sourceRef) ?? null,
    };
  });
}

const rows = [];
for (const [index, question] of questions.entries()) {
  const ledger = new Set(question.haystack_session_ids ?? []);
  const hits = await retrieveRelevant(graph, {
    query: question.question,
    k: 32,
    mode: cfg.retrieval.mode,
    embedder,
    vectors,
    smoothing: cfg.retrieval.rrfSmoothing,
    dateTo: isoDay(question.question_date),
    sourceRefsAllow: [...ledger],
  });
  // Enforce the virtual-user boundary in the probe even though the current
  // production retriever still treats sourceRefsAllow as a ranking hint.
  const scopedHits = hits.filter((hit) => {
    const node = graph.getNode(hit.statementId);
    return (node?.source_refs ?? []).some((sourceRef) => ledger.has(sourceRef));
  });
  const sourceRank = new Map();
  const sourceClaims = new Map();
  scopedHits.forEach((hit, rank) => {
    const node = graph.getNode(hit.statementId);
    if (!node || node.type !== "core:statement") return;
    for (const sourceRef of node.source_refs ?? []) {
      if (!ledger.has(sourceRef)) continue;
      if (!sourceRank.has(sourceRef)) sourceRank.set(sourceRef, rank);
      const current = sourceClaims.get(sourceRef) ?? [];
      const text = statementText(graph, node);
      current.push({ terms: termsOf(text), rank, text });
      sourceClaims.set(sourceRef, current);
    }
  });

  const queryTerms = termsOf(question.question);
  const preferredRole = evidenceRole(question.question);
  const candidates = [];
  for (const sourceRef of ledger) {
    const episode = graph.getEpisode(sourceRef);
    if (!episode || episode.created_at.slice(0, 10) > isoDay(question.question_date)) continue;
    episode.turns.forEach((turn, turnIndex) => {
      unitsOf(turn.content).forEach((text, unitIndex) => {
        const unitTerms = termsOf(text);
        const queryOverlap = overlap(queryTerms, unitTerms);
        const claimFit = Math.max(
          0,
          ...(sourceClaims.get(sourceRef) ?? []).map(
            (claim) => overlap(claim.terms, unitTerms) + 8 / (claim.rank + 1),
          ),
        );
        const rank = sourceRank.get(sourceRef);
        const sourceBonus = rank === undefined ? 0 : 8 / (rank + 1);
        const roleBonus = preferredRole === turn.role ? 0.75 : 0;
        const density = queryOverlap / Math.max(1, Math.sqrt(unitTerms.size));
        const score = queryOverlap * 10 + density * 4 + Math.min(claimFit, 12) + sourceBonus + roleBonus;
        if (score <= 0) return;
        candidates.push({ sourceRef, turnIndex, unitIndex, role: turn.role, text, score });
      });
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);

  const selected = [];
  let chars = 0;
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = candidate.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) continue;
    if (selected.length >= maxUnits) break;
    if (chars + candidate.text.length > maxChars && selected.length > 0) continue;
    selected.push(candidate);
    seen.add(normalized);
    chars += candidate.text.length;
  }

  const actualContext = await retrievalContext(graph, question.question, {
    ...cfg.retrieval,
    k: /\bhow many\b|\btotal\b|\border of\b|\bmost money\b|\bhigher percentage\b/i.test(question.question)
      ? 30
      : 10,
    dateTo: isoDay(question.question_date),
    scopeSessionIds: [...ledger],
    embedder,
    vectors,
  });
  const actualEvidence = actualContext.lines.filter((line) => line.startsWith("conversationEvidence"));
  const actualEvidenceText = actualEvidence.join("\n");
  const actualRecovered = probes[question.question_id].every((group) =>
    group.every((pattern) => pattern.test(actualEvidenceText)),
  );

  rows.push({
    questionId: question.question_id,
    question: question.question,
    expectedAnswer: question.answer,
    flatBaselineRecovered: payloadRecovered(selected, probes[question.question_id]),
    actualRecovered,
    actualEvidenceChars: actualEvidenceText.length,
    actualContextChars: actualContext.lines.join("\n").length,
    actualEvidence,
    requirementDiagnostics: requirementDiagnostics(candidates, probes[question.question_id], sourceRank),
    anchorClaims: Object.fromEntries(
      [...sourceClaims.entries()].map(([sourceRef, claims]) => [
        sourceRef,
        claims.slice(0, 3).map((claim) => ({ rank: claim.rank, text: claim.text })),
      ]),
    ),
    selected,
  });
  process.stdout.write(`\rEpisode recovery probe ${index + 1}/${questions.length}`);
}

const summary = {
  flatBaselineRecovered: rows.filter((row) => row.flatBaselineRecovered).length,
  actualRecovered: rows.filter((row) => row.actualRecovered).length,
  total: rows.length,
  maxUnits,
  maxChars,
};
writeFileSync(outputPath, `${JSON.stringify({ database: dbPath, summary, rows }, null, 2)}\n`);
graph.close();
console.log(`\n${JSON.stringify(summary)} -> ${outputPath}`);
for (const row of rows) {
  const ranks = row.requirementDiagnostics.map((item) => item.rank ?? "absent").join(",");
  console.log(`${row.actualRecovered ? "PASS" : "MISS"} ${row.questionId} evidenceChars=${row.actualEvidenceChars} gold-unit-ranks=${ranks}`);
  for (const item of row.requirementDiagnostics) {
    if (item.text) {
      console.log(`  claim-anchor=${item.claimAnchorRank ?? "none"} turn-rank=${item.withinSourceTurnRank} unit-rank=${item.withinSourceRank} source=${item.sourceRef}: ${item.text}`);
      for (const claim of row.anchorClaims[item.sourceRef] ?? []) {
        console.log(`    claim ${claim.rank}: ${claim.text}`);
      }
    }
  }
}
