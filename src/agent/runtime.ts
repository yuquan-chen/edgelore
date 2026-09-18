// edgelore · Agent Memory layer — the runtime orchestrator.
//
// This is the "上层 runtime" the frozen two-layer design always referred to
// (docs/agent-memory-design.md §5): the ONLY component allowed to call
// capture(). It wires one conversation turn through the pipeline:
//
//   text -> gate (worth storing?) -> extract (CaptureContent[]) -> capture()
//
// and supplies the two graph-derived context recipes the extractor needs:
// knownDimensions (dimension slots read from the graph) and contextMemories.
// Two context strategies, selected by configuration:
//   - default:    "latest 50" digest (zero config, works with no embedding
//                 provider — the frozen decision #4 starting point)
//   - retrieval:  hybrid retrieval (vector + lexical, RRF-fused) with
//                 one-hop graph expansion — relevant context with conflict
//                 posture and constraint verdicts attached

import type { GraphStore, MemoryGraph } from "../model/store.js";
import type { DimensionNode, StatementNode } from "../model/types.js";
import { capture, type CaptureContext, type CaptureResult } from "./capture.js";
import { runGate } from "./gate.js";
import { runExtract } from "./extract.js";
import type { KnownDimension } from "./prompt.js";
import type { LlmDriver } from "./llm-driver.js";
import type { EmbeddingDriver } from "./embedding-driver.js";
import {
  expandHit,
  retrieveRelevant,
  statementText,
  type RetrievalMode,
  type VectorStore,
} from "./retrieval.js";

/** Result of running one conversation turn through the pipeline. */
export interface TurnOutcome {
  /** The gate's verdict. `reason` carries the NOOP rationale, or why a
   * store-verdict produced zero captures (extractor came back empty). */
  gate: { store: boolean; reason?: string };
  /** One CaptureResult per persisted content — empty on NOOP. Inspect
   * `created` / `deduplicated` / `conflict` per entry. */
  captures: CaptureResult[];
  /** Statements embedded into the vector store this turn (0 when retrieval
   * is not configured). A failed index write does NOT fail the turn. */
  indexed: number;
  /** Embedding failure after successful capture — the memory is stored but
   * the vector index is stale until re-embedded. */
  indexError?: string;
}

/** Options for {@link processTurn}. */
export interface ProcessTurnOptions {
  /** Extra scenario fragments appended to both prompts (§4.3). */
  extraFragments?: readonly string[];
  /** When configured, context selection switches from "latest 50" to
   * hybrid retrieval, and new statements are embedded after capture. */
  retrieval?: RetrievalConfig;
}

/** Retrieval plumbing for the context recipes and the embedding write path. */
export interface RetrievalConfig {
  embedder: EmbeddingDriver;
  vectors: VectorStore;
  /** Route selection (default "hybrid"). */
  mode?: RetrievalMode;
  /** Max context hits (default 8). */
  k?: number;
}

/**
 * Run one conversation turn through gate -> extract -> capture.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph) — the runtime needs
 *   the full store surface (constraints) for context expansion
 * @param text the conversation turn
 * @param driver the LLM driver used for BOTH stages (MockDriver in tests)
 * @param ctx runtime-read provenance, injected at capture time only
 * @param opts optional prompt fragments and retrieval plumbing
 * @returns the gate verdict, per-content capture results, and index stats
 * @throws AgentError on malformed driver replies or contract violations
 *   (propagated from gate / extract / capture)
 */
export async function processTurn(
  graph: MemoryGraph,
  text: string,
  driver: LlmDriver,
  ctx: CaptureContext,
  opts?: ProcessTurnOptions,
): Promise<TurnOutcome> {
  const gate = await runGate(text, driver, opts?.extraFragments ? { extraFragments: opts.extraFragments } : undefined);
  if (!gate.store) {
    return { gate: { store: false, reason: gate.reason }, captures: [], indexed: 0 };
  }
  let contextMemories: string[];
  let similarDimensions: KnownDimension[] | undefined;
  if (opts?.retrieval) {
    const rc = await retrievalContext(graph, text, opts.retrieval);
    contextMemories = rc.lines;
    similarDimensions = rc.similarDimensions;
  } else {
    contextMemories = contextMemoriesOf(graph);
  }
  const extract = await runExtract({
    text,
    candidates: gate.candidates,
    knownDimensions: knownDimensionsOf(graph),
    similarDimensions,
    contextMemories,
    driver,
    extraFragments: opts?.extraFragments,
  });
  if (extract.action !== "STORE" || !extract.contents?.length) {
    return {
      gate: { store: true, reason: extract.reason ?? "extractor produced no entries" },
      captures: [],
      indexed: 0,
    };
  }
  const captures = extract.contents.map((content) => capture(graph, content, ctx));

  // Embedding write path: after capture, index each new statement. Failures
  // here must NOT fail the turn — the memory is stored; the index is stale
  // and can be rebuilt (vectors are derived data).
  let indexed = 0;
  let indexError: string | undefined;
  if (opts?.retrieval) {
    try {
      const stored = captures.filter((c) => c.statementId !== null && !c.deduplicated);
      if (stored.length > 0) {
        const texts = stored.map((c) => statementText(graph, graph.getNode(c.statementId as string) as StatementNode));
        const vectors = await opts.retrieval.embedder.embed(texts);
        stored.forEach((c, i) => opts.retrieval?.vectors.put(c.statementId as string, vectors[i] as number[]));
        indexed = stored.length;
      }
    } catch (err) {
      indexError = (err as Error).message;
    }
  }
  return { gate: { store: true }, captures, indexed, indexError };
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
  const units = borrowUnits(graph);
  return (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).map((d) =>
    toKnownDimension(d, units),
  );
}

