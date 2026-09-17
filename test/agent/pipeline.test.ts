// edgelore · Agent Memory layer — pipeline integration tests.
//
// Proves the frozen boundary end-to-end: gate -> extract -> capture. The
// agent layer's output (CaptureContent[]) feeds capture() unchanged, and
// provenance appears only at capture time via the runtime-injected context.
// No graph is touched until capture — the agent stages run on MockDriver
// with no store at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph, type GraphStore } from "../../src/model/store.js";
import {
  capture,
  type CaptureContent,
  type CaptureContext,
} from "../../src/agent/capture.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { runGate } from "../../src/agent/gate.js";
import { runExtract } from "../../src/agent/extract.js";
import type { KnownDimension } from "../../src/agent/prompt.js";

const ctx: CaptureContext = { created_by: "agent:workbuddy:1", source_refs: ["msg:42"] };

/**
 * Drive the agent stages of the pipeline for one turn: gate -> extract.
 * Returns the structured contents the runtime would then hand to capture
 * (empty when the gate says NOOP — the runtime skips extract entirely).
 */
async function runAgentStages(
  text: string,
  gateReply: object,
  extractReply: object,
  knownDimensions: KnownDimension[],
): Promise<CaptureContent[]> {
  const gate = await runGate(text, new MockDriver([JSON.stringify(gateReply)]));
  if (!gate.store) {
    assert.equal(gate.candidates.length, 0, "gate store=false must carry no candidates");
    return [];
  }
  const extract = await runExtract({
    text,
    candidates: gate.candidates,
    knownDimensions,
    contextMemories: [],
    driver: new MockDriver([JSON.stringify(extractReply)]),
  });
  return extract.action === "STORE" ? (extract.contents ?? []) : [];
}

/** The runtime's capture loop: inject provenance, persist each content. */
function captureAll(graph: GraphStore, contents: CaptureContent[]): void {
  for (const content of contents) {
    capture(graph, content, ctx);
  }
}

test("pipeline: one sentence lands as an accepted statement", async () => {
  const contents = await runAgentStages(
    "项目预算是 5000 元",
    { store: true, candidates: ["预算是 5000 元"], reason: "约束" },
    { contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }] },
    [], // fresh graph: nothing known yet
  );
  assert.equal(contents.length, 1);
  assert.equal(contents[0]?.dimensionKey, "budget"); // NEW: stripped by the layer

  const graph = new MemoryGraph();
  captureAll(graph, contents);
  const dims = graph.queryNodes({ type: "core:dimension" });
  assert.equal(dims.length, 1);
  const stmts = graph.queryNodes({ type: "core:statement" }) as Array<{ state: string; value: unknown }>;
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0]?.state, "accepted");
  assert.equal(stmts[0]?.value, 5000);
  // Provenance exists on the statement only because the runtime injected it.
  const author = graph.queryNodes({ type: "core:statement" })[0] as unknown as {
    created_by: string;
  };
  assert.equal(author.created_by, "agent:workbuddy:1");
});

test("pipeline: the same fact again is deduplicated by capture", async () => {
  const contents = await runAgentStages(
    "项目预算是 5000 元",
    { store: true, candidates: ["预算是 5000 元"] },
    { contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }] },
    [],
  );
  const graph = new MemoryGraph();
  captureAll(graph, contents);
  const r2 = capture(graph, contents[0]!, ctx);
  assert.equal(r2.deduplicated, true);
  assert.equal(graph.queryNodes({ type: "core:statement" }).length, 1);
});

test("pipeline: changed budget on a single-cardinality dimension flags conflict", async () => {
  const graph = new MemoryGraph();
  // Turn 1: budget 5000 accepted.
  const first = await runAgentStages(
    "项目预算是 5000 元",
    { store: true, candidates: ["预算是 5000 元"] },
    { contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }] },
    [],
  );
  captureAll(graph, first);

  // Turn 2 (three days later): budget 8000 — same dimension, new value.
  const second = await runAgentStages(
    "预算改成 8000 了",
    { store: true, candidates: ["预算改成 8000"] },
    { contents: [{ dimensionKey: "NEW:budget", value: 8000 }] },
    [],
  );
  assert.equal(second[0]?.dimensionKey, "budget");
  const r = capture(graph, second[0]!, ctx);
  assert.equal(r.conflict, true);
  assert.equal(r.deduplicated, false);

  const stmts = graph.queryNodes({ type: "core:statement" }) as Array<{ state: string; value: unknown }>;
  assert.equal(stmts.length, 2);
  const states = new Set(stmts.map((s) => s.state));
  assert.deepEqual([...states].sort(), ["accepted", "tentative"]); // old kept, newcomer pending
  const dim = graph.getNode(r.dimensionId) as { state: string };
  assert.equal(dim.state, "conflict"); // flagged, NOT resolved
});

test("pipeline: gate NOOP stops the pipeline before extract runs", async () => {
  const contents = await runAgentStages(
    "谢谢啦，辛苦了！",
    { store: false, candidates: [], reason: "客套" },
    { contents: [{ dimensionKey: "NEW:whatever", value: "x" }] }, // must never be consumed
    [],
  );
  assert.equal(contents.length, 0); // extract stage never ran
});

test("pipeline: knownDimensions can be read back from the graph (runtime recipe)", async () => {
  const graph = new MemoryGraph();
  // First session: author captured as a NEW dimension.
  const first = await runAgentStages(
    "这个项目作者是 charles",
    { store: true, candidates: ["作者是 charles"] },
    { contents: [{ dimensionKey: "NEW:author", value: "charles" }] },
    [],
  );
  captureAll(graph, first);

  // Later session: the runtime rebuilds knownDimensions from the graph, so
  // the extractor can reuse the existing key instead of emitting NEW:.
  const known: KnownDimension[] = graph.queryNodes({ type: "core:dimension" }).map((d) => {
    const dim = d as { key: string; cardinality?: "single" | "multi" };
    return { key: dim.key, description: dim.key, cardinality: dim.cardinality ?? "multi" };
  });
  assert.equal(known.length, 1);
  const contents = await runAgentStages(
    "再次确认：作者是 charles",
    { store: true, candidates: ["作者是 charles"] },
    { contents: [{ dimensionKey: "author", value: "charles" }] }, // existing key passes
    known,
  );
  assert.equal(contents[0]?.dimensionKey, "author");
  const r = capture(graph, contents[0]!, ctx);
  assert.equal(r.deduplicated, true); // same value -> no duplicate statement
});
