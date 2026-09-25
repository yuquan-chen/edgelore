// edgelore · Agent Memory layer — hybrid retrieval over the memory graph.
//
// Replaces the "latest 50" context recipe with relevance: three candidate
// routes fused by Reciprocal Rank Fusion, in the Zep/Graphiti style that
// the retrieval research confirmed as the industry pattern:
//
//   ① vector route  — cosine over statement embeddings (needs an
//                     EmbeddingDriver + a VectorStore; skipped otherwise)
//   ② lexical route — character-bigram containment over "key + value"
//                     text; always available, works on both backends, and
//                     handles proper nouns (charles, PostgreSQL) that
//                     embeddings are insensitive to
//   ③ RRF fusion    — 1/(60 + rank) summed across routes; rank-based, so
//                     incompatible score scales never mix
//
// Hits carry their GRAPH ADDRESS (statementId / dimensionId / key / value /
// state) — position is native to a graph, not inferred from text chunks.
// `expandHit` walks one hop: sibling statements (conflict counterparts!)
// and active constraints binding the dimension, with the M1 engine's
// current verdict.
//
// Mode is an explicit ablation switch ("hybrid" | "vector" | "lexical")
// because the industry has never published a hybrid-vs-single-signal
// ablation — we measure on our own eval sets.

import { AgentError } from "./errors.js";
import { scopesEqual, type GraphStore, type MemoryGraph } from "../model/store.js";
import type { SqliteGraph } from "../store/sqlite.js";
import type { DimensionNode, FactNodeState, GraphNode, Scope, StatementNode } from "../model/types.js";
import type { EvaluationResult } from "../engine/evaluate.js";
import type { EmbeddingDriver } from "./embedding-driver.js";
import { conversationEvidenceText } from "./evidence.js";
import { slotLabel } from "./slots.js";

/** How many retrieval routes to run. Ablation switch, default "hybrid". */
export type RetrievalMode = "hybrid" | "vector" | "lexical";

/** Where vectors live. Implemented by SqliteGraph-backed and in-memory stores. */
export interface VectorStore {
  /** Store (or replace) the vector for one node id. */
  put(id: string, vector: number[]): void;
  /** Every stored vector (retrieval ranks them in memory, brute force). */
  all(): Array<{ id: string; vector: number[] }>;
}

/** In-memory vector store — for tests and for graphs without SQLite. */
export class InMemoryVectorStore implements VectorStore {
  private readonly map = new Map<string, number[]>();

  put(id: string, vector: number[]): void {
    this.map.set(id, vector);
  }

  all(): Array<{ id: string; vector: number[] }> {
    return [...this.map.entries()].map(([id, vector]) => ({ id, vector }));
  }
}

/** Vector store backed by the SQLite `embeddings` table (Float32 BLOBs).
 * Measured on the 8.4k-statement benchmark library: re-materializing all
 * vectors from SQLite cost ~1.6s PER QUERY (32.7MB of BLOB reads + parse) —
 * 94% of the whole retrieval overhead. The store therefore materializes ONCE
 * per process and serves subsequent reads from memory; a put() invalidates
 * the cache (writes are rare, reads are every query). */
export class SqliteVectorStore implements VectorStore {
  private readonly graph: SqliteGraph;
  private cache: Array<{ id: string; vector: number[] }> | null = null;

  /** @param graph an open SqliteGraph (the table is created on open) */
  constructor(graph: SqliteGraph) {
    this.graph = graph;
  }

  put(id: string, vector: number[]): void {
    this.graph.putVector(id, vector);
    this.cache = null; // writes are rare — full invalidation is plenty
  }

  all(): Array<{ id: string; vector: number[] }> {
    if (!this.cache) {
      this.cache = this.graph.allVectors().map((e) => ({ id: e.nodeId, vector: e.vector }));
    }
    return this.cache;
  }
}

/** One retrieval result: a graph ADDRESS, not a text chunk. */
export interface RetrievalHit {
  /** Statements participate in governed dimension semantics; messages are
   * immutable verbatim evidence and are rendered directly. */
  nodeType?: "statement" | "message";
  statementId: string;
  dimensionId: string;
  dimensionKey: string;
  value: unknown;
  state: FactNodeState;
  /** Fused RRF score — for ranking only, not comparable across queries. */
  score: number;
  /** Which routes surfaced this hit. */
  via: string[];
  /** Present for core:message evidence hits. */
  role?: "user" | "assistant";
}

