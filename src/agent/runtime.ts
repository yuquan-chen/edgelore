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
import type { DimensionNode, FactNodeState, StatementNode } from "../model/types.js";
import { capture, type CaptureContext, type CaptureResult } from "./capture.js";
import { runGraphEnrichment } from "./graph-enrichment.js";
import { commitGraphWritePlan } from "./graph-write.js";
import { runGate } from "./gate.js";
import { runExtract } from "./extract.js";
import type { KnownDimension } from "./prompt.js";
import type { LlmDriver } from "./llm-driver.js";
import type { EmbeddingDriver } from "./embedding-driver.js";
import {
  bigrams,
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
  /** Present when graph enrichment was requested. Failure is non-fatal: the
   * extracted facts still go through plain capture(). */
  graph?: {
    enriched: boolean;
    createdEntities: number;
    createdEdges: number;
    error?: string;
  };
}

/** Options for {@link processTurn}. */
export interface ProcessTurnOptions {
  /** Extra scenario fragments appended to both prompts (§4.3). */
  extraFragments?: readonly string[];
  /** When configured, context selection switches from "latest 50" to
   * hybrid retrieval, and new statements are embedded after capture. */
  retrieval?: RetrievalConfig;
  /** Optional third pass: organize immutable extracted facts into entities,
   * events, and Statement-originating relations. */
  graphEnrichment?: GraphEnrichmentConfig;
}

export interface GraphEnrichmentConfig {
  /** Defaults to the gate/extract driver. May be a cheaper organizer model. */
  driver?: LlmDriver;
  /** Existing entity hints exposed to the organizer (default 40). */
  maxEntityHints?: number;
}

/** Retrieval plumbing for the context recipes and the embedding write path. */
export interface RetrievalConfig {
  embedder: EmbeddingDriver;
  vectors: VectorStore;
  /** Route selection (default "hybrid"). */
  mode?: RetrievalMode;
  /** Max context hits, i.e. how many dimensions get a group (default 8). */
  k?: number;
  /** RRF smoothing constant (default 60) — lower weights top ranks higher. */
  rrfSmoothing?: number;
  /** Per-dimension entry cap in grouped ask context (default 8). */
  maxEntriesPerDimension?: number;
  /** Hard line budget for the assembled context (default 48). */
  maxContextLines?: number;
  /** Candidate state filter (default: ALL states — counting questions need
   * superseded/tentative visible; narrow deliberately, never by default). */
  states?: FactNodeState[];
  /** Inclusive created_at day bounds ("YYYY-MM-DD") for candidates. */
  dateFrom?: string;
  /** Inclusive upper bound (see {@link dateFrom}). */
  dateTo?: string;
  /** Scope filter — WHOSE memory to search (session/source ids). Identity,
   * not content: group members are filtered by the same set so a retrieved
   * dimension never renders another tenant's statements. Unset = all. */
  scopeSessionIds?: readonly string[];
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
  let knownDims: KnownDimension[];
  if (opts?.retrieval) {
    const rc = await retrievalContext(graph, text, opts.retrieval);
    contextMemories = rc.lines;
    // 反漂移分层：检索命中的相关维度为主选，兜底为按本回合相关性选择的 top-50
    knownDims = rc.similarDimensions.length > 0
      ? rc.similarDimensions
      : relevantDimensionsOf(graph, text, 50);
  } else {
    contextMemories = contextMemoriesOf(graph);
    knownDims = relevantDimensionsOf(graph, text, 50);
  }
  const extract = await runExtract({
    text,
    candidates: gate.candidates,
    knownDimensions: knownDims,
    contextMemories,
    driver,
    // 日期锚：相对时间（"两个月前"）需要今天作参照才能换算进 value
    extraFragments: [
      ...(opts?.extraFragments ?? []),
      `Today's date: ${new Date().toISOString().slice(0, 10)}. Resolve relative time expressions ("two months ago") into absolute dates and keep them inside the value.`,
    ],
  });
  if (extract.action !== "STORE" || !extract.contents?.length) {
    return {
      gate: { store: true, reason: extract.reason ?? "extractor produced no entries" },
      captures: [],
      indexed: 0,
    };
  }
  let captures: CaptureResult[];
  let graphOutcome: TurnOutcome["graph"];
  if (opts?.graphEnrichment) {
    try {
      const plan = await runGraphEnrichment({
        text,
        contents: extract.contents,
        knownDimensions: knownDims,
        graph,
        driver: opts.graphEnrichment.driver ?? driver,
        scope: ctx.scope,
        ...(opts.graphEnrichment.maxEntityHints !== undefined
          ? { maxEntityHints: opts.graphEnrichment.maxEntityHints }
          : {}),
      });
      const result = commitGraphWritePlan(graph, plan, ctx);
      captures = result.captures;
      graphOutcome = {
        enriched: true,
        createdEntities: result.createdEntityIds.length,
        createdEdges: result.createdEdgeIds.length,
      };
    } catch (err) {
      captures = extract.contents.map((content) => capture(graph, content, ctx));
      graphOutcome = {
        enriched: false,
        createdEntities: 0,
        createdEdges: 0,
        error: (err as Error).message,
      };
    }
  } else {
    captures = extract.contents.map((content) => capture(graph, content, ctx));
  }

