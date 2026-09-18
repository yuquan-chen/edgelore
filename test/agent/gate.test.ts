// edgelore · Agent Memory layer — gate tests.
//
// The gate is an LLM-shaped function: build prompt -> driver -> parse ->
// validate. MockDriver replays preset replies, so no model is ever called
// and the tests are free. The user-approved "lesson/feedback" whitelist line
// is asserted explicitly so it cannot silently disappear.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "../../src/agent/errors.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { buildGatePrompt } from "../../src/agent/prompt.js";
import { runGate } from "../../src/agent/gate.js";

test("gate: store=true reply parses into verbatim candidates", async () => {
  const driver = new MockDriver([
    JSON.stringify({ store: true, candidates: ["预算是 5000 元"], reason: "约束" }),
  ]);
  const r = await runGate("项目预算是 5000 元", driver);
  assert.equal(r.store, true);
  assert.deepEqual(r.candidates, ["预算是 5000 元"]);
  assert.equal(r.reason, "约束");
});

test("gate: store=false yields empty candidates", async () => {
  const driver = new MockDriver([JSON.stringify({ store: false, candidates: [], reason: "客套" })]);
  const r = await runGate("谢谢!", driver);
  assert.equal(r.store, false);
  assert.deepEqual(r.candidates, []);
});

test("gate: fenced / decorated JSON is tolerated", async () => {
  const driver = new MockDriver([
    '好的，判断结果如下：\n```json\n{ "store": true, "candidates": ["a fact"], "reason": "x" }\n```',
  ]);
  const r = await runGate("some fact", driver);
  assert.equal(r.store, true);
  assert.deepEqual(r.candidates, ["a fact"]);
});

test("gate: non-JSON reply throws AgentError", async () => {
  const driver = new MockDriver(["我觉得可以存一下。"]);
  await assert.rejects(runGate("some turn", driver), AgentError);
});

test("gate: store=true without candidates throws AgentError", async () => {
  const driver = new MockDriver([JSON.stringify({ store: true, candidates: [] })]);
  await assert.rejects(runGate("some turn", driver), AgentError);
});

test("gate: non-string candidates throw AgentError", async () => {
  const driver = new MockDriver([JSON.stringify({ store: true, candidates: [42] })]);
  await assert.rejects(runGate("some turn", driver), AgentError);
});

test("gate: missing store field throws AgentError", async () => {
  const driver = new MockDriver([JSON.stringify({ candidates: ["x"], reason: "y" })]);
  await assert.rejects(runGate("some turn", driver), AgentError);
});

test("gate: prompt carries whitelist, lesson/feedback line, contract, and the text", () => {
  const p = buildGatePrompt({ text: "项目预算 5000" });
  assert.match(p, /decision\/conclusion/);
  assert.match(p, /lesson\/feedback/); // user-approved whitelist addition
  assert.match(p, /NOT worth storing/);
  assert.match(p, /"store"/);
  assert.match(p, /项目预算 5000/);
});

test("gate: extraFragments are appended to the prompt", () => {
  const withExtra = buildGatePrompt({ text: "t", extraFragments: ["EXTRA-SCENE-RULE"] });
  const without = buildGatePrompt({ text: "t" });
  assert.match(withExtra, /EXTRA-SCENE-RULE/);
  assert.doesNotMatch(without, /EXTRA-SCENE-RULE/);
});

test("mockDriver: exhausted queue throws AgentError", async () => {
  const driver = new MockDriver(["{}"]);
  await driver.complete("first");
  await assert.rejects(driver.complete("second"), AgentError);
  assert.equal(driver.remaining, 0);
});

test("gate: oversized input fails loud with guidance (turn-scoped boundary)", async () => {
  const driver = new MockDriver([]); // must NOT be called
  const huge = "很长的文档".repeat(10_000); // > MAX_TURN_CHARS
  await assert.rejects(runGate(huge, driver), /turn-scoped/);
  assert.equal(driver.remaining, 0); // no model call wasted on garbage input
});
