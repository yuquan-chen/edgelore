// edgelore · LongMemEval ingestion — session-level batch extraction.
//
// Ingests every unique session of the dataset into ONE shared memory store:
// one extract call per session (batch mode — cheaper than per-turn), facts
// captured with the SESSION's date (temporal reasoning needs real dates),
// knownDimensions growing as we go (anti-drift), vectors written after each
// session. Resumable via a checkpoint file.
//
// Usage:
//   node benchmark/longmemeval/ingest.mjs --graph --run-dir data/runs/<name>
//   node benchmark/longmemeval/ingest.mjs --graph --run-dir data/runs/<name> --resume
// Legacy: [--limit N] [--graph] [--db PATH]

import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  parseJsonReply,
  capture,
  buildBatchExtractionPrompt,
  normalizeBatchExtractionReply,
  relevantDimensionsOf,
  scanEventCandidates,
  dominantLang,
  filterByLanguage,
  runGraphEnrichment,
  commitGraphWritePlan,
  archiveConversationEvidence,
  conversationEvidenceText,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// --- env ---------------------------------------------------------------------

const { cfg } = boot();
if (!cfg.llm) {
  console.error("missing OPENAI_API_KEY / EDGELORE_MODEL (check .env.local at repo root)");
  process.exit(1);
}

// --- dataset -----------------------------------------------------------------

const dataDir = join(here, "data");
const dataPath = join(dataDir, "longmemeval_oracle.json");
const args = process.argv.slice(2);
function argVal(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
const graphMode = args.includes("--graph");
const resume = args.includes("--resume");
const runDirArg = argVal("--run-dir");
const dbArg = argVal("--db");
if (runDirArg && dbArg) {
  console.error("use either --run-dir or --db, never both");
  process.exit(1);
}

let runDir;
let checkpointPath;
let dbPath;
let runMetaPath;
if (runDirArg) {
  runDir = resolve(runDirArg);
  if (existsSync(runDir) && readdirSync(runDir).length > 0 && !resume) {
    console.error(`refusing to overwrite non-empty run directory: ${runDir}`);
    console.error("choose a new --run-dir, or pass --resume for this exact run");
    process.exit(1);
  }
  mkdirSync(runDir, { recursive: true });
  checkpointPath = join(runDir, "ingest-checkpoint.json");
  dbPath = join(runDir, "memory.db");
  runMetaPath = join(runDir, "run-meta.json");
  if (resume && (!existsSync(checkpointPath) || !existsSync(dbPath))) {
    console.error(`cannot resume: memory.db and ingest-checkpoint.json must both exist in ${runDir}`);
    process.exit(1);
  }
} else {
  const shardTag = (argVal("--shard") ?? "main").replace("/", "-");
  checkpointPath = join(dataDir, `ingest-checkpoint-${shardTag}${graphMode ? "-graph" : ""}.json`);
  dbPath = dbArg ? resolve(dbArg) : join(dataDir, graphMode ? "memory-graph.db" : "memory.db");
}

// A run-local, append-only operational log makes long imports auditable and
// survives terminal closure. It is installed only after the fresh-directory
// guard, so creating the log can never make a new run look like a resume.
if (runDir) {
  const logPath = join(runDir, "ingest.log");
  const terminalLog = console.log.bind(console);
  const terminalError = console.error.bind(console);
  const persist = (level, parts) => {
    const rendered = parts
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join(" ");
    appendFileSync(logPath, `${new Date().toISOString()} ${level} ${rendered}\n`);
  };
  console.log = (...parts) => {
    terminalLog(...parts);
    persist("INFO", parts);
  };
  console.error = (...parts) => {
    terminalError(...parts);
    persist("ERROR", parts);
  };
}

const dataset = JSON.parse(readFileSync(dataPath, "utf8"));
const limit = Number(argVal("--limit") ?? Infinity);

// unique sessions: sessionId -> { date, turns }
const sessions = new Map();
for (const q of dataset) {
  q.haystack_session_ids.forEach((sid, i) => {
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        date: (q.haystack_dates[i] ?? "").slice(0, 10).replace(/\//g, "-"),
        turns: q.haystack_sessions[i] ?? [],
      });
    }
  });
}
console.log(`unique sessions: ${sessions.size}${Number.isFinite(limit) ? ` (limit ${limit})` : ""}`);
if (runDir && !resume) {
  writeFileSync(
    runMetaPath,
    JSON.stringify(
      {
        status: "running",
        started_at: new Date().toISOString(),
        run_dir: runDir,
        database: dbPath,
        checkpoint: checkpointPath,
        dataset: dataPath,
        dataset_sessions: sessions.size,
        graph_mode: graphMode,
        model: cfg.llm.model,
        embedding_model: cfg.embedding?.model ?? null,
        max_facts_per_session: cfg.extraction.maxFactsPerSession,
        command_args: args,
      },
      null,
      2,
    ),
  );
}
console.log(`database: ${dbPath}`);
console.log(`checkpoint: ${checkpointPath}`);