/** Unit borrowing: a dimension's unit lives on its first unit-bearing statement. */
function borrowUnits(graph: GraphStore): Map<string, string> {
  const units = new Map<string, string>();
  for (const s of graph.queryNodes({ type: "core:statement" }) as StatementNode[]) {
    if (s.unit && !units.has(s.dimension_id)) units.set(s.dimension_id, s.unit);
  }
  return units;
}

/** Build the prompt-facing slot descriptor. Description comes from open
 * metadata (`attributes.description`, written at NEW: creation) and falls
 * back to the key — the anti-drift signal for later sessions. */
function toKnownDimension(d: DimensionNode, units: Map<string, string>): KnownDimension {
  const unit = units.get(d.id);
  const stored = d.attributes?.description;
  return {
    key: d.key,
    description: typeof stored === "string" && stored.length > 0 ? stored : d.key,
    cardinality: d.cardinality ?? "multi",
    ...(unit ? { unit } : {}),
  };
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
    (s) =>
      `${keys.get(s.dimension_id) ?? "?"} = ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} [${s.state} @${s.created_at.slice(0, 10)}]`,
  );
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

/** Retrieval context: context lines PLUS the dimensions to hint at (anti-drift). */
export interface RetrievalContext {
  lines: string[];
  similarDimensions: KnownDimension[];
}

/**
 * Retrieval-grade context: hybrid retrieval (vector + lexical, RRF fused)
 * picks the relevant statements, each hit is expanded one hop — competing
 * statements (conflict counterparts) and active constraints with the M1
 * engine's current verdict — and the hits' owning dimensions are returned
 * as same-slot hints for the extractor (anti-drift layer 2).
 *
 * @param graph a concrete MemoryGraph (constraint access needs the full store)
 * @param query the conversation turn
 * @param config embedding + vector-store plumbing
 * @returns context lines and similar-dimension hints
 */
export async function retrievalContext(
  graph: MemoryGraph,
  query: string,
  config: RetrievalConfig,
): Promise<RetrievalContext> {
  const hits = await retrieveRelevant(graph, {
    query,
    k: config.k,
    mode: config.mode,
    embedder: config.embedder,
    vectors: config.vectors,
  });
  const lines = hits.map((hit) => {
    // Short date rides along: temporal reasoning needs to know WHEN a fact was said.
    const stmt = graph.getNode(hit.statementId) as StatementNode | undefined;
    const day = stmt ? stmt.created_at.slice(0, 10) : "?";
    const parts = [`${hit.dimensionKey} = ${JSON.stringify(hit.value)} [${hit.state} @${day}]`];
    const expansion = expandHit(graph, hit);
    if (expansion.siblings.length > 0) {
      parts.push(
        `competing: ${expansion.siblings
          .map((s) => `${JSON.stringify(s.value)}[${s.state} @${s.createdAt.slice(0, 10)}]`)
          .join(" vs ")}`,
      );
    }
    for (const c of expansion.constraints) {
      parts.push(`constraint "${c.name ?? c.id}" -> ${c.evaluation}`);
    }
    return parts.join(" | ");
  });
  // Anti-drift layer 2: the dimensions owning retrieved context are the
  // likely slots for this turn's candidates.
  const dimById = new Map(
    (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).map((d) => [d.id, d]),
  );
  const units = borrowUnits(graph);
  const seen = new Set<string>();
  const similarDimensions: KnownDimension[] = [];
  for (const hit of hits) {
    if (seen.has(hit.dimensionId)) continue;
    seen.add(hit.dimensionId);
    const dim = dimById.get(hit.dimensionId);
    if (dim) similarDimensions.push(toKnownDimension(dim, units));
  }
  return { lines, similarDimensions };
}

/** Convenience wrapper: just the context lines. */
export async function contextMemoriesViaRetrieval(
  graph: MemoryGraph,
  query: string,
  config: RetrievalConfig,
): Promise<string[]> {
  return (await retrievalContext(graph, query, config)).lines;
}
