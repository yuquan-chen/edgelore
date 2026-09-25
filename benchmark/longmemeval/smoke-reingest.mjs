// edgelore · 抽样质检 — 用新抽取管线重抽最缺料的会话进临时库，验证入库质量。
//
// 目的：在付 940 会话全价重摄入之前，用 ~20 次调用确认新管线真的修好了
// 三个审计发现的问题：① assistant 内容被丢（无 saidBy）② 一次性事件被滤
// ③ 表格/长文细节聚合丢失。抽完本地免费对质：金标内容的库内覆盖率 旧 vs 新。
//
// Usage: node benchmark/longmemeval/smoke-reingest.mjs [--n 20]
// 产物: data/smoke-reingest.db（临时库，不碰 memory.db）

import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  parseJsonReply,
  capture,
  buildBatchExtractionPrompt,
  normalizeBatchExtractionReply,
  scanEventCandidates,
  detectLang,
  dominantLang,
  filterByLanguage,
  archiveConversationEvidence,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const { cfg } = boot();
const driver = requireChat(cfg, { maxTokens: 16000, extraBody: { thinking: { type: "disabled" } } });

const nArg = process.argv.indexOf("--n");
const N = nArg !== -1 ? Number(process.argv[nArg + 1]) : 20;
const dbPath = join(dataDir, "smoke-reingest.db");
void N; // 选样量由取证类别配比决定（12+2+4+2）；--n 预留给未来的配比参数化
if (existsSync(dbPath)) rmSync(dbPath);