// --- checkpoint --------------------------------------------------------------

const done = existsSync(checkpointPath) ? new Set(readCheckpoint().done) : new Set();
const remainingTotal = [...sessions.keys()].filter((sid) => !done.has(sid)).length; // 本轮真正要补的数量
function readCheckpoint() {
  if (!existsSync(checkpointPath)) return { done: [], facts: 0 };
  const raw = JSON.parse(readFileSync(checkpointPath, "utf8"));
  return Array.isArray(raw) ? { done: raw, facts: 0 } : raw;
}
let workerFacts = readCheckpoint().facts;
function checkpoint(sid) {
  done.add(sid);
  writeFileSync(checkpointPath, JSON.stringify({ done: [...done], facts: workerFacts }));
}

// --- extraction --------------------------------------------------------------

const driver = requireChat(cfg, { maxTokens: 16000, extraBody: { thinking: { type: "disabled" } } }); // 抽取是机械活：关思考省预算提速
const graph = new SqliteGraph(dbPath);
const vectors = new SqliteVectorStore(graph);
const embedder = cfg.embedding ? embeddingDriver(cfg) : undefined;

function knownDimensions() {
  // full list — kept only for progress/debug output; prompts use relevantDimensionsOf
  return (graph.queryNodes({ type: "core:dimension" }) ?? []).map((d) => ({
    key: d.key,
    description: typeof d.attributes?.description === "string" ? d.attributes.description : d.key,
    cardinality: d.cardinality ?? "multi",
  }));
}
void knownDimensions;

async function captureContents(contents, sessionId, date, transcript) {
  const captureCtx = {
    created_by: "human:longmemeval_user",
    source_refs: [sessionId],
    createdAt: date || undefined,
    ...(graphMode ? { scope: { owner_id: "actor:longmemeval_user" } } : {}),
  };
  if (graphMode) {
    try {
      const plan = await runGraphEnrichment({
        text: transcript,
        contents,
        knownDimensions: relevantDimensionsOf(graph, transcript, 30),
        graph,
        driver,
        scope: captureCtx.scope,
      });
      if (plan.warnings.length > 0) {
        console.log(`\n[warn] session ${sessionId}: graph enrichment recovered ${plan.warnings.length} issue(s)`);
      }
      return commitGraphWritePlan(graph, plan, captureCtx).captures.length;
    } catch (err) {
      console.log(`\n[warn] session ${sessionId}: graph enrichment failed; facts kept (${err.message})`);
    }
  }
  let stored = 0;
  for (const c of contents) {
    capture(graph, c, captureCtx);
    stored += 1;
  }
  return stored;
}

async function embedSession(sessionId) {
  if (!embedder) return;
  const nodes = [
    ...graph.queryNodes({ type: "core:statement" }),
    ...graph.queryNodes({ type: "core:message" }),
  ].filter((node) => node.source_refs.includes(sessionId));
  if (nodes.length === 0) return;
  const texts = nodes.map((node) => {
    if (node.type === "core:message") return conversationEvidenceText(node);
    const dim = graph.getNode(node.dimension_id);
    return `${dim?.key ?? ""} ${JSON.stringify(node.value)}${node.unit ? ` ${node.unit}` : ""}`;
  });
  // qwen embedding 单批上限 20 条——分批 ≤16 防止 400
  for (let i = 0; i < texts.length; i += 16) {
    const chunkTexts = texts.slice(i, i + 16);
    const chunkNodes = nodes.slice(i, i + 16);
    const vecs = await embedder.embed(chunkTexts);
    chunkNodes.forEach((node, j) => vectors.put(node.id, vecs[j]));
  }
}

// --- main loop ---------------------------------------------------------------

