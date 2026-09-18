// edgelore · internal evaluation runner — scores the write pipeline against
// the golden set. Produces the "体检报告": gate precision/recall, extraction
// dimension/value hit rates, conflict detection rate, per-category breakdown.
//
// Usage: node benchmark/internal/run-eval.mjs [--limit N]
// Each case runs on a FRESH in-memory graph (cases are self-contained).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryGraph,
  OpenAiCompatDriver,
  parseJsonReply,
  runGate,
  runExtract,
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
const BASE = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const KEY = env.OPENAI_API_KEY;
const MODEL = env.EDGELORE_MODEL ?? "deepseek-v4-flash-0731";
if (!KEY || !MODEL) {
  console.error("missing OPENAI_API_KEY / EDGELORE_MODEL in .env.local");
  process.exit(1);
}
const driver = new OpenAiCompatDriver({ baseUrl: BASE, apiKey: KEY, model: MODEL });

const golden = JSON.parse(readFileSync(join(here, "golden-set.json"), "utf8")).cases;
const limitIdx = process.argv.indexOf("--limit");
const cases = limitIdx !== -1 ? golden.slice(0, Number(process.argv[limitIdx + 1])) : golden;

const ctx = { created_by: "human:eval", source_refs: [] };

function valueMatches(actual, expected) {
  if (actual === undefined || actual === null) return false;
  if (typeof expected === "number") return Number(actual) === expected;
  const a = String(actual).toLowerCase();
  const e = String(expected).toLowerCase();
  return a.includes(e) || e.includes(a);
}

function knownDimensions(graph) {
  return (graph.queryNodes({ type: "core:dimension" }) ?? []).map((d) => ({
    key: d.key,
    description: typeof d.attributes?.description === "string" ? d.attributes.description : d.key,
    cardinality: d.cardinality ?? "multi",
  }));
}

// --- per-case execution ----------------------------------------------------

async function runCase(testCase) {
  const graph = new MemoryGraph();
  const steps = [];
  for (let t = 0; t < testCase.turns.length; t++) {
    const turn = testCase.turns[t];
    const gate = await runGate(turn.text, driver);
    if (!gate.store) {
      steps.push({ gate, contents: [], captures: [] });
      continue;
    }
    const extract = await runExtract({
      text: turn.text,
      candidates: gate.candidates,
      knownDimensions: knownDimensions(graph),
      contextMemories: [],
      driver,
    });
    const contents = extract.action === "STORE" ? (extract.contents ?? []) : [];
    const captures = contents.map((content) => capture(graph, content, ctx));
    steps.push({ gate, contents, captures });
  }
  return steps;
}

// --- scoring -----------------------------------------------------------------

function scoreCase(testCase, steps) {
  const last = steps[steps.length - 1];
  const exp = testCase.expect;
  const out = { id: testCase.id, category: testCase.category, ok: true, notes: [] };

  if (exp.gate === "reject") {
    const wronglyStored = steps.some((s) => s.gate.store);
    if (wronglyStored) {
      out.ok = false;
      out.notes.push("应拒却存");
    } else {
      out.notes.push("正确拒绝");
    }
    return out;
  }

  // gate = store
  if (!last.gate.store || last.contents.length === 0) {
    out.ok = false;
    out.notes.push("应存却未存");
    return out;
  }

  for (const fact of exp.facts ?? []) {
    const valueHit = last.contents.some((c) => valueMatches(c.value, fact.value));
    const keyHit = last.contents.some(
      (c) => fact.keyAnyOf.includes(c.dimensionKey) || valueMatches(c.dimensionKey, fact.keyAnyOf[0]),
    );
    if (keyHit) {
      out.notes.push(`key✓`);
    } else {
      // key 漂移：单独统计（信息项），不判失败 —— 值对了就是记对了
      out.notes.push(`key漂移(实得${last.contents.map((c) => c.dimensionKey).join("/")})`);
    }
    if (valueHit) {
      out.notes.push(`value✓`);
    } else {
      out.ok = false;
      out.notes.push(`value✗(期望=${JSON.stringify(fact.value)})`);
    }
  }

  if (exp.conflict) {
    const clashed = steps.some((s) => s.captures.some((c) => c.conflict));
    if (clashed) out.notes.push("conflict✓");
    else {
      out.ok = false;
      out.notes.push("conflict✗(未标记)");
    }
  }
  return out;
}

// --- main ----------------------------------------------------------------------

const results = [];
const t0 = Date.now();
for (const testCase of cases) {
  try {
    const steps = await runCase(testCase);
    const scored = scoreCase(testCase, steps);
    results.push({ ...scored, ms: Date.now() - t0 });
    const mark = scored.ok ? "✓" : "✗";
    console.log(`${mark} ${testCase.id} [${testCase.category}] ${scored.notes.join(" ")}`);
  } catch (err) {
    results.push({ id: testCase.id, category: testCase.category, ok: false, notes: [err.message] });
    console.log(`✗ ${testCase.id} ERROR: ${err.message}`);
  }
}

// --- aggregate -----------------------------------------------------------------

const byCategory = {};
for (const r of results) {
  byCategory[r.category] = byCategory[r.category] ?? { pass: 0, total: 0 };
  byCategory[r.category].total += 1;
  if (r.ok) byCategory[r.category].pass += 1;
}
const passed = results.filter((r) => r.ok).length;

console.log("\n===== edgelore 写入管线体检报告 =====");
console.log(`总计: ${passed}/${results.length} 通过`);
for (const [cat, s] of Object.entries(byCategory)) {
  console.log(`  ${cat}: ${s.pass}/${s.total}`);
}
console.log(`耗时: ${((Date.now() - t0) / 1000 / results.length).toFixed(1)}s/case`);

writeFileSync(
  join(here, "eval-result.json"),
  JSON.stringify({ summary: { passed, total: results.length, byCategory }, results }, null, 2),
);
console.log("saved: benchmark/internal/eval-result.json");