/** One hop of graph context around a hit. */
export interface HitExpansion {
  /** Other statements on the same dimension — the conflict counterparts. */
  siblings: Array<{ statementId: string; value: unknown; state: FactNodeState; createdBy: string; createdAt: string }>;
  /** Active constraints binding this dimension, with the M1 engine's verdict. */
  constraints: Array<{ id: string; name?: string; evaluation: EvaluationResult }>;
}

/** Input for {@link retrieveRelevant}. */
export interface RetrievalInput {
  query: string;
  /** Max hits returned. Default 8. */
  k?: number;
  /** Route selection. Default "hybrid". */
  mode?: RetrievalMode;
  /** Required for the vector route. */
  embedder?: EmbeddingDriver;
  /** Required for the vector route. */
  vectors?: VectorStore;
  /** RRF smoothing constant (default 60) — lower weights top ranks higher. */
  smoothing?: number;
  /** Restrict candidates to these statement states (default: ALL states —
   * counting questions need superseded/tentative to stay visible). */
  states?: readonly FactNodeState[];
  /** Inclusive lower bound on the statement's created_at DAY ("YYYY-MM-DD"). */
  dateFrom?: string;
  /** Inclusive upper bound on the statement's created_at DAY ("YYYY-MM-DD"). */
  dateTo?: string;
  /** Scope filter: when set, only statements carrying at least one of these
   * source_refs are candidates. This is IDENTITY, not content — the caller
   * says WHOSE memory to search (e.g. one user's session set), never WHICH
   * facts are right. Unset = search everything (single-tenant default). */
  sourceRefsAllow?: readonly string[];
  /** Exact identity boundary. If present, candidates must have this exact
   * persisted scope; unlike sourceRefsAllow this never falls back. */
  scope?: Scope;
}

/**
 * Retrieve the statements most relevant to a query, fused across routes.
 *
 * @param graph any graph backend (lexical route works everywhere)
 * @param input query, k, mode, optional embedding plumbing, and optional
 *   state/date candidate filters (applied once, before both routes score)
 * @returns up to k hits, best fused score first
 * @throws AgentError when mode is "vector" but no embedder/store is given
 */