const limitIdx = args.indexOf("--limit");
const maxSessions = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
const shardIdx = args.indexOf("--shard"); // 过滤语法是 "i/N"；不带 "/" 的值只是 checkpoint 名（如 --shard v5）
let shardFilter = null;
if (shardIdx !== -1 && /^\d+\/\d+$/.test(args[shardIdx + 1])) {
  const [i, n] = args[shardIdx + 1].split("/").map(Number);
  if (n > 0) shardFilter = (ordinal) => ordinal % n === i;
}
let processed = 0;
let factsStored = 0;
let evidenceStored = 0;
let langDroppedTotal = 0;
let eventKeptTotal = 0;
let eventDroppedTotal = 0;
let ordinal = -1;
const t0 = Date.now();

function drawBar(done, total, facts, start) {
  const width = 28;
  const filled = Math.round((width * done) / Math.max(total, 1));
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  const elapsed = (Date.now() - start) / 1000;
  const eta = done > 0 ? (elapsed / done) * (total - done) : 0;
  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.round(s)}s`);
  process.stdout.write(`
[${bar}] ${((done / Math.max(total, 1)) * 100).toFixed(1)}%  ${done}/${total} 会话  ${facts} 条记忆  已用 ${fmt(elapsed)}  剩余约 ${fmt(eta)}  `);
}

for (const [sid, session] of sessions) {
  ordinal += 1;
  if (shardFilter && !shardFilter(ordinal)) continue;
  if (processed >= maxSessions) break;
  if (done.has(sid)) continue;

  const transcript = session.turns.map((t) => `[${t.role}] ${t.content}`).join("\n");
  if (!transcript.trim()) {
    checkpoint(sid);
    continue;
  }

  // Archive the immutable source before any probabilistic extraction. If the
  // LLM violates its contract, the exact conversation still survives while
  // the semantic pass remains uncheckpointed for a later resume.
  const evidence = archiveConversationEvidence(graph, session.turns, {
    created_by: "human:longmemeval_user",
    source_ref: sid,
    createdAt: session.date || undefined,
    ...(graphMode ? { scope: { owner_id: "actor:longmemeval_user" } } : {}),
  });
  evidenceStored += evidence.length;

  try {
    const eventCandidates = scanEventCandidates(transcript);
    const promptOpts = {
      transcript,
      // 相关 top-30 而非全量：全量清单 O(维度数) 增长，库后期每次 prompt 带
      // 60 万字符的 key 清单，超出模型上下文被静默截断，反漂移失效
      knownDimensions: relevantDimensionsOf(graph, transcript, 30),
      maxFacts: cfg.extraction.maxFactsPerSession,
      sessionDate: session.date || undefined,
      // 事件扫描（触发层 v0）：旁插的"我 + 时间"句必须被逐条裁决，防静默丢失
      mustConsiderEvents: eventCandidates,
    };
    let parsed = parseJsonReply(await driver.complete(buildBatchExtractionPrompt(promptOpts)));
    let batch;
    try {
      batch = normalizeBatchExtractionReply(parsed, eventCandidates.length);
    } catch (err) {
      if (eventCandidates.length === 0) throw err;
      parsed = parseJsonReply(
        await driver.complete(
          buildBatchExtractionPrompt({
            ...promptOpts,
            extraFragments: [
              `NOTE: your previous reply violated the eventDecisions contract: ${err.message}`,
              "Return exactly one valid keep/drop decision for every listed eventId.",
              "A keep decision must contain its complete memory content object.",
            ],
          }),
        ),
      );
      batch = normalizeBatchExtractionReply(parsed, eventCandidates.length);
    }
    if (batch.contents.length === 0) {
      // Empty-reply retry: flash overuses the [] exit on recommendation-heavy
      // sessions (smoke test: 7/20). One nudged re-ask costs a call only
      // when it fires.
      parsed = parseJsonReply(
        await driver.complete(
          buildBatchExtractionPrompt({
            ...promptOpts,
            extraFragments: [
              "NOTE: your previous reply was EMPTY, but this session is not empty.",
              "Extract the assistant's recommendations/explanations and every durable",
              "fact from either speaker explicitly.",
            ],
          }),
        ),
      );
      batch = normalizeBatchExtractionReply(parsed, eventCandidates.length);
    }
    // 语言钉死·代码层（E5）：与会话语言不符的语句是脏数据——确定性的丢，
    // 漂移占主导时带提示重抽一次。歧义载荷（纯数字/专名）一律放行。
    const expectedLang = dominantLang(transcript);
    let langDropped = 0;
    if (expectedLang) {
      let lf = filterByLanguage(batch.contents, (c) => c.value, expectedLang);
      if (lf.dropped.length > 0 && lf.keep.length <= batch.contents.length / 2) {
        parsed = parseJsonReply(
          await driver.complete(
            buildBatchExtractionPrompt({
              ...promptOpts,
              extraFragments: [
                `NOTE: your previous reply mixed languages. The session is in ${
                  expectedLang === "zh" ? "Chinese" : expectedLang === "es" ? "Spanish" : "English"
                }: write EVERY value in that language ONLY.`,
                "Entries written in any other language are discarded.",
              ],
            }),
          ),
        );
        const retried = normalizeBatchExtractionReply(parsed, eventCandidates.length);
        lf = filterByLanguage(retried.contents, (c) => c.value, expectedLang);
        batch = { ...retried, contents: lf.keep };
      } else {
        batch = { ...batch, contents: lf.keep };
      }
      langDropped = lf.dropped.length;
      langDroppedTotal += langDropped;
    }
    if (batch.skipped > 0) {
      console.log(`\n[warn] session ${sid}: skipped ${batch.skipped} malformed entries`);
    }
    if (langDropped > 0) {
      console.log(`\n[warn] session ${sid}: dropped ${langDropped} wrong-language entries (expected ${expectedLang})`);
    }
    const contents = batch.contents;
    const stored = await captureContents(contents, sid, session.date, transcript);
    workerFacts += stored;
    factsStored += stored;
    eventKeptTotal += batch.eventKept;
    eventDroppedTotal += batch.eventDropped;
    if (process.stdout.isTTY) {
      drawBar(processed, remainingTotal || 1, factsStored, t0);
    } else if (processed % 20 === 0) {
      console.log(`progress: ${processed} sessions, ${factsStored} facts, ${((Date.now() - t0) / 1000 / processed).toFixed(1)}s/session`);
    }
    try {
      await embedSession(sid); // best-effort: vectors are derived data, rebuildable
    } catch (err) {
      console.log(`[warn] session ${sid}: embed failed (facts kept): ${err.message}`);
    }
    // The run-local checkpoint advances only after facts and the best-effort
    // embedding pass. A crash before here safely replays through capture dedup.
    checkpoint(sid);
  } catch (err) {
    console.log(`[warn] session ${sid}: ${err.message} — skipped (rerun to retry)`);
    continue; // not checkpointed: retried on next run
  }

  processed += 1;
  if (processed % 20 === 0) {
    const rate = processed / ((Date.now() - t0) / 1000);
    console.log(`progress: ${processed} sessions, ${factsStored} facts, ${rate.toFixed(2)} sess/s`);
  }
}

const dims = graph.queryNodes({ type: "core:dimension" }).length;
const statements = graph.queryNodes({ type: "core:statement" }).length;
const messages = graph.queryNodes({ type: "core:message" }).length;
let entities = 0;
console.log(`\ndone: ${processed} sessions this run, ${factsStored} facts this run`);
console.log(`language pinning: ${langDroppedTotal} wrong-language entries dropped`);
console.log(`event decisions: ${eventKeptTotal} kept, ${eventDroppedTotal} dropped`);
console.log(`store: ${dims} dimensions, ${statements} statements`);
console.log(`evidence: ${messages} verbatim message chunks (${evidenceStored} this run)`);
if (graphMode) {
  entities = graph.queryNodes({}).filter(
    (node) =>
      node.type !== "core:dimension" &&
      node.type !== "core:statement" &&
      node.type !== "core:message",
  ).length;
  console.log(`graph: ${entities} entities/events, ${graph.queryEdges({}).length} edges`);
}
const usage = usageTotals();
console.log(`API usage: ${usage.calls} calls, ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens, ${usage.errors} errors`);
if (runDir) {
  const completedSessions = [...sessions.keys()].filter((sid) => done.has(sid)).length;
  writeFileSync(
    join(runDir, "run-result.json"),
    JSON.stringify(
      {
        status: completedSessions === sessions.size ? "complete" : "incomplete",
        finished_at: new Date().toISOString(),
        database: dbPath,
        checkpoint: checkpointPath,
        completed_sessions: completedSessions,
        total_sessions: sessions.size,
        dimensions: dims,
        statements,
        message_chunks: messages,
        entities,
        event_decisions: { kept: eventKeptTotal, dropped: eventDroppedTotal },
        language_dropped: langDroppedTotal,
        usage,
      },
      null,
      2,
    ),
  );
}
graph.close();
