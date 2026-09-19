// edgelore · 精准补漏 — 只处理 memory.db 里缺失的会话。
// 从 missing-sessions.json 读取缺失列表，逐个抽取+入库。
// Usage: node benchmark/longmemeval/fill-gaps.mjs

import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  OpenAiCompatDriver,
  OpenAiCompatEmbeddingDriver,
  SqliteVectorStore,
  parseJsonReply,
  capture,
} from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv(join(here, "..", "..", ".env.local"));
const BASE = env.OPENAI_BASE_URL ?? "https://api.dogrouter.ai/v1";
const KEY = env.OPENAI_API_KEY;
const MODEL = env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";

const dataset = JSON.parse(readFileSync(join(here, "data", "longmemeval_oracle.json"), "utf8"));
const missingIds = new Set(JSON.parse(readFileSync(join(here, "data", "missing-sessions.json"), "utf8")));

const graph = new SqliteGraph(join(here, "data", "memory.db"));
const driver = new OpenAiCompatDriver({ baseUrl: BASE, apiKey: KEY, model: MODEL, maxTokens: 16000, extraBody: { thinking: { type: "disabled" } } });
const vectors = new SqliteVectorStore(graph);
const embedder = env.EDGELORE_EMBEDDING_MODEL
  ? new OpenAiCompatEmbeddingDriver({
      baseUrl: env.OPENAI_EMBEDDING_BASE_URL ?? BASE,
      apiKey: env.OPENAI_EMBEDDING_API_KEY ?? KEY,
      model: env.EDGELORE_EMBEDDING_MODEL,
      dimensions: Number(env.EDGELORE_EMBEDDING_DIMENSIONS ?? 1024),
    })
  : undefined;

// 收集缺失会话的数据
const targets = [];
for (const q of dataset) {
  q.haystack_session_ids.forEach((sid, i) => {
    if (missingIds.has(sid) && !targets.some(t => t.sid === sid)) {
      targets.push({
        sid,
        date: (q.haystack_dates[i] ?? "").slice(0, 10),
        turns: q.haystack_sessions[i] ?? [],
      });
    }
  });
}

console.log(`需要补录: ${targets.length} 个会话\n`);

const ctx = { created_by: "human:longmemeval_user", source_refs: [] };

function knownDims() {
  return (graph.queryNodes({ type: "core:dimension" }) ?? []).map((d) => ({
    key: d.key,
    description: typeof d.attributes?.description === "string" ? d.attributes.description : d.key,
    cardinality: d.cardinality ?? "multi",
  }));
}

function batchPrompt(transcript, known) {
  const knownStr = known.length ? known.map((k) => JSON.stringify(k)).join("\n") : "(none yet)";
  return [
    "You are extracting durable long-term memories from ONE session of a conversation.",
    "Extract every fact worth remembering months later. Skip greetings and transient chatter.",
    "",
    "Known dimensions (REUSE if same slot):",
    knownStr,
    "",
    "For each fact output one object:",
    '{ "dimensionKey": "<known key or NEW:lowerCamelCase>",',
    '  "value": <bare NUMBER for quantities, else short string in original language>,',
    '  "dimensionDescription": "<one line in original language, NEW: only>",',
    '  "cardinality": "<single|multi, NEW: only>",',
    '  "unit": "<optional>" }',
    "",
    "Extract at most 12 facts. If nothing worth remembering, respond { \"contents\": [] }.",
    "",
    "Session transcript:",
    transcript,
  ].join("\n");
}

let stored = 0, errors = 0;
const t0 = Date.now();

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const transcript = t.turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  if (!transcript.trim()) { console.log(`${i + 1}/${targets.length} ${t.sid}: 空会话，跳过`); continue; }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`[${i + 1}/${targets.length}] ${t.sid} (${elapsed}s)...`);

  try {
    ctx.source_refs = [t.sid];
    const reply = await driver.complete(batchPrompt(transcript, knownDims()));
    const parsed = parseJsonReply(reply);
    const contents = (parsed.contents ?? []).map((c) => {
      let key = c.dimensionKey;
      if (key.startsWith("NEW:")) key = key.slice(4);
      const out = { dimensionKey: key, value: c.value };
      if (c.cardinality === "single" || c.cardinality === "multi") out.cardinality = c.cardinality;
      if (typeof c.unit === "string" && c.unit) out.unit = c.unit;
      if (typeof c.dimensionDescription === "string" && c.dimensionDescription.trim()) out.description = c.dimensionDescription.trim();
      if (typeof out.value === "string" && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(out.value.trim())) out.value = Number(out.value.trim());
      return out;
    });

    for (const c of contents) {
      capture(graph, c, { ...ctx, createdAt: t.date || undefined });
      stored++;
    }
    // embed new statements
    if (embedder) {
      const stmts = graph.queryNodes({ type: "core:statement" }).filter((s) => s.source_refs.includes(t.sid));
      if (stmts.length > 0) {
        const texts = stmts.map((s) => {
          const dim = graph.getNode(s.dimension_id);
          return `${dim?.key ?? ""} ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""}`;
        });
        const vecs = await embedder.embed(texts);
        stmts.forEach((s, j) => vectors.put(s.id, vecs[j]));
      }
    }
    console.log(` ✓ ${contents.length} 条记忆`);
  } catch (err) {
    errors++;
    console.log(` ✗ ${err.message.slice(0, 80)}`);
  }
}

console.log(`\n完成: ${stored} 条记忆入库, ${errors} 个错误`);