const dataset = JSON.parse(readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"));

// --- 旧库覆盖率审计（选样 + 新旧对比共用） -------------------------------------

const oldDb = new SqliteGraph(join(dataDir, "memory.db"));
const STOP = new Set(
  "the a an of to in on at for with and or is are was were i you my your it its this that these those be been have has had do does did not no yes as by from will would can could should".split(" "),
);
function textOf(db, s) {
  if (s.type === "core:message") return String(s.value ?? "").toLowerCase();
  const d = db.getNode(s.dimension_id);
  return ((d?.key ?? "") + " " + JSON.stringify(s.value ?? "")).toLowerCase();
}
function statementsBySid(db) {
  const m = new Map();
  const retrievable = [
    ...db.queryNodes({ type: "core:statement" }),
    ...db.queryNodes({ type: "core:message" }),
  ];
  for (const s of retrievable) {
    for (const r of s.source_refs ?? []) {
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(s);
    }
  }
  return m;
}
function contentRate(db, bySid, answer, sid) {
  const words = String(answer)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  if (words.length === 0) return null;
  const hay = (bySid.get(sid) ?? []).map((s) => textOf(db, s)).join(" | ");
  if (!hay) return 0;
  const hit = words.filter((w) => hay.includes(w)).length;
  return hit / words.length;
}
const oldBySid = statementsBySid(oldDb);

// --- 选样：最缺料的助手题会话 + 多会话计数 + 知识更新 + 有料对照 ---------------

const targets = [];
const seenSids = new Set();
function push(kind, q) {
  for (const sid of q.answer_session_ids) {
    if (seenSids.has(sid)) return;
    const idx = q.haystack_session_ids.indexOf(sid);
    targets.push({
      kind,
      qid: q.question_id,
      sid,
      date: (q.haystack_dates[idx] ?? "").slice(0, 10),
      turns: q.haystack_sessions[idx] ?? [],
    });
    seenSids.add(sid);
    return; // 每题只取第一个金会话
  }
}
function pushSession(kind, qid, sid) {
  if (seenSids.has(sid)) return;
  const q = dataset.find((item) => item.question_id === qid);
  if (!q) return;
  const idx = q.haystack_session_ids.indexOf(sid);
  if (idx === -1) return;
  targets.push({
    kind,
    qid,
    sid,
    date: (q.haystack_dates[idx] ?? "").slice(0, 10),
    turns: q.haystack_sessions[idx] ?? [],
  });
  seenSids.add(sid);
}
const asst = dataset.filter((q) => q.question_type === "single-session-assistant" && !q.question_id.endsWith("_abs"));
const asstScored = asst
  .map((q) => ({ q, rate: contentRate(oldDb, oldBySid, q.answer, q.answer_session_ids[0]) ?? -1 }))
  .sort((a, b) => a.rate - b.rate);
asstScored.slice(0, 12).forEach(({ q }) => push("assistant-worst", q)); // 缺料最重
asstScored.slice(-2).forEach(({ q }) => push("assistant-control", q)); // 有料对照
const msWorst = dataset
  .filter((q) => q.question_type === "multi-session" && !q.question_id.endsWith("_abs"))
  .map((q) => ({ q, rate: Math.max(...q.answer_session_ids.map((s) => contentRate(oldDb, oldBySid, q.answer, s) ?? 0)) }))
  .sort((a, b) => a.rate - b.rate);
msWorst.slice(0, 4).forEach(({ q }) => push("multi-worst", q));
dataset
  .filter((q) => q.question_type === "knowledge-update" && !q.question_id.endsWith("_abs"))
  .slice(0, 2)
  .forEach((q) => push("knowledge-update", q));
[
  ["gpt4_68e94288", "answer_9793daa4_1"], // #PlankChallenge
  ["6e984302", "answer_88841f27_2"], // sculpting tools
  ["41698283", "answer_c7ddc051_2"], // 70-200mm lens
  ["ccb36322", "answer_f1fbb330"], // Spotify
  ["gpt4_cd90e484", "answer_aa930b56_2"], // goldfinches after birding
  ["gpt4_2f8be40d", "answer_e7b0637e_3"], // attended Jen and Tom's wedding
].forEach(([qid, sid]) => pushSession("event-regression", qid, sid));
console.log(`抽样 ${targets.length} 个会话 -> ${dbPath}\n`);

// --- 用新管线抽取入库（与 ingest.mjs 完全同款调用） -----------------------------

const graph = new SqliteGraph(dbPath);
const ctxBase = { created_by: "human:longmemeval_user", source_refs: [] };
function knownDims() {
  return (graph.queryNodes({ type: "core:dimension" }) ?? []).map((d) => ({
    key: d.key,
    description: typeof d.attributes?.description === "string" ? d.attributes.description : d.key,
    cardinality: d.cardinality ?? "multi",
  }));
}

let done = 0;
let skippedTotal = 0;
let langDroppedTotal = 0;
let eventKeptTotal = 0;
let eventDroppedTotal = 0;
for (const t of targets) {
  const transcript = t.turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  if (!transcript.trim()) continue;
  archiveConversationEvidence(graph, t.turns, {
    created_by: ctxBase.created_by,
    source_ref: t.sid,
    createdAt: t.date || undefined,
  });
  try {
    const eventCandidates = scanEventCandidates(transcript);
    const promptOpts = {
      transcript,
      knownDimensions: knownDims(),
      maxFacts: cfg.extraction.maxFactsPerSession,
      // 以下两项与 ingest.mjs 对齐（此前 smoke 缺 sessionDate，日期锚定没被质检到）
      sessionDate: t.date || undefined,
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
      // 与 ingest.mjs 相同的空回复重试（质检要检验的正是这套完整逻辑）
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
    // 与 ingest.mjs 相同的语言钉死·代码层（E5）：质检要覆盖它
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
      if (langDropped > 0) {
        console.log(`\n[warn] ${t.qid}: dropped ${langDropped} wrong-language entries (expected ${expectedLang})`);
      }
    }
    if (batch.skipped > 0) skippedTotal += batch.skipped;
    eventKeptTotal += batch.eventKept;
    eventDroppedTotal += batch.eventDropped;
    for (const c of batch.contents) {
      capture(graph, c, { ...ctxBase, source_refs: [t.sid], createdAt: t.date || undefined });
    }
    done += 1;
    process.stdout.write(`\r[${done}/${targets.length}]`);
  } catch (err) {
    console.log(`\n[warn] ${t.qid}: ${err.message.slice(0, 80)}`);
  }
}

// --- 免费对质：新库覆盖率 + saidBy 分布 -----------------------------------------

console.log(`\n\n=== 质检结果（金标内容库内覆盖率：旧库 -> 新库） ===`);
const newBySid = statementsBySid(graph);
const saidByStats = { assistant: 0, user: 0, absent: 0 };
const allNew = graph.queryNodes({ type: "core:statement" });
const evidenceNew = graph.queryNodes({ type: "core:message" });
for (const s of allNew) saidByStats[s.saidBy ?? "absent"] += 1;

let improved = 0;
const rows = [];
for (const t of targets) {
  const q = dataset.find((x) => x.question_id === t.qid);
  const oldRate = Math.max(...q.answer_session_ids.map((s) => contentRate(oldDb, oldBySid, q.answer, s) ?? 0));
  const newRate = Math.max(...q.answer_session_ids.map((s) => contentRate(graph, newBySid, q.answer, s) ?? 0));
  if (newRate > oldRate + 0.15) improved += 1;
  rows.push({ kind: t.kind, qid: t.qid.slice(0, 16), old: oldRate, neu: newRate, n: (newBySid.get(t.sid) ?? []).length });
}
for (const r of rows.sort((a, b) => b.neu - a.neu)) {
  console.log(
    `${r.kind.padEnd(18)} ${r.qid.padEnd(18)} 旧 ${(r.old * 100).toFixed(0).padStart(3)}% -> 新 ${(r.neu * 100).toFixed(0).padStart(3)}%  (本会话存 ${r.n} 条)`,
  );
}
console.log(`\n覆盖率显著提升的题: ${improved}/${targets.length}`);
console.log(`语言钉死: 丢弃错误语言语句 ${langDroppedTotal} 条`);
const langStats = { zh: 0, en: 0, es: 0, ambiguous: 0 };
for (const s of allNew) {
  const v = String(s.value ?? "");
  const l = detectLang(v);
  if (l === null) langStats.ambiguous += 1;
  else langStats[l] += 1;
}
console.log(`新库语言分布: zh=${langStats.zh} en=${langStats.en} es=${langStats.es} 歧义=${langStats.ambiguous}`);
console.log(`新库 saidBy 分布: assistant=${saidByStats.assistant} user=${saidByStats.user} 无=${saidByStats.absent}`);
console.log(`新库总语句: ${allNew.length} | 跳过的坏条目: ${skippedTotal}`);
console.log(`新库逐字证据块: ${evidenceNew.length}`);
console.log(`事件裁决: keep=${eventKeptTotal} drop=${eventDroppedTotal}`);
graph.close();
oldDb.close();
console.log("\n临时库保留在 data/smoke-reingest.db（可手动检查），不碰 memory.db");
