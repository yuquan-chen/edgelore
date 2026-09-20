// edgelore — product/benchmark boundary guard (the "soul test").
//
// src/ is the PRODUCT. It must contain universal mechanisms only — never
// benchmark-specific concepts, dataset artifacts, or case-specific content.
// Benchmark vocabulary and dataset wiring live in benchmark/ exclusively.
// Discoveries FROM the benchmark may prioritize work; implementations must
// be general medicine, not cosplay for one patient.
//
// Enforced here mechanically: strip comments from every src/*.ts file, then
// assert no benchmark/dataset vocabulary and no case-specific keywords
// survive in code or string literals (prompts included).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Benchmark/dataset vocabulary that must never appear in product code. */
const FORBIDDEN = [
  /\bhaystack\b/i,
  /\blongmemeval\b/i,
  /\bquestion_date\b/i,
  /\boracle\b/i,
  /\bstage1\b/i,
  /\bstage2\b/i,
  /\bgold\b/i, // gold answers / gold sessions
  /\bjudge\b/i, // the benchmark judge (gate's "to judge" verb is fine — comments stripped)
];

/** Case-specific keywords from known benchmark incidents — the anti-overfitting lock. */
const CASE_KEYWORDS = /yoga|therapy\b|apex|harvard|jessica|stand.?mixer|billie|fajita|tiffany|rotterdam/i;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Strip block comments, line comments, and JSDoc — only code & string literals remain. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

test("boundary: src/ contains no benchmark or dataset vocabulary outside comments", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of FORBIDDEN) {
      if (pattern.test(code)) violations.push(`${file}: matches ${pattern}`);
    }
  }
  assert.deepEqual(violations, [], `product code must stay benchmark-agnostic:\n${violations.join("\n")}`);
});

test("boundary: src/ prompts and code contain no case-specific keywords", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const code = readFileSync(file, "utf8");
    const match = CASE_KEYWORDS.exec(code);
    if (match) violations.push(`${file}: case keyword "${match[0]}"`);
  }
  assert.deepEqual(violations, [], `case-specific content leaked into product:\n${violations.join("\n")}`);
});

test("boundary: every AskPrompt rule is a universal principle (spot-check the core ones)", async () => {
  const { buildAskPrompt } = await import("../src/agent/ask.js");
  const prompt = buildAskPrompt("q", ["sample — 1 entry:"]);
  // 通用性抽查：这些规则必须对"任何陌生用户"都成立
  assert.match(prompt, /Never invent facts/);
  assert.match(prompt, /LATEST USER-stated/);
  assert.match(prompt, /Never invent|no entry is even loosely related/);
  // 拒答契约存在（诚实性）
  assert.match(prompt, /ONLY if no entry is even loosely related/);
});
