// edgelore · Agent Memory layer — extract tests.
//
// Covers the frozen contract: known-dimension mapping, NEW:camelCase keys
// (prefix stripped before returning CaptureContent), fabrication guards
// (unknown keys / missing values fail loud), multi-fact arrays, the empty-
// candidates short-circuit (driver never called), and prompt assembly
// (dimensions / context / candidates / text injected, language policy present).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "../../src/agent/errors.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { buildBatchExtractionPrompt, buildExtractPrompt, type KnownDimension } from "../../src/agent/prompt.js";
import { normalizeBatchContents, runExtract } from "../../src/agent/extract.js";

const KNOWN: KnownDimension[] = [
  { key: "budget", description: "项目预算", cardinality: "single", unit: "CNY" },
  { key: "theme", description: "界面主题偏好", cardinality: "single" },
];

/** Build a one-reply driver whose reply is `{ contents: [...] }`. */
function contentsDriver(contents: unknown[]): MockDriver {
  return new MockDriver([JSON.stringify({ contents })]);
}

test("extract: known dimension maps by key, optional fields stay absent", async () => {
  const driver = contentsDriver([{ dimensionKey: "budget", value: 5000 }]);
  const r = await runExtract({
    text: "预算 5000",
    candidates: ["预算 5000"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.length, 1);
  assert.equal(r.contents?.[0]?.dimensionKey, "budget");
  assert.equal(r.contents?.[0]?.value, 5000);
  // Optional fields stay untouched — capture owns the defaults (multi).
  assert.equal(r.contents?.[0]?.cardinality, undefined);
  assert.equal(r.contents?.[0]?.unit, undefined);
});

test("extract: NEW: prefix is stripped before returning CaptureContent", async () => {
  const driver = contentsDriver([
    { dimensionKey: "NEW:ownerName", value: "charles", cardinality: "single" },
  ]);
  const r = await runExtract({
    text: "负责人是 charles",
    candidates: ["负责人是 charles"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.[0]?.dimensionKey, "ownerName"); // NEW: never leaks out
  assert.equal(r.contents?.[0]?.cardinality, "single");
});

test("extract: multi-fact array passes through in order", async () => {
  const driver = contentsDriver([
    { dimensionKey: "budget", value: 5000, unit: "CNY" },
    { dimensionKey: "NEW:ownerName", value: "charles" },
  ]);
  const r = await runExtract({
    text: "预算 5000，负责人 charles",
    candidates: ["预算 5000", "负责人 charles"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.length, 2);
  assert.equal(r.contents?.[0]?.dimensionKey, "budget");
  assert.equal(r.contents?.[0]?.unit, "CNY");
  assert.equal(r.contents?.[1]?.dimensionKey, "ownerName");
});

test("extract: unknown key without NEW: throws AgentError (anti-fabrication)", async () => {
  const driver = contentsDriver([{ dimensionKey: "budgt", value: 1 }]);
  await assert.rejects(
    runExtract({
      text: "t",
      candidates: ["c"],
      knownDimensions: KNOWN,
      contextMemories: [],
      driver,
    }),
    AgentError,
  );
});

test("extract: NEW: with non-lowerCamelCase key throws AgentError", async () => {
  const driver = contentsDriver([{ dimensionKey: "NEW:Owner Name", value: "x" }]);
  await assert.rejects(
    runExtract({
      text: "t",
      candidates: ["c"],
      knownDimensions: [],
      contextMemories: [],
      driver,
    }),
    AgentError,
  );
});

test("extract: content without a value throws AgentError", async () => {
  const driver = contentsDriver([{ dimensionKey: "budget" }]);
  await assert.rejects(
    runExtract({
      text: "t",
      candidates: ["c"],
      knownDimensions: KNOWN,
      contextMemories: [],
      driver,
    }),
    AgentError,
  );
});

test("extract: empty candidates short-circuits to NOOP without calling the driver", async () => {
  const driver = new MockDriver([]); // would throw if the driver were called
  const r = await runExtract({
    text: "t",
    candidates: [],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "NOOP");
  assert.equal(driver.remaining, 0); // proves no model call happened
});

test("extract: empty contents array yields NOOP", async () => {
  const driver = contentsDriver([]);
  const r = await runExtract({
    text: "t",
    candidates: ["c"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "NOOP");
});

test("extract: non-JSON reply throws AgentError", async () => {
  const driver = new MockDriver(["我觉得应该存预算。"]);
  await assert.rejects(
    runExtract({
      text: "t",
      candidates: ["c"],
      knownDimensions: KNOWN,
      contextMemories: [],
      driver,
    }),
    AgentError,
  );
});

test("extract: numeric-string values are coerced to numbers (constraint visibility)", async () => {
  const driver = contentsDriver([{ dimensionKey: "budget", value: "5000", unit: "CNY" }]);
  const r = await runExtract({
    text: "预算 5000",
    candidates: ["预算 5000"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.contents?.[0]?.value, 5000);
  assert.equal(typeof r.contents?.[0]?.value, "number"); // M1 reads numbers only
});

test("extract: decimal strings coerce, plain text stays untouched", async () => {
  const driver = contentsDriver([
    { dimensionKey: "budget", value: " 99.5 " },
    { dimensionKey: "theme", value: "深色" },
  ]);
  const r = await runExtract({
    text: "t",
    candidates: ["a", "b"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.contents?.[0]?.value, 99.5);
  assert.equal(r.contents?.[1]?.value, "深色");
  assert.equal(typeof r.contents?.[1]?.value, "string");
});

test("extract: leading-zero strings stay strings (identifier-like, not quantities)", async () => {
  const driver = contentsDriver([{ dimensionKey: "NEW:agentCode", value: "007" }]);
  const r = await runExtract({
    text: "我的代号是 007",
    candidates: ["代号是 007"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.contents?.[0]?.value, "007");
  assert.equal(typeof r.contents?.[0]?.value, "string");
});

test("extract: prompt injects dimensions, context, candidates, text, and key policy", () => {
  const p = buildExtractPrompt({
    text: "全文在这里",
    candidates: ["候选A"],
    knownDimensions: KNOWN,
    contextMemories: ["已有: budget=3000"],
  });
  assert.match(p, /"budget"/); // known dimensions serialized
  assert.match(p, /项目预算/); // human-language description present
  assert.match(p, /已有: budget=3000/); // context memories injected
  assert.match(p, /候选A/); // candidates injected
  assert.match(p, /全文在这里/); // full turn injected
  assert.match(p, /subject-free/); // language/identity policy from the triple discussion
  assert.match(p, /NEW:/); // key protocol present
  assert.match(p, /NEVER output provenance/); // field trichotomy enforced in words
  assert.match(p, /NEVER a quoted "5000"/); // value shape contradiction fixed
  assert.match(p, /"value": 5000/); // few-shot shows the unquoted-number shape
});

test("extract: dimensionDescription becomes content.description (anti-drift)", async () => {
  const driver = contentsDriver([
    { dimensionKey: "NEW:owner", value: "charles", dimensionDescription: "项目负责人" },
  ]);
  const r = await runExtract({
    text: "负责人是 charles",
    candidates: ["负责人是 charles"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.contents?.[0]?.description, "项目负责人");
});

test("extract: non-string dimensionDescription throws AgentError", async () => {
  const driver = contentsDriver([{ dimensionKey: "NEW:owner", value: "x", dimensionDescription: 42 }]);
  await assert.rejects(
    runExtract({ text: "t", candidates: ["c"], knownDimensions: [], contextMemories: [], driver }),
    AgentError,
  );
});

test("extract: similarDimensions are injected into the prompt with reuse pressure", () => {
  const p = buildExtractPrompt({
    text: "t",
    candidates: ["c"],
    knownDimensions: [],
    similarDimensions: [{ key: "owner", description: "项目负责人", cardinality: "single" }],
    contextMemories: [],
  });
  assert.match(p, /SAME slot, REUSE its key/);
  assert.match(p, /"owner"/);
  assert.match(p, /项目负责人/);
});

// --- W3: saidBy attribution + batch normalization -----------------------------

test("extract: saidBy passes through to CaptureContent", async () => {
  const driver = contentsDriver([
    { dimensionKey: "NEW:databaseChoice", value: "PostgreSQL", saidBy: "assistant" },
    { dimensionKey: "budget", value: 5000, saidBy: "user" },
  ]);
  const r = await runExtract({
    text: "助手推荐了 PostgreSQL；预算 5000",
    candidates: ["助手推荐了 PostgreSQL", "预算 5000"],
    knownDimensions: KNOWN,
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.[0]?.saidBy, "assistant");
  assert.equal(r.contents?.[1]?.saidBy, "user");
});

test("extract: invalid saidBy fails loud", async () => {
  const driver = contentsDriver([{ dimensionKey: "budget", value: 1, saidBy: "system" }]);
  await assert.rejects(
    () =>
      runExtract({
        text: "x",
        candidates: ["x"],
        knownDimensions: KNOWN,
        contextMemories: [],
        driver,
      }),
    AgentError,
  );
});

test("batch: normalizeBatchContents accepts bare camelCase keys without NEW: (lenient)", () => {
  const { contents } = normalizeBatchContents([
    { dimensionKey: "weddingAttended", value: "Sarah 的婚礼", saidBy: "user" },
    { dimensionKey: "NEW:smokerPurchase", value: 1, cardinality: "single" },
    { dimensionKey: "budget", value: "5000" }, // numeric string -> number
  ]);
  assert.equal(contents.length, 3);
  assert.equal(contents[0]?.dimensionKey, "weddingAttended");
  assert.equal(contents[0]?.saidBy, "user");
  assert.equal(contents[1]?.dimensionKey, "smokerPurchase"); // NEW: stripped
  assert.equal(contents[1]?.cardinality, "single");
  assert.equal(contents[2]?.value, 5000);
});

test("batch: malformed entries are SKIPPED, never fatal (one bad field != lost session)", () => {
  const { contents, skipped } = normalizeBatchContents([
    { dimensionKey: "good", value: 1, unit: "" }, // empty unit -> omitted, entry kept
    { dimensionKey: "", value: 1 }, // no key -> skipped
    { dimensionKey: "ok key!", value: 1 }, // malformed key -> skipped
    { dimensionKey: "good2", value: "x", saidBy: "ai" }, // bad saidBy -> kept, unattributed
    { dimensionKey: "good3" }, // no value -> skipped
    "not an object", // skipped
  ]);
  assert.equal(contents.length, 2);
  assert.equal(skipped, 4);
  assert.equal(contents[0]?.unit, undefined); // empty string vanished
  assert.equal(contents[0]?.dimensionKey, "good");
  assert.equal(contents[1]?.saidBy, undefined); // bad attribution dropped, fact kept
  assert.equal(contents[1]?.dimensionKey, "good2");
});

test("batch: buildBatchExtractionPrompt carries both-speaker attribution and no bias", () => {
  const p = buildBatchExtractionPrompt({
    transcript: "[user] hi",
    knownDimensions: KNOWN,
    maxFacts: 12,
  });
  assert.match(p, /BOTH sides of the conversation/);
  assert.match(p, /saidBy/);
  assert.match(p, /"assistant"/);
  assert.ok(!/the assistant only helps/.test(p), "the old bias must be gone");
  assert.match(p, /at most 12 facts/);
  assert.match(p, /LAST RESORT/); // anti-empty-list clause
  assert.match(p, /"budget"/); // known dimensions injected
  const retry = buildBatchExtractionPrompt({
    transcript: "[user] hi",
    knownDimensions: KNOWN,
    maxFacts: 12,
    extraFragments: ["NOTE: your previous reply was EMPTY."],
  });
  assert.match(retry, /previous reply was EMPTY/);
});

test("batch: buildBatchExtractionPrompt carries both-speaker attribution and no bias", () => {
  const p = buildBatchExtractionPrompt({
    transcript: "[user] hi",
    knownDimensions: KNOWN,
    maxFacts: 12,
  });
  assert.match(p, /BOTH sides of the conversation/);
  assert.match(p, /saidBy/);
  assert.match(p, /"assistant"/);
  assert.ok(!/the assistant only helps/.test(p), "the old bias must be gone");
  assert.match(p, /at most 12 facts/);
  assert.match(p, /"budget"/); // known dimensions injected
});

test("batch: lowercase new: prefix is stripped too (model drift)", () => {
  const { contents, skipped } = normalizeBatchContents([
    { dimensionKey: "new:carFirstServiceDate", value: "2023-05-01" },
    { dimensionKey: "NEW:smokerPurchase", value: 1 },
  ]);
  assert.equal(skipped, 0);
  assert.equal(contents[0]?.dimensionKey, "carFirstServiceDate");
  assert.equal(contents[1]?.dimensionKey, "smokerPurchase");
});

test("batch: session date anchors relative-time resolution in examples and preamble", () => {
  const p = buildBatchExtractionPrompt({
    transcript: "[user] hi",
    knownDimensions: KNOWN,
    maxFacts: 12,
    sessionDate: "2023-05-01",
  });
  assert.match(p, /Session date: 2023-05-01/); // 真实锚点
  assert.match(p, /Two months ago I started learning French/); // few-shot 教日期换算
  assert.match(p, /\(from 2023-03-01\)/); // 换算结果在示例里示范
  assert.match(p, /never\s+invent one|never invent/); // 防幻觉条款
  const p2 = buildBatchExtractionPrompt({ transcript: "x", knownDimensions: [], maxFacts: 5 });
  assert.match(p2, /Session date: \(unknown\)/);
});
