// EdgeLore · MemoryAgentBench Conflict Resolution ingestion.
//
// The official fact-consolidation pool is an ordered stream: a larger serial
// is newer. We batch adjacent facts into one extraction call while assigning
// monotonically increasing Episode dates, so EdgeLore's existing temporal
// conflict semantics see the same order. No benchmark-specific graph schema
// or conflict rule is added.

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
  decisionDriver,
  embeddingDriver,
  normalizeBatchExtractionReply,
  normalizeIntegratedGraphExtractionReply,
  parseJsonReply,
  relevantEntityHintsOf,
  relevantDimensionsOf,
  resolveCapturedConflicts,
  scopesEqual,
  statementText,
  usageJsonl,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const { cfg } = boot();
const datasetPath = resolve(argValue("--dataset") ?? join(here, "data", "conflict-6k.json"));
const runDirArg = argValue("--run-dir");
if (!runDirArg) throw new Error("--run-dir is required");
if (!existsSync(datasetPath)) throw new Error(`dataset not found: ${datasetPath}`);

const runDir = resolve(runDirArg);
const resume = args.includes("--resume");
const dryRun = args.includes("--dry-run");
const resolveConflicts = args.includes("--resolve-conflicts");
const batchSize = Number(argValue("--batch-size") ?? 10);
const startBatch = Number(argValue("--start-batch") ?? 0);
const maxBatches = Number(argValue("--max-batches") ?? Infinity);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12) {
  throw new Error("--batch-size must be an integer from 1 to 12");
}
if (!(maxBatches > 0)) throw new Error("--max-batches must be positive");
if (!Number.isInteger(startBatch) || startBatch < 0) {
  throw new Error("--start-batch must be a non-negative integer");
}

const databasePath = join(runDir, "memory.db");
const checkpointPath = join(runDir, "ingest-checkpoint.json");
const metadataPath = join(runDir, "run-meta.json");
const resultPath = join(runDir, "run-result.json");
const usagePath = join(runDir, "usage.jsonl");
const logPath = join(runDir, "ingest.log");
if (resume) {
  if (!existsSync(databasePath) || !existsSync(checkpointPath) || !existsSync(metadataPath)) {
    throw new Error(`cannot resume incomplete run identity in ${runDir}`);
  }
} else if (existsSync(runDir) && readdirSync(runDir).length > 0) {
  throw new Error(`refusing to overwrite non-empty run directory: ${runDir}`);
} else {
  mkdirSync(runDir, { recursive: true });
}

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const facts = dataset.facts;
const batches = [];
for (let index = 0; index < facts.length; index += batchSize) {
  batches.push(facts.slice(index, index + batchSize));
}
const scope = {
  owner_id: "actor:memoryagentbench",
  project_id: "factconsolidation-6k",
  phase_id: "history",
};

