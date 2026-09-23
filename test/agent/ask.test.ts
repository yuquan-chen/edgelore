// edgelore · Agent Memory layer — answering-layer tests (W4).
//
// Covers the ask prompt contract: the Today line appears only when `now` is
// provided, the counting rule tells the model to trust grouped headers, and
// both context paths (retrieval and the digest fallback) share the same
// line format — @date markers and assistant speaker suffixes included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph } from "../../src/model/store.js";
import { capture } from "../../src/agent/capture.js";
import { ABSTAIN, answerQuestion, buildAskPrompt } from "../../src/agent/ask.js";
import type { LlmDriver } from "../../src/agent/llm-driver.js";

const ctx = { created_by: "human:charles", source_refs: ["t:1"] };

/** Driver that records the prompt it was given and replies verbatim. */
function capturingDriver(reply: string): { driver: LlmDriver; prompt(): string } {
  const state = { captured: "" };
  const driver = {
    async complete(prompt: string): Promise<string> {
      state.captured = prompt;
      return reply;
    },
  };
  return { driver: driver as unknown as LlmDriver, prompt: () => state.captured };
}

test("ask: the Today line appears only when now is provided", () => {
  const withNow = buildAskPrompt("下周做什么", ["trip — 2 entries:"], "2023-04-10");
  assert.match(withNow, /Today is 2023-04-10\./);
  const without = buildAskPrompt("下周做什么", ["trip — 2 entries:"]);
  assert.ok(!/Today is/.test(without));
});

test("ask: rule 4 instructs the model to trust grouped header counts", () => {
  const p = buildAskPrompt("参加过几场婚礼", ["weddings_attended — 3 entries:"]);
  assert.match(p, /OWN count/);
  assert.match(p, /omitted/);
  assert.match(p, /superseded and tentative entries still/);
});

test("ask: digest fallback shares the retrieval line format (@date + speaker)", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "alice" }, ctx);
  capture(graph, { dimensionKey: "db", value: "PG", saidBy: "assistant" }, ctx);
  const { driver, prompt } = capturingDriver("alice");
  const r = await answerQuestion(graph, "负责人是谁？", driver);
  assert.equal(r.abstained, false);
  assert.equal(r.usedMemories.length, 2);
  // @date on every line (the old digest dropped it — fixed in W4)
  for (const line of r.usedMemories) assert.match(line, /@\d{4}-\d{2}-\d{2}\]/);
  const assistantLine = r.usedMemories.find((l) => l.includes("PG"));
  assert.match(assistantLine ?? "", /\(assistant\)/);
  // the assembled prompt carried the memories verbatim (digest = flat lines)
  assert.match(prompt(), /= "alice" \[accepted @\d{4}-\d{2}-\d{2}\]/);
  assert.match(prompt(), /= "PG".*\(assistant\)/);
});

test("ask: abstention is detected by exact marker match", async () => {
  const graph = new MemoryGraph();
  const { driver } = capturingDriver(ABSTAIN);
  const r = await answerQuestion(graph, "火星上有几个人？", driver);
  assert.equal(r.answer, ABSTAIN);
  assert.equal(r.abstained, true);
});

test("ask: now is forwarded into the assembled prompt through answerQuestion", async () => {
  const graph = new MemoryGraph();
  capture(graph, { dimensionKey: "owner", value: "alice" }, ctx);
  const { driver, prompt } = capturingDriver("alice");
  await answerQuestion(graph, "负责人是谁？", driver, { now: "2023-04-10" });
  assert.match(prompt(), /Today is 2023-04-10\./);
});

// --- A2: rule 3 原则化措辞 -----------------------------------------------------

test("ask: rule 3 states the recency principle without referencing any benchmark case", () => {
  const p = buildAskPrompt("q", ["x — 1 entry:"]);
  assert.match(p, /LATEST USER-stated/);
  assert.match(p, /even if it is still tentative/);
  assert.match(p, /never overrides an accepted user value/);
  assert.match(p, /same real-world property/);
  assert.match(p, /grouping\/key drift/);
  assert.ok(!/yoga|therapy|apex|harvard/i.test(p), "prompt must stay case-agnostic");
});

test("ask: aggregation distinguishes summed amounts from elapsed wall-clock time", () => {
  const p = buildAskPrompt("q", ["x — 1 entry:"]);
  assert.match(p, /total across named activities\/items/);
  assert.match(p, /add their recorded durations, costs, or/);
  assert.match(p, /elapsed calendar time/);
});

test("ask: rule 6 keeps non-user-account entries out of aggregates", () => {
  const p = buildAskPrompt("q", ["x — 1 entry:"]);
  assert.match(p, /non-user-account/);
  assert.match(p, /never count,/);
  assert.match(p, /single-fact lookup/);
});

// --- 相对窗口宽容 + 计数类拒答纪律 ---------------------------------------------

test("ask: relative windows are fuzzy, counting gaps must not be filled", () => {
  const p = buildAskPrompt("q", ["x — 1 entry:"]);
  assert.match(p, /Relative expressions \("last week", "recently"\) are fuzzy/);
  assert.match(p, /a few days\s+outside your strict window still counts/);
  assert.match(p, /how-many \/ how-much \/ how-long/);
  assert.match(p, /never substitute a near-topic/);
});
