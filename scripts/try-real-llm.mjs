// edgelore — real-LLM trial harness (NOT part of src/; trial only).
//
// Drives the full pipeline — gate -> extract -> capture — against a real
// OpenAI-compatible endpoint (dogrouter relay), feeding 10 human sentences
// and printing every verdict. Purpose: validate the #17 prompts with real
// language before promoting the driver into src/agent/.
//
// Usage:  npm run build && node scripts/try-real-llm.mjs
// Config: reads .env.local (DOGROUTER_API_KEY / DOGROUTER_BASE_URL / EDGELORE_MODEL)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryGraph, runGate, runExtract, capture } from "../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// --- env -------------------------------------------------------------------

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv(join(here, "..", ".env.local"));
const BASE_URL = env.OPENAI_BASE_URL ?? env.DOGROUTER_BASE_URL ?? "https://api.dogrouter.ai/v1";
const API_KEY = env.OPENAI_API_KEY ?? env.DOGROUTER_API_KEY;
const MODEL = env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";
if (!API_KEY) {
  console.error("missing OPENAI_API_KEY in .env.local");
  process.exit(1);
}

// --- LlmDriver over an OpenAI-compatible chat endpoint -----------------------
// Same shape as src/agent/llm-driver.ts LlmDriver: complete(prompt) -> string.

function makeDriver() {
  return {
    async complete(prompt) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 700,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`unexpected API shape: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return content;
    },
  };
}

// --- runtime context recipes (what the future runtime.ts will do) ------------

function knownDimensions(graph) {
  return graph.queryNodes({ type: "core:dimension" }).map((d) => ({
    key: d.key,
    description: d.key,
    cardinality: d.cardinality ?? "multi",
    ...(d.unit ? { unit: d.unit } : {}),
  }));
}

function contextMemories(graph) {
  return graph.queryNodes({ type: "core:statement" }).map((s) => {
    const dim = graph.getNode(s.dimension_id);
    return `${dim?.key ?? "?"} = ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} (${s.state})`;
  });
}

// --- the 10-sentence acceptance set ------------------------------------------
// mix: 2 pleasantries (expect NOOP), 3 facts, 2 constraints, 1 lesson,
// 2 transient states (expect NOOP)

const TURNS = [
  "你好呀，今天天气真不错！",
  "谢谢啦，辛苦了～",
  "我们项目的预算上限是 5000 元。",
  "项目负责人是 charles。",
  "数据库我们决定用 PostgreSQL，不用 MongoDB。",
  "以后提交代码之前必须先跑一遍 npm test。",
  "上次数据库迁移失败就是因为 mock 测试没连真实库，以后凡是涉及数据库行为的功能都要用真实实例验证一遍。",
  "我今天有点累，先到这吧。",
  "哎网速好慢啊。",
  "以后跟我交流用中文，回复尽量简洁一点。",
];

// --- main --------------------------------------------------------------------

const driver = makeDriver();
const graph = new MemoryGraph();
const ctx = { created_by: "human:charles", source_refs: [] };

console.log(`model: ${MODEL}\nendpoint: ${BASE_URL}\n`);

// smoke ping first — fail fast on bad key / bad model name
try {
  const pong = await driver.complete('Reply with exactly one word: OK');
  console.log(`smoke ping: ${pong.trim().slice(0, 40)}\n`);
} catch (err) {
  console.error(`smoke ping FAILED: ${err.message}`);
  process.exit(1);
}

const outcomes = { stored: 0, noop: 0, error: 0 };

for (const [i, text] of TURNS.entries()) {
  const label = `#${String(i + 1).padStart(2, "0")}`;
  ctx.source_refs = [`trial:msg:${i + 1}`];
  const t0 = Date.now();
  try {
    const gate = await runGate(text, driver);
    if (!gate.store) {
      outcomes.noop += 1;
      console.log(`${label} NOOP  (${Date.now() - t0}ms)  “${text}”`);
      console.log(`      gate: ${gate.reason ?? "(no reason)"}`);
      continue;
    }
    const extract = await runExtract({
      text,
      candidates: gate.candidates,
      knownDimensions: knownDimensions(graph),
      contextMemories: contextMemories(graph),
      driver,
    });
    if (extract.action !== "STORE" || !extract.contents?.length) {
      outcomes.noop += 1;
      console.log(`${label} NOOP  (${Date.now() - t0}ms)  “${text}”`);
      console.log(`      gate said store, but extract found nothing`);
      continue;
    }
    outcomes.stored += 1;
    console.log(`${label} STORE (${Date.now() - t0}ms)  “${text}”`);
    for (const content of extract.contents) {
      const r = capture(graph, content, ctx);
      const flags = [
        r.created ? "new-dim" : null,
        r.deduplicated ? "dedup" : null,
        r.conflict ? "CONFLICT" : null,
      ].filter(Boolean).join(",") || "accepted";
      console.log(`      -> ${content.dimensionKey} = ${JSON.stringify(content.value)}${content.unit ? ` [${content.unit}]` : ""} (${flags})`);
    }
  } catch (err) {
    outcomes.error += 1;
    console.log(`${label} ERROR (${Date.now() - t0}ms)  “${text}”`);
    console.log(`      ${err.message}`);
  }
}

// --- final graph state -------------------------------------------------------

console.log("\n===== summary =====");
console.log(`stored: ${outcomes.stored}   noop: ${outcomes.noop}   error: ${outcomes.error}   (total ${TURNS.length})`);
console.log("\ndimensions in graph:");
for (const d of graph.queryNodes({ type: "core:dimension" })) {
  const stmts = graph.queryNodes({ type: "core:statement" }).filter((s) => s.dimension_id === d.id);
  const vals = stmts.map((s) => `${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} [${s.state}]`).join("; ");
  console.log(`  ${d.key} (${d.cardinality}): ${vals}`);
}