function log(message) {
  console.log(message);
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

function batchDate(batchIndex) {
  const date = new Date(Date.UTC(2024, 0, 1 + batchIndex));
  return date.toISOString().slice(0, 10);
}

const metadata = resume
  ? JSON.parse(readFileSync(metadataPath, "utf8"))
  : {
      status: dryRun ? "dry-run" : "running",
      dataset: datasetPath,
      run_dir: runDir,
      database: databasePath,
      source: dataset.source,
      context_sha256: dataset.context_sha256,
      facts: facts.length,
      batches: batches.length,
      batch_size: batchSize,
      start_batch: startBatch,
      model: cfg.llm?.model ?? null,
      embedding_model: cfg.embedding?.model ?? null,
      decision_model: resolveConflicts ? (cfg.decision?.model ?? null) : null,
      resolve_conflicts: resolveConflicts,
      started_at: new Date().toISOString(),
    };
if (resume && Boolean(metadata.resolve_conflicts) !== resolveConflicts) {
  throw new Error(
    `resume mode mismatch: run resolve_conflicts=${Boolean(metadata.resolve_conflicts)}, CLI resolve_conflicts=${resolveConflicts}`,
  );
}
if (!resume) writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
log(`prepared ${facts.length} ordered facts in ${batches.length} batches`);
if (dryRun) {
  log("dry-run complete; no database or API calls were created");
  process.exit(0);
}

if (!cfg.llm) throw new Error("missing chat model configuration in .env.local");
const forcedThinking = /glm-5\.3/i.test(cfg.llm.model);
const driver = requireChat(cfg, {
  maxTokens: 8_000,
  timeoutMs: 120_000,
  maxRetries: 0,
  extraBody: {
    response_format: { type: "json_object" },
    ...(forcedThinking ? { reasoning_effort: "low" } : { thinking: { type: "disabled" } }),
  },
});
const graph = new SqliteGraph(databasePath);
const vectors = new SqliteVectorStore(graph);
const embedder = cfg.embedding ? embeddingDriver(cfg) : undefined;
const reconcilerDecision = resolveConflicts && cfg.decision ? decisionDriver(cfg) : undefined;
const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8"))
  : { done: [], captures: 0, resolved_conflicts: 0, escalated_conflicts: 0 };
const done = new Set(checkpoint.done);
let totalCaptures = checkpoint.captures ?? 0;
let attempted = 0;
let completed = 0;
let failures = 0;
let resolvedConflicts = checkpoint.resolved_conflicts ?? 0;
let escalatedConflicts = checkpoint.escalated_conflicts ?? 0;
let resolvedThisRun = 0;
let escalatedThisRun = 0;
let usageEntriesWritten = 0;
const startedAt = Date.now();

function persistCheckpoint() {
  writeFileSync(
    checkpointPath,
    JSON.stringify(
      {
        done: [...done],
        captures: totalCaptures,
        resolved_conflicts: resolvedConflicts,
        escalated_conflicts: escalatedConflicts,
      },
      null,
      2,
    ),
  );
  const usageLines = usageJsonl().split("\n").filter(Boolean);
  const freshUsage = usageLines.slice(usageEntriesWritten);
  if (freshUsage.length > 0) {
    appendFileSync(usagePath, `${freshUsage.join("\n")}\n`);
    usageEntriesWritten = usageLines.length;
  }
}
if (!existsSync(checkpointPath)) persistCheckpoint();

function graphHints(transcript) {
  const entityHints = relevantEntityHintsOf(graph, transcript, 10, scope);
  const relationTypes = [
    ...new Set(
      graph
        .queryEdges({})
        .filter((edge) => scopesEqual(edge.scope, scope))
        .map((edge) => edge.type),
    ),
  ].slice(-40);
  return { entityHints, relationTypes };
}

async function extractBatch(batch, episodeId, createdAt) {
  const transcript = batch
    .map((fact) => `[user] Knowledge update #${fact.serial}: ${fact.text}`)
    .join("\n");
  const prompt = buildIntegratedGraphExtractionPrompt({
    transcript,
    knownDimensions: relevantDimensionsOf(graph, transcript, 40, scope),
    maxFacts: batch.length,
    sessionDate: createdAt,
    mustConsiderEvents: [],
    extraFragments: [
      "This is an authoritative knowledge pool supplied for future retrieval. Every numbered Knowledge update is durable and must produce exactly one content item. Preserve conflicting updates; do not drop an older claim merely because another line disagrees.",
      "For relational knowledge, create entities for both the subject and object. Every entity type MUST be namespaced, for example world:person, world:organization, world:place, world:work, world:sport, or world:concept; never use a bare type such as person. Connect each fact with core:about to every entity it directly relates.",
    ],
    ...graphHints(transcript),
  });
  const raw = parseJsonReply(await driver.complete(prompt));
  const fallback = normalizeBatchExtractionReply(raw, 0);
  let plan;
  let contents = fallback.contents;
  try {
    const integrated = normalizeIntegratedGraphExtractionReply(raw, 0);
    plan = integrated.plan;
    contents = integrated.batch.contents;
  } catch (error) {
    log(`[warn] ${episodeId}: graph metadata ignored (${error.message})`);
  }
  const context = {
    created_by: "human:memoryagentbench",
    source_refs: [episodeId],
    createdAt,
    scope,
  };
  if (plan) {
    try {
      return commitGraphWritePlan(graph, plan, context).captures;
    } catch (error) {
      log(`[warn] ${episodeId}: graph plan failed; keeping Claims (${error.message})`);
    }
  }
  return contents.map((content) => capture(graph, content, context));
}

for (let batchIndex = startBatch; batchIndex < batches.length; batchIndex += 1) {
  if (attempted >= maxBatches) break;
  if (done.has(batchIndex)) continue;
  const batch = batches[batchIndex];
  const first = batch[0].serial;
  const last = batch[batch.length - 1].serial;
  const episodeId = `memoryagentbench:factconsolidation-6k:${first}-${last}`;
  const createdAt = batchDate(batchIndex);
  appendEpisode(graph, {
    id: episodeId,
    turns: [
      { role: "user", content: batch.map((fact) => `${fact.serial}. ${fact.text}`).join("\n") },
    ],
    createdBy: "human:memoryagentbench",
    createdAt,
    scope,
    attributes: { benchmark: "MemoryAgentBench", task: "Conflict_Resolution", first, last },
  });
  attempted += 1;
  try {
    const captures = await extractBatch(batch, episodeId, createdAt);
    const resolution = resolveConflicts
      ? await resolveCapturedConflicts(graph, captures, driver, {
          resolvedBy: "agent:edgelore:reconciler",
          ...(reconcilerDecision ? { decision: reconcilerDecision } : {}),
        })
      : { attempted: 0, resolved: 0, escalated: 0, cases: [] };
    totalCaptures += captures.length;
    resolvedConflicts += resolution.resolved;
    escalatedConflicts += resolution.escalated;
    resolvedThisRun += resolution.resolved;
    escalatedThisRun += resolution.escalated;
    done.add(batchIndex);
    completed += 1;
    persistCheckpoint();
    const seconds = (Date.now() - startedAt) / 1000;
    log(
      `progress ${done.size}/${batches.length}; captures ${totalCaptures}; ` +
        `resolved ${resolvedConflicts}; escalated ${escalatedConflicts}; ` +
        `${(seconds / completed).toFixed(1)}s/batch`,
    );
  } catch (error) {
    failures += 1;
    log(`[error] ${episodeId}: ${error.message}`);
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

const embedding = await embedPendingClaims();
persistCheckpoint();
const conflictDimensions = graph
  .queryNodes({ type: "core:dimension" })
  .filter((node) => node.state === "conflict").length;
const result = {
  status: done.size === batches.length ? "complete" : "partial",
  total_batches: batches.length,
  completed_batches: done.size,
  completed_this_run: completed,
  attempted_this_run: attempted,
  failed_this_run: failures,
  captures: totalCaptures,
  episodes: graph.getAllEpisodes().length,
  dimensions: graph.queryNodes({ type: "core:dimension" }).length,
  statements: graph.queryNodes({ type: "core:statement" }).length,
  conflict_dimensions: conflictDimensions,
  conflict_resolution: {
    enabled: resolveConflicts,
    resolved: resolvedConflicts,
    escalated: escalatedConflicts,
    resolved_this_run: resolvedThisRun,
    escalated_this_run: escalatedThisRun,
  },
  embedding,
  usage: usageTotals(),
  elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
  finished_at: new Date().toISOString(),
};
writeFileSync(resultPath, JSON.stringify(result, null, 2));
writeFileSync(metadataPath, JSON.stringify({ ...metadata, status: result.status }, null, 2));
log(`run ${result.status}: ${JSON.stringify(result)}`);