  // Embedding write path: after capture, index each new statement AND each
  // new dimension (so similarDimensions can find it next time). Failures
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
      }
      // also embed new dimensions (key + description) for similarDimensions retrieval
      const newDims = captures.filter((c) => c.created).map((c) => c.dimensionId);
      if (newDims.length > 0) {
        const dimTexts = newDims.map((id) => {
          const d = graph.getNode(id) as DimensionNode | undefined;
          return d ? `${d.key} ${d.attributes?.description ?? ""}` : "";
        }).filter(Boolean);
        if (dimTexts.length > 0) {
          const dimVectors = await opts.retrieval.embedder.embed(dimTexts);
          newDims.forEach((id, i) => opts.retrieval?.vectors.put(id, dimVectors[i] as number[]));
        }
      }
      indexed = captures.filter((c) => c.statementId !== null && !c.deduplicated).length;
    } catch (err) {
      indexError = (err as Error).message;
    }
  }
  return {
    gate: { store: true },
    captures,
    indexed,
    indexError,
    ...(graphOutcome ? { graph: graphOutcome } : {}),
  };
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

/**
 * Build the extractor's dimension list bounded by RELEVANCE, not graph size.
 *
 * Feeding the FULL dimension list scales O(dims): at 5,657 dimensions the
 * batch-extraction prompt carried ~624KB (~180k tokens) of key JSON — past
 * the model's context window, silently truncated, which killed the
 * anti-drift hint exactly when the library grew (drift audit: zero key
 * reuse). This variant scores dimensions by lexical overlap between the
 * turn/transcript and the dimension's key+description, and keeps only the
 * top `limit` — the prompt stays bounded forever and the hints it keeps are
 * ones the model can actually use.
 *
 * @param graph the graph to read
 * @param text the turn (or session transcript) the extraction is for
 * @param limit max dimensions returned (default 30)
 * @returns the most lexically-relevant dimension slots; falls back to the
 *   first `limit` dims (insertion order) when nothing overlaps
 */
export function relevantDimensionsOf(graph: GraphStore, text: string, limit = 30): KnownDimension[] {
  const units = borrowUnits(graph);
  const queryBigrams = bigrams(text);
  const scored = (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).map((d) => {
    const kd = toKnownDimension(d, units);
    const doc = bigrams(`${kd.key} ${kd.description}`);
    let hits = 0;
    for (const b of queryBigrams) {
      if (doc.has(b)) hits++;
    }
    // Plain containment: hints are short, so precision weighting matters
    // less than "does the transcript touch this slot at all".
    const score = hits === 0 || queryBigrams.size === 0 ? 0 : hits / queryBigrams.size;
    return { kd, score };
  });
  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.kd);
  if (relevant.length > 0) return relevant;
  return scored.slice(0, limit).map((s) => s.kd);
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
  const lines = (graph.queryNodes({ type: "core:statement" }) as StatementNode[]).map((s) => {
    const speaker = s.saidBy === "assistant" ? " (assistant)" : "";
    return `${keys.get(s.dimension_id) ?? "?"} = ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""} [${s.state} @${s.created_at.slice(0, 10)}]${speaker}`;
  });
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

/** Retrieval context: context lines PLUS the dimensions to hint at (anti-drift). */
export interface RetrievalContext {
  lines: string[];
  similarDimensions: KnownDimension[];
}

