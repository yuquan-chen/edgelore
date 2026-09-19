// edgelore · LongMemEval ingestion — session-level batch extraction.
//
// Ingests every unique session of the dataset into ONE shared memory store:
// one extract call per session (batch mode — cheaper than per-turn), facts
// captured with the SESSION's date (temporal reasoning needs real dates),
// knownDimensions growing as we go (anti-drift), vectors written after each
// session. Resumable via a checkpoint file.
//
// Usage: node benchmark/longmemeval/ingest.mjs [--limit N]

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  parseJsonReply,
  capture,
  buildBatchExtractionPrompt,
  normalizeBatchContents,
  relevantDimensionsOf,
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
const shardArg = process.argv.indexOf("--shard");
const shardTag = shardArg !== -1 ? process.argv[shardArg + 1].replace("/", "-") : "main";
const checkpointPath = join(dataDir, `ingest-checkpoint-${shardTag}.json`);
const dbIdx = process.argv.indexOf("--db");
const dbPath = dbIdx !== -1 ? process.argv[dbIdx + 1] : join(dataDir, "memory.db");

const dataset = JSON.parse(readFileSync(dataPath, "utf8"));
const limit = Number(process.argv[process.argv.indexOf("--limit") + 1] ?? Infinity);

// unique sessions: sessionId -> { date, turns }
const sessions = new Map();
for (const q of dataset) {
  q.haystack_session_ids.forEach((sid, i) => {
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        date: (q.haystack_dates[i] ?? "").slice(0, 10),
        turns: q.haystack_sessions[i] ?? [],
      });
    }
  });
}
console.log(`unique sessions: ${sessions.size}${Number.isFinite(limit) ? ` (limit ${limit})` : ""}`);

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
const ctx = { created_by: "human:longmemeval_user", source_refs: [] };

function knownDimensions() {
  // full list — kept only for progress/debug output; prompts use relevantDimensionsOf
  return (graph.queryNodes({ type: "core:dimension" }) ?? []).map((d) => ({
    key: d.key,
    description: typeof d.attributes?.description === "string" ? d.attributes.description : d.key,
    cardinality: d.cardinality ?? "multi",
  }));
}
void knownDimensions;

function captureContents(contents, sessionId, date) {
  let stored = 0;
  for (const c of contents) {
    capture(graph, c, {
      created_by: "human:longmemeval_user",
      source_refs: [sessionId],
      createdAt: date || undefined,
    });
    stored += 1;
  }
  return stored;
}

async function embedSession(sessionId) {
  if (!embedder) return;
  const stmts = graph.queryNodes({ type: "core:statement" }).filter(
    (s) => s.source_refs.includes(sessionId),
  );
  if (stmts.length === 0) return;
  const texts = stmts.map((s) => {
    const dim = graph.getNode(s.dimension_id);
    return `${dim?.key ?? ""} ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""}`;
  });
  // qwen embedding 单批上限 20 条——分批 ≤16 防止 400
  for (let i = 0; i < texts.length; i += 16) {
    const chunkTexts = texts.slice(i, i + 16);
    const chunkStmts = stmts.slice(i, i + 16);
    const vecs = await embedder.embed(chunkTexts);
    chunkStmts.forEach((s, j) => vectors.put(s.id, vecs[j]));
  }
}

// --- main loop ---------------------------------------------------------------

const args = process.argv;
const limitIdx = args.indexOf("--limit");
const maxSessions = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
const shardIdx = args.indexOf("--shard"); // --shard i/N
let shardFilter = null;
if (shardIdx !== -1) {
  const [i, n] = args[shardIdx + 1].split("/").map(Number);
  shardFilter = (ordinal) => ordinal % n === i;
}
let processed = 0;
let factsStored = 0;
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

  try {
    const promptOpts = {
      transcript,
      // 相关 top-30 而非全量：全量清单 O(维度数) 增长，库后期每次 prompt 带
      // 60 万字符的 key 清单，超出模型上下文被静默截断，反漂移失效
      knownDimensions: relevantDimensionsOf(graph, transcript, 30),
      maxFacts: cfg.extraction.maxFactsPerSession,
    };
    let parsed = parseJsonReply(await driver.complete(buildBatchExtractionPrompt(promptOpts)));
    let batch = normalizeBatchContents(parsed.contents ?? []);
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
      batch = normalizeBatchContents(parsed.contents ?? []);
    }
    if (batch.skipped > 0) {
      console.log(`\n[warn] session ${sid}: skipped ${batch.skipped} malformed entries`);
    }
    const contents = batch.contents;
    ctx.source_refs = [sid];
    const stored = captureContents(contents, sid, session.date);
    workerFacts += stored;
    checkpoint(sid); // facts are persisted — checkpoint immediately
    factsStored += stored;
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
console.log(`\ndone: ${processed} sessions this run, ${factsStored} facts this run`);
console.log(`store: ${dims} dimensions, ${graph.queryNodes({ type: "core:statement" }).length} statements`);
