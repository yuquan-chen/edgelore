// edgelore · Agent Memory layer — the runtime orchestrator.
//
// This is the "上层 runtime" the frozen two-layer design always referred to
// (docs/agent-memory-design.md §5): the ONLY component allowed to call
// capture(). It wires one conversation turn through the pipeline:
//
//   text -> gate (worth storing?) -> extract (CaptureContent[]) -> capture()
//
// and supplies the two graph-derived context recipes the extractor needs:
// knownDimensions (dimension slots read from the graph) and contextMemories
// (a plain-text digest of stored statements — the simple queryNodes lookup
// per frozen decision #4; a vector-retrieval upgrade plugs in here later).

import type { GraphStore } from "../model/store.js";
import type { DimensionNode, StatementNode } from "../model/types.js";
import { capture, type CaptureContext, type CaptureResult } from "./capture.js";
import { runGate } from "./gate.js";
import { runExtract } from "./extract.js";
import type { KnownDimension } from "./prompt.js";
import type { LlmDriver } from "./llm-driver.js";

/** Result of running one conversation turn through the pipeline. */
export interface TurnOutcome {
  /** The gate's verdict. `reason` carries the NOOP rationale, or why a
   * store-verdict produced zero captures (extractor came back empty). */
  gate: { store: boolean; reason?: string };
  /** One CaptureResult per persisted content — empty on NOOP. Inspect
   * `created` / `deduplicated` / `conflict` per entry. */
  captures: CaptureResult[];
}

/** Options for {@link processTurn}. */
export interface ProcessTurnOptions {
  /** Extra scenario fragments appended to both prompts (§4.3). */
  extraFragments?: readonly string[];
}

/**
 * Run one conversation turn through gate -> extract -> capture.
 *
 * @param graph any GraphStore backend (in-memory or SQLite)
 * @param text the conversation turn
 * @param driver the LLM driver used for BOTH stages (MockDriver in tests)
 * @param ctx runtime-read provenance, injected at capture time only
 * @param opts optional prompt fragments
 * @returns the gate verdict plus per-content capture results
 * @throws AgentError on malformed driver replies or contract violations
 *   (propagated from gate / extract / capture)
 */
export async function processTurn(
  graph: GraphStore,
  text: string,
  driver: LlmDriver,
  ctx: CaptureContext,
  opts?: ProcessTurnOptions,
): Promise<TurnOutcome> {
  const gate = await runGate(text, driver, opts?.extraFragments ? { extraFragments: opts.extraFragments } : undefined);
  if (!gate.store) {
    return { gate: { store: false, reason: gate.reason }, captures: [] };
  }
  const extract = await runExtract({
    text,
    candidates: gate.candidates,
    knownDimensions: knownDimensionsOf(graph),
    contextMemories: contextMemoriesOf(graph),
    driver,
    extraFragments: opts?.extraFragments,
  });
  if (extract.action !== "STORE" || !extract.contents?.length) {
    return { gate: { store: true, reason: extract.reason ?? "extractor produced no entries" }, captures: [] };
  }
  return { gate: { store: true }, captures: extract.contents.map((content) => capture(graph, content, ctx)) };
}

/**
 * Build the extractor's dimension list from the graph.
 * `description` is the key itself (keys are subject-free addresses; their
 * human label lives in prompts via contextMemories). `unit` is borrowed from
 * the dimension's first unit-bearing statement — units live on statements,
 * not dimensions.
 *
 * @param graph the graph to read
 * @returns KnownDimension entries for every dimension in the graph
 */
export function knownDimensionsOf(graph: GraphStore): KnownDimension[] {
  const units = new Map<string, string>();
  for (const s of graph.queryNodes({ type: "core:statement" }) as StatementNode[]) {
    if (s.unit && !units.has(s.dimension_id)) units.set(s.dimension_id, s.unit);
  }
  return (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).map((d) => {
    const unit = units.get(d.id);
    return {
      key: d.key,
      description: d.key,
      cardinality: d.cardinality ?? "multi",
      ...(unit ? { unit } : {}),
    };
  });
}

/**
 * Build the extractor's context digest from the graph: one
 * `"key = value [state]"` line per stored statement. The most recent
 * statements win when `limit` truncates.
 *
 * @param graph the graph to read
 * @param limit maximum number of lines (default 50 — bounds prompt size)
 * @returns context lines, oldest-first, newest-kept under truncation
 */
export function contextMemoriesOf(graph: GraphStore, limit = 50): string[] {
  const keys = new Map<string, string>();
  for (const d of graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]) {
    keys.set(d.id, d.key);
  }
  const lines = (graph.queryNodes({ type: "core:statement" }) as StatementNode[]).map(
    (s) => `${keys.get(s.dimension_id) ?? "?"} = ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} [${s.state}]`,
  );
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}