/**
 * Retrieval-grade context, rendered as GROUPED dimension blocks.
 *
 * Retrieval picks the relevant DIMENSIONS; the renderer then prints each one
 * as a complete block — a header carrying the graph's own entry count
 * (`key — 3 entries:`) followed by the dimension's statements (capped) and
 * active constraint verdicts. Counting questions read the header (the graph
 * counts; the model doesn't), and entries can no longer scatter out of
 * top-k. Over-budget dimensions degrade to a one-line summary that STILL
 * carries the count.
 *
 * The hits' owning dimensions are also returned as same-slot hints for the
 * extractor (anti-drift layer 2).
 *
 * @param graph a concrete MemoryGraph (constraint access needs the full store)
 * @param query the conversation turn
 * @param config embedding + vector-store plumbing and rendering budgets
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
    smoothing: config.rrfSmoothing,
    states: config.states,
    dateFrom: config.dateFrom,
    dateTo: config.dateTo,
    sourceRefsAllow: config.scopeSessionIds,
  });
  const dimById = new Map(
    (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).map((d) => [d.id, d]),
  );

  // Group statements by dimension once (per-dimension completeness is the
  // point of grouped rendering); chronological inside each group. Scope
  // prefers THIS tenant's members (header count = tenant count) but falls
  // back to all members when the dimension holds none — twin-session
  // provenance must stay visible (the stage2b -2 lesson).
  const scopeSet = config.scopeSessionIds ? new Set(config.scopeSessionIds) : undefined;
  const inScopeOf = (s: StatementNode) =>
    !scopeSet || (s.source_refs ?? []).some((r) => scopeSet.has(r));
  const membersByDim = new Map<string, StatementNode[]>();
  for (const s of graph.queryNodes({ type: "core:statement" }) as StatementNode[]) {
    const list = membersByDim.get(s.dimension_id);
    if (list) list.push(s);
    else membersByDim.set(s.dimension_id, [s]);
  }
  for (const list of membersByDim.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  const maxEntries = config.maxEntriesPerDimension ?? 8;
  const maxLines = config.maxContextLines ?? 48;
  const activeConstraints = graph
    .getAllConstraints()
    .filter((c) => c.activation_state === "active");
  const lines: string[] = [];
  const hitDims = [...new Set(hits.map((h) => h.dimensionId))];
  for (const dimId of hitDims) {
    const allMembers = membersByDim.get(dimId) ?? [];
    const scoped = scopeSet ? allMembers.filter(inScopeOf) : [];
    const members = scoped.length > 0 ? scoped : allMembers;
    const key = dimById.get(dimId)?.key ?? hits.find((h) => h.dimensionId === dimId)?.dimensionKey ?? "?";
    // Double-ended selection: oldest half + newest half. Oldest-only rendering
    // systematically hid the LATEST value of fast-growing dimensions (the
    // exact entries knowledge-update questions need).
    const headN = Math.ceil(maxEntries / 2);
    const tailN = maxEntries - headN;
    const overCap = members.length > maxEntries;
    const head = overCap ? members.slice(0, headN) : members;
    const tail = overCap ? members.slice(members.length - tailN) : [];
    const gapCount = overCap ? members.length - headN - tailN : 0;
    const shownLines = head.length + tail.length + (gapCount > 0 ? 1 : 0);
    if (lines.length + shownLines + 1 > maxLines) {
      // Over budget: degrade to a one-line summary — the COUNT survives even
      // when the entries do not (counting questions read the header).
      lines.push(`${key}: ${members.length} entries (omitted — context budget)`);
      continue;
    }
    lines.push(`${key} — ${members.length} ${members.length === 1 ? "entry" : "entries"}:`);
    // Scope tagging: when scoping is active and this dimension has NO in-scope
    // members (the twin-session fallback channel), every rendered line is
    // tagged so the answering layer can keep them out of aggregates. Mixed
    // dimensions never reach here — when scoped members exist, only they are
    // rendered (untagged: they ARE the account).
    const fallbackOut = scopeSet !== undefined && scoped.length === 0 && scopeSet.size > 0;
    const renderMember = (m: StatementNode) => {
      const speaker = m.saidBy === "assistant" ? " (assistant)" : "";
      const tag = fallbackOut ? " (non-user-account)" : "";
      lines.push(
        `  = ${JSON.stringify(m.value)}${m.unit ? ` ${m.unit}` : ""} [${m.state} @${m.created_at.slice(0, 10)}]${speaker}${tag}`,
      );
    };
    for (const m of head) renderMember(m);
    if (gapCount > 0) lines.push(`  ⋯ ${gapCount} more entries in between`);
    for (const m of tail) renderMember(m);
    for (const c of activeConstraints) {
      if (Object.values(c.bindings).includes(dimId) || c.participants.includes(dimId)) {
        lines.push(`  rule "${c.name ?? c.id}" -> ${graph.evaluateConstraint(c.id)}`);
      }
    }
  }

  // Anti-drift layer 2: the dimensions owning retrieved context are the
  // likely slots for this turn's candidates.
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