export async function retrieveRelevant(graph: GraphStore, input: RetrievalInput): Promise<RetrievalHit[]> {
  const mode = input.mode ?? "hybrid";
  const k = input.k ?? 8;
  // Fail loud on impossible configuration BEFORE any early return.
  if (mode === "vector" && (!input.embedder || !input.vectors)) {
    throw new AgentError('retrieval mode "vector" requires an embedder and a vector store');
  }
  const all = [
    ...graph.queryNodes({ type: "core:statement" }),
    ...graph.queryNodes({ type: "core:message" }),
  ];
  if (all.length === 0) return [];
  // One candidate pre-filter (state / date window) shared by both routes.
  // Day normalization: legacy rows stored slash dates ("2023/05/28"); ASCII
  // compares silently misorder "/" (0x2F) vs "-" (0x2D) — normalize both sides.
  // NOTE: scope (sourceRefsAllow) is applied as a SCORE BOOST after fusion,
  // not as a hard filter here — twin-session provenance (the same logical
  // conversation stored under different session ids) must stay reachable.
  const candidates = all.filter((node) => {
    if (input.scope !== undefined && !scopesEqual(node.scope, input.scope)) return false;
    if (input.states && !input.states.includes(node.state)) return false;
    const day = node.created_at.slice(0, 10).replace(/\//g, "-");
    if (input.dateFrom && day < input.dateFrom) return false;
    if (input.dateTo && day > input.dateTo) return false;
    return true;
  });
  if (candidates.length === 0) return [];
  const dims = new Map<string, GraphNode>(
    graph.queryNodes({ type: "core:dimension" }).map((d) => [d.id, d]),
  );

  const routeLimit = Math.max(k * 8, 64);
  const routes: Array<{ name: string; ranked: string[]; weight?: number }> = [];

  // Lexical route — always available, zero dependencies.
  const queryBigrams = bigrams(input.query);
  if (queryBigrams.size > 0) {
    const scored = candidates
      .map((node) => ({ id: node.id, score: lexicalScore(queryBigrams, docBigrams(graph, node)) }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score);
    routes.push({ name: "lexical", ranked: scored.slice(0, routeLimit).map((d) => d.id) });
  }

  // Vector route — only when plumbing is provided.
  if (mode !== "lexical") {
    if (!input.embedder || !input.vectors) {
      if (mode === "vector") {
        throw new AgentError('retrieval mode "vector" requires an embedder and a vector store');
      }
      // hybrid degrades gracefully to lexical-only
    } else {
      const [queryVector] = await input.embedder.embed([input.query]);
      const stored = new Map(input.vectors.all().map((e) => [e.id, e.vector]));
      const scored = candidates
        .filter((node) => stored.has(node.id))
        .map((node) => ({ id: node.id, score: cosine(queryVector, stored.get(node.id) as number[]) }))
        .filter((d) => d.score > 0)
        .sort((a, b) => b.score - a.score);
      // Dense similarity is the reliable recall route for paraphrased English
      // questions. Give it a modest lead over character-bigram lexical ranks;
      // exact lexical evidence still wins whenever it appears on both routes.
      routes.push({
        name: "vector",
        ranked: scored.slice(0, routeLimit).map((d) => d.id),
        weight: 1.25,
      });
    }
  }

  const usable = routes.filter((r) =>
    mode === "vector" ? r.name === "vector" : mode === "lexical" ? r.name === "lexical" : true,
  );
  const fused = fuseRRF(usable, input.smoothing ?? 60);

  // Scope priority: in-scope statements ALWAYS rank above out-of-scope ones
  // (each tier internally sorted by score); out-of-scope entries still fill
  // remaining slots so twin-session provenance stays reachable. Replaces the
  // ×3 multiplicative boost — slot-starvation forensics showed ×3 lost when
  // the user's own card had weak word overlap. Identity biases ORDER, it
  // does not blind.
  const scopeSet = input.sourceRefsAllow ? new Set(input.sourceRefsAllow) : undefined;
  const rankedAll = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
  let ranked = rankedAll;
  if (scopeSet) {
    const byId = new Map(candidates.map((node) => [node.id, node]));
    const inS: typeof rankedAll = [];
    const outS: typeof rankedAll = [];
    for (const entry of rankedAll) {
      const node = byId.get(entry[0]) as GraphNode;
      ((node.source_refs ?? []).some((r) => scopeSet.has(r)) ? inS : outS).push(entry);
    }
    inS.sort((a, b) => b[1].score - a[1].score);
    outS.sort((a, b) => b[1].score - a[1].score);
    ranked = [...inS, ...outS];
  }
  return ranked
    .slice(0, k)
    .map(([statementId, meta]) => {
      const node = candidates.find((candidate) => candidate.id === statementId) as GraphNode;
      if (node.type === "core:message") {
        const role = node.attributes?.role === "assistant" ? "assistant" : "user";
        return {
          nodeType: "message" as const,
          statementId: node.id,
          dimensionId: node.id,
          dimensionKey: "conversationEvidence",
          value: node.value,
          state: node.state,
          score: meta.score,
          via: meta.via,
          role,
        };
      }
      const stmt = node as StatementNode;
      const dim = dims.get(stmt.dimension_id) as DimensionNode | undefined;
      return {
        nodeType: "statement" as const,
        statementId,
        dimensionId: stmt.dimension_id,
        dimensionKey: dim?.key ?? "?",
        value: stmt.value,
        state: stmt.state,
        score: meta.score,
        via: meta.via,
      };
    });
}

/**
 * One-hop graph expansion around a hit: the dimension's other statements
 * (conflict counterparts) and active constraints bound to the dimension,
 * each with the M1 engine's current four-state verdict.
 *
 * @param graph a concrete MemoryGraph (constraint access needs the full store)
 * @param hit the hit to expand
 * @param maxSiblings cap on sibling statements (default 5 — structured
 *   context helps, but flooding hurts; see the StructRAG counter-evidence)
 * @returns siblings and constraint verdicts
 */
export function expandHit(graph: MemoryGraph, hit: RetrievalHit, maxSiblings = 5): HitExpansion {
  // Verbatim message evidence is already a terminal retrieval object. It has
  // no governed dimension siblings or constraint verdicts to expand.
  if (hit.nodeType === "message") return { siblings: [], constraints: [] };
  const siblings = (graph.queryNodes({ type: "core:statement" }) as StatementNode[])
    .filter((s) => s.dimension_id === hit.dimensionId && s.id !== hit.statementId)
    .slice(0, maxSiblings)
    .map((s) => ({
      statementId: s.id,
      value: s.value,
      state: s.state,
      createdBy: s.created_by,
      createdAt: s.created_at,
    }));
  const constraints = graph
    .getAllConstraints()
    .filter((c) => c.activation_state === "active")
    .filter(
      (c) =>
        Object.values(c.bindings).includes(hit.dimensionId) || c.participants.includes(hit.dimensionId),
    )
    .map((c) => ({ id: c.id, name: c.name, evaluation: graph.evaluateConstraint(c.id) }));
  return { siblings, constraints };
}

/** Canonical text a statement is embedded / lexically matched against.
 * Assistant-authored statements get an explicit speaker prefix: queries like
 * "助手推荐了什么数据库" must lexically hit the attribution, not just the
 * value. The dimension's human-language description is appended (when it
 * differs from the key) — numeric values ("views": 1456) share zero bigrams
 * with natural-language queries; the description is the bridge. Legacy rows
 * without saidBy/description are untouched. */
export function statementText(graph: GraphStore, stmt: StatementNode): string {
  const dim = graph.getNode(stmt.dimension_id) as DimensionNode | undefined;
  const speaker = stmt.saidBy === "assistant" ? "assistant: " : "";
  const desc =
    typeof dim?.attributes?.description === "string" &&
    dim.attributes.description.length > 0 &&
    dim.attributes.description !== dim.key
      ? ` ${dim.attributes.description}`
      : "";
  const label = dim ? slotLabel(graph, dim) : "";
  return `${speaker}${label}${desc} ${JSON.stringify(stmt.value)}${stmt.unit ? ` ${stmt.unit}` : ""}`;
}

// --- routes ------------------------------------------------------------------

/** Character bigrams (whitespace collapsed) — CJK-safe lexical features. */
export function bigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Lexical match score — 0..1, F1-balanced.
 *
 * Pure query-containment favored long "attractor" documents: a 736-char
 * movie list contains almost any query's bigrams and used to occupy every
 * retrieval slot regardless of the query (stage-2 forensics: gold evidence
 * ranked #594+ behind 8 global attractors). Balancing query coverage with
 * document precision rewards documents whose bigrams are mostly the
 * query's — short and on-topic beats long and overflowing.
 */
/**
 * Per-statement lexical index cache: building statementText + bigrams for
 * the whole library on every query measured ~95ms at 8.4k statements
 * (rebuild) vs ~14ms warm. Keyed by statement id; entries are immutable in
 * practice (value/description only change via offline merge, which runs in
 * its own process), and the cache is bounded for safety.
 */
const docBigramCache = new Map<string, Set<string>>();
const DOC_BIGRAM_CACHE_MAX = 50_000;

function docBigrams(graph: GraphStore, node: GraphNode): Set<string> {
  let doc = docBigramCache.get(node.id);
  if (!doc) {
    if (docBigramCache.size >= DOC_BIGRAM_CACHE_MAX) docBigramCache.clear();
    doc = bigrams(
      node.type === "core:message"
        ? conversationEvidenceText(node)
        : statementText(graph, node as StatementNode),
    );
    docBigramCache.set(node.id, doc);
  }
  return doc;
}

function lexicalScore(queryBigrams: Set<string>, doc: Set<string>): number {
  if (doc.size === 0) return 0;
  let hits = 0;
  for (const b of queryBigrams) {
    if (doc.has(b)) hits++;
  }
  if (hits === 0) return 0;
  const queryCoverage = hits / queryBigrams.size;
  const docPrecision = hits / doc.size;
  return (2 * queryCoverage * docPrecision) / (queryCoverage + docPrecision);
}

/** Cosine similarity; zero-norm vectors score 0. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank). Rank-based, so the three
 * routes' incompatible score scales never mix; appearing mid-list on several
 * routes beats topping a single one. k=60 is the standard smoothing constant.
 */
function fuseRRF(
  routes: Array<{ name: string; ranked: string[]; weight?: number }>,
  smoothing = 60,
): Map<string, { score: number; via: string[] }> {
  const fused = new Map<string, { score: number; via: string[] }>();
  for (const route of routes) {
    route.ranked.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, via: [] };
      entry.score += (route.weight ?? 1) / (smoothing + index + 1);
      if (!entry.via.includes(route.name)) entry.via.push(route.name);
      fused.set(id, entry);
    });
  }
  return fused;
}
