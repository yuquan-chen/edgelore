// EdgeLore · LongMemEval-S scoped ingestion.
//
// Every benchmark question represents a separate virtual memory account. Its
// sessions are written under an exact question scope, so neither extraction
// hints nor graph identity can leak across evaluation instances.
//
// Safe rollout:
//   node benchmark/longmemeval/ingest-s.mjs --run-dir <dir> --sample 10 --dry-run
//   node benchmark/longmemeval/ingest-s.mjs --run-dir <dir> --sample 10 --max-new-sessions 1
//   node benchmark/longmemeval/ingest-s.mjs --run-dir <dir> --resume

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  appendEpisode,
  buildIntegratedGraphExtractionPrompt,
  capture,
  commitGraphWritePlan,
  dominantLang,
  embeddingDriver,
  filterByLanguage,
  normalizeBatchExtractionReply,
  normalizeIntegratedGraphExtractionReply,
  parseJsonReply,
  relevantDimensionsOf,
  scanEventCandidates,
  scopesEqual,
  statementText,
  usageJsonl,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";
import { capabilityOf, loadQuestions, questionIndex, selectStratifiedIds } from "./dataset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const args = process.argv.slice(2);
const { cfg } = boot();

function argValue(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function isoDay(raw) {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

const datasetPath = resolve(argValue("--dataset") ?? join(dataDir, "longmemeval_s_cleaned.json"));
const runDirArg = argValue("--run-dir");
const resume = args.includes("--resume");
const dryRun = args.includes("--dry-run");
const sampleSize = Number(argValue("--sample") ?? 10);
const questionId = argValue("--question-id");
const seed = Number(argValue("--seed") ?? 20260925);
const maxNewSessions = Number(argValue("--max-new-sessions") ?? Infinity);

if (!runDirArg)
  throw new Error("--run-dir is required; S runs must never reuse an implicit database");
if (!existsSync(datasetPath)) throw new Error(`dataset not found: ${datasetPath}`);
if (!Number.isInteger(sampleSize) || sampleSize <= 0 || sampleSize > 500) {
  throw new Error("--sample must be an integer from 1 to 500");
}
if (!(maxNewSessions > 0)) throw new Error("--max-new-sessions must be positive");

const runDir = resolve(runDirArg);
const selectionPath = join(runDir, "selection.json");
const checkpointPath = join(runDir, "ingest-checkpoint.json");
const databasePath = join(runDir, "memory.db");
const metadataPath = join(runDir, "run-meta.json");
const resultPath = join(runDir, "run-result.json");
const usagePath = join(runDir, "usage.jsonl");
const logPath = join(runDir, "ingest.log");

if (resume) {
  if (!existsSync(selectionPath) || !existsSync(checkpointPath) || !existsSync(databasePath)) {
    throw new Error(`cannot resume incomplete run identity in ${runDir}`);
  }
} else if (existsSync(runDir) && readdirSync(runDir).length > 0) {
  throw new Error(`refusing to overwrite non-empty run directory: ${runDir}`);
} else {
  mkdirSync(runDir, { recursive: true });
}

function log(message) {
  console.log(message);
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

let selection;
if (resume) {
  selection = JSON.parse(readFileSync(selectionPath, "utf8"));
  if (resolve(selection.dataset) !== datasetPath) {
    throw new Error("resume dataset differs from the original run");
  }
} else {
  const index = await questionIndex(datasetPath);
  const selectedIds = questionId
    ? index.some((item) => item.id === questionId)
      ? [questionId]
      : (() => {
          throw new Error(`unknown --question-id: ${questionId}`);
        })()
    : selectStratifiedIds(index, sampleSize, seed);
  const capabilityById = new Map(index.map((item) => [item.id, item.capability]));
  selection = {
    dataset: datasetPath,
    seed,
    requested_sample_size: questionId ? null : sampleSize,
    requested_question_id: questionId ?? null,
    selected_ids: selectedIds,
    capabilities: Object.fromEntries(selectedIds.map((id) => [id, capabilityById.get(id)])),
  };
  writeFileSync(selectionPath, JSON.stringify(selection, null, 2));
}

const questions = await loadQuestions(datasetPath, selection.selected_ids);
const totalSessionOccurrences = questions.reduce(
  (total, question) => total + question.haystack_session_ids.length,
  0,
);
const capabilityCounts = {};
for (const question of questions) {
  const capability = capabilityOf(question);
  capabilityCounts[capability] = (capabilityCounts[capability] ?? 0) + 1;
}

const metadata = {
  status: dryRun ? "dry-run" : "running",
  dataset: datasetPath,
  run_dir: runDir,
  database: databasePath,
  seed: selection.seed,
  selected_ids: selection.selected_ids,
  capability_counts: capabilityCounts,
  selected_questions: questions.length,
  session_occurrences: totalSessionOccurrences,
  model: cfg.llm?.model ?? null,
  embedding_model: cfg.embedding?.model ?? null,
  max_facts_per_session: cfg.extraction.maxFactsPerSession,
  started_at: new Date().toISOString(),
};
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

log(`selected ${questions.length} questions / ${totalSessionOccurrences} session occurrences`);
log(`capabilities ${JSON.stringify(capabilityCounts)}`);
if (dryRun) {
  log(`dry-run complete; no database or API calls were created`);
  process.exit(0);
}

if (!cfg.llm) throw new Error("missing chat model configuration in .env.local");
const forcedThinking = /glm-5\.3/i.test(cfg.llm.model);
const driver = requireChat(cfg, {
  maxTokens: 8_000,
  timeoutMs: 120_000,
  // A paid request may still finish upstream after the local timeout. Never
  // duplicate it automatically; durable Episodes make explicit resume safe.
  maxRetries: 0,
  extraBody: {
    response_format: { type: "json_object" },
    ...(forcedThinking ? { reasoning_effort: "low" } : { thinking: { type: "disabled" } }),
  },
});
const graph = new SqliteGraph(databasePath);
const vectors = new SqliteVectorStore(graph);
const embedder = cfg.embedding ? embeddingDriver(cfg) : undefined;

const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8"))
  : { done: [], facts: 0, episodeOnly: [] };
const done = new Set(checkpoint.done);
const episodeOnly = Array.isArray(checkpoint.episodeOnly) ? checkpoint.episodeOnly : [];
let totalFacts = checkpoint.facts ?? 0;
let processed = 0;
let attempted = 0;
let failures = 0;
const startedAt = Date.now();
let usageEntriesWritten = 0;

if (!existsSync(checkpointPath)) {
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

function persistCheckpoint() {
  writeFileSync(
    checkpointPath,
    JSON.stringify({ done: [...done], facts: totalFacts, episodeOnly }, null, 2),
  );
  const usageLines = usageJsonl().split("\n").filter(Boolean);
  const freshUsage = usageLines.slice(usageEntriesWritten);
  if (freshUsage.length > 0) {
    appendFileSync(usagePath, freshUsage.join("\n") + "\n");
    usageEntriesWritten = usageLines.length;
  }
}

function isTerminalContentRefusal(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^API 400:/i.test(message) &&
    /(?:"code"\s*:\s*"?1301|unsafe|safety|sensitive|不安全|敏感)/i.test(message)
  );
}

function scopeFor(questionId) {
  return {
    owner_id: "actor:longmemeval-s",
    project_id: `question:${questionId}`,
    phase_id: "history",
  };
}

function graphHints(scope) {
  const entities = graph
    .queryNodes({})
    .filter(
      (node) =>
        node.type !== "core:dimension" &&
        node.type !== "core:statement" &&
        node.type !== "core:message" &&
        typeof node.key === "string" &&
        scopesEqual(node.scope, scope),
    )
    .slice(-40)
    .map((node) => ({
      type: node.type,
      key: node.key,
      ...(node.value !== undefined ? { value: node.value } : {}),
      scope: "context",
    }));
  const relationTypes = [
    ...new Set(
      graph
        .queryEdges({})
        .filter((edge) => scopesEqual(edge.scope, scope))
        .map((edge) => edge.type),
    ),
  ].slice(-40);
  return { entityHints: entities, relationTypes };
}

async function extractSession(question, sessionIndex, episodeId, scope) {
  const turns = question.haystack_sessions[sessionIndex] ?? [];
  const date = isoDay(question.haystack_dates[sessionIndex]);
  const transcript = turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  if (!transcript.trim()) return 0;

  const eventCandidates = scanEventCandidates(transcript);
  const promptInput = {
    transcript,
    knownDimensions: relevantDimensionsOf(graph, transcript, 30, scope),
    maxFacts: cfg.extraction.maxFactsPerSession,
    sessionDate: date,
    mustConsiderEvents: eventCandidates,
    ...graphHints(scope),
  };
  const prompt = buildIntegratedGraphExtractionPrompt(promptInput);
  const raw = parseJsonReply(await driver.complete(prompt));
  let batch = normalizeBatchExtractionReply(raw, eventCandidates.length);

  const expectedLanguage = dominantLang(transcript);
  let languageDropped = false;
  if (expectedLanguage) {
    const filtered = filterByLanguage(batch.contents, (content) => content.value, expectedLanguage);
    languageDropped = filtered.dropped.length > 0;
    batch = { ...batch, contents: filtered.keep };
  }

  let plan;
  let contents = batch.contents;
  if (!languageDropped) {
    try {
      const integrated = normalizeIntegratedGraphExtractionReply(raw, eventCandidates.length);
      plan = integrated.plan;
      contents = integrated.batch.contents;
    } catch (error) {
      log(`[warn] ${episodeId}: graph metadata ignored (${error.message})`);
    }
  }

  const captureContext = {
    created_by: "human:longmemeval_user",
    source_refs: [episodeId],
    createdAt: date,
    scope,
  };
  if (plan) {
    try {
      return commitGraphWritePlan(graph, plan, captureContext).captures.length;
    } catch (error) {
      log(`[warn] ${episodeId}: graph plan failed; keeping Claims (${error.message})`);
    }
  }

  let stored = 0;
  for (const content of contents) {
    capture(graph, content, captureContext);
    stored += 1;
  }
  return stored;
}

outer: for (const question of questions) {
  const scope = scopeFor(question.question_id);
  for (let index = 0; index < question.haystack_session_ids.length; index += 1) {
    if (attempted >= maxNewSessions) break outer;
    const originalSessionId = question.haystack_session_ids[index];
    const episodeId = `longmemeval-s:${question.question_id}:${originalSessionId}`;
    const checkpointId = `${question.question_id}:${originalSessionId}`;
    if (done.has(checkpointId)) continue;

    const turns = question.haystack_sessions[index] ?? [];
    appendEpisode(graph, {
      id: episodeId,
      turns,
      createdBy: "human:longmemeval_user",
      createdAt: isoDay(question.haystack_dates[index]),
      scope,
      attributes: {
        kind: "conversation",
        verbatim: true,
        benchmark: "longmemeval-s",
        question_id: question.question_id,
        original_session_id: originalSessionId,
      },
    });

    attempted += 1;
    try {
      const facts = await extractSession(question, index, episodeId, scope);
      totalFacts += facts;
      done.add(checkpointId);
      processed += 1;
      persistCheckpoint();
      const elapsed = (Date.now() - startedAt) / 1000;
      log(
        `progress ${done.size}/${totalSessionOccurrences}; this run ${processed}; facts ${totalFacts}; ` +
          `${(elapsed / processed).toFixed(1)}s/session`,
      );
    } catch (error) {
      failures += 1;
      if (isTerminalContentRefusal(error)) {
        episodeOnly.push({
          checkpoint_id: checkpointId,
          episode_id: episodeId,
          reason: "provider_content_refusal",
          recorded_at: new Date().toISOString(),
        });
        done.add(checkpointId);
        persistCheckpoint();
        log(`[warn] ${episodeId}: provider refused semantic extraction; Episode retained`);
      } else {
        log(`[error] ${episodeId}: ${error.message}`);
      }
    }
  }
}

async function embedPendingClaims() {
  if (!embedder) return { embedded: 0, failedBatches: 0 };
  const indexed = new Set(graph.allVectors().map((entry) => entry.nodeId));
  const nodes = graph
    .queryNodes({ type: "core:statement" })
    .filter((node) => !indexed.has(node.id));
  let embedded = 0;
  let failedBatches = 0;
  for (let index = 0; index < nodes.length; index += 16) {
    const batch = nodes.slice(index, index + 16);
    try {
      const embeddings = await embedder.embed(batch.map((node) => statementText(graph, node)));
      batch.forEach((node, offset) => vectors.put(node.id, embeddings[offset]));
      embedded += batch.length;
    } catch (error) {
      failedBatches += 1;
      log(`[warn] embedding batch failed: ${error.message}`);
    }
  }
  return { embedded, failedBatches };
}

const embeddingResult = await embedPendingClaims();
persistCheckpoint();
const usage = usageTotals();
const result = {
  status: done.size === totalSessionOccurrences ? "complete" : "partial",
  selected_questions: questions.length,
  total_session_occurrences: totalSessionOccurrences,
  completed_session_occurrences: done.size,
  episode_only_occurrences: episodeOnly.length,
  processed_this_run: processed,
  attempted_this_run: attempted,
  failed_this_run: failures,
  facts: totalFacts,
  episodes: graph.getAllEpisodes().length,
  dimensions: graph.queryNodes({ type: "core:dimension" }).length,
  statements: graph.queryNodes({ type: "core:statement" }).length,
  embedding: embeddingResult,
  usage,
  elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
  finished_at: new Date().toISOString(),
};
writeFileSync(resultPath, JSON.stringify(result, null, 2));
writeFileSync(metadataPath, JSON.stringify({ ...metadata, status: result.status }, null, 2));
log(`run ${result.status}: ${JSON.stringify(result)}`);
