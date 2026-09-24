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
import type { DimensionNode, EpisodeRecord, EpisodeTurn, FactNodeState, StatementNode } from "../model/types.js";
import { capture, type CaptureContext, type CaptureResult } from "./capture.js";
import { runGraphEnrichment } from "./graph-enrichment.js";
import { commitGraphWritePlan } from "./graph-write.js";
import { runGate } from "./gate.js";
import { runExtract } from "./extract.js";
import type { KnownDimension } from "./prompt.js";
import { slotLabel } from "./slots.js";
import type { LlmDriver } from "./llm-driver.js";
import type { EmbeddingDriver } from "./embedding-driver.js";
import {
  bigrams,
  retrieveRelevant,
  statementText,
  type RetrievalHit,
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
    warnings?: string[];
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
  /** Exact source excerpts recovered from cold Episodes. They are scoped when
   * a caller supplies source ids and are never embedded (default 6). */
  maxEpisodeEvidenceLines?: number;
  /** Per-excerpt character cap for cold Episode evidence (default 1,600). */
  maxEpisodeExcerptChars?: number;
  /** Additional Claims reached through one shared core:about target
   * (default 4; 0 disables graph expansion). */
  maxGraphExpansionHits?: number;
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
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
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
    keys.set(d.id, slotLabel(graph, d));
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

const EVIDENCE_STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "what", "when", "where", "which", "who",
  "why", "how", "did", "does", "was", "were", "are", "for", "you", "your", "their", "they",
  "have", "has", "had", "about", "into", "would", "could", "should", "can", "our", "use",
  "used", "kind", "remind", "mentioned", "previous", "conversation", "thinking", "assistant", "user",
]);

function evidenceTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length < 3 || EVIDENCE_STOP_WORDS.has(token)) continue;
    terms.add(token);
    // Tiny, deterministic English morphology for local Episode matching.
    // This is intentionally not a general stemmer: it only bridges common
    // retrieval variants such as garden/gardening, travel/traveling and
    // mummy/mummies without changing the stored text.
    if (/^[a-z]+$/.test(token)) {
      if (token.length > 5 && token.endsWith("ies")) terms.add(`${token.slice(0, -3)}y`);
      else if (token.length > 5 && token.endsWith("ing")) terms.add(token.slice(0, -3));
      else if (token.length > 4 && token.endsWith("ed")) terms.add(token.slice(0, -2));
      else if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
        terms.add(token.slice(0, -1));
      }
    }
  }
  // Chinese and other no-whitespace text needs a second route. Prefixing the
  // feature prevents accidental equality with ordinary word tokens.
  if (/\p{Script=Han}/u.test(text)) {
    for (const pair of bigrams(text)) terms.add(`bg:${pair}`);
  }
  return terms;
}

function overlapCount(needles: ReadonlySet<string>, corpusTerms: ReadonlySet<string>): number {
  let count = 0;
  for (const term of needles) if (corpusTerms.has(term)) count++;
  return count;
}

function preferredEvidenceRole(query: string): "user" | "assistant" | undefined {
  if (/\b(?:you|assistant)\b.{0,28}\b(?:said|told|mentioned|recommended|suggested|wrote|gave)\b/i.test(query)) {
    return "assistant";
  }
  // "I'm looking back" / "remind me" is retrieval framing, not evidence
  // authorship. Only explicit possession or a predicate applied to "I"
  // identifies a user-authored fact.
  if (/\b(?:my|mine)\b|\b(?:did|do|have|had|was|were|when|where|what|how)\s+i\b/i.test(query)) {
    return "user";
  }
  return undefined;
}

/**
 * Split a long turn at semantic boundaries instead of slicing an arbitrary
 * character window. Short turns remain intact. Long Markdown answers retain
 * complete paragraphs / sections; oversized sections degrade to complete
 * list items or sentences, never a fragment that can cut off the payload.
 */
function episodeEvidenceUnits(content: string, maxChars: number): string[] {
  const text = content.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const blocks = text.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  const units: string[] = [];
  let pendingHeading: string | undefined;
  const headingOnly = /^(?:#{1,6}\s+.+|\*\*[^\n*]+\*\*:|[-*+]\s+.+:|(?:verse|chorus|bridge|outro)\s*:)$/i;
  const listLine = /^(?:[-*+]\s+|\d+[.)]\s+)/;

  const pushNatural = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (value.length <= maxChars) {
      units.push(value);
      return;
    }
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      let sectionHeading: string | undefined;
      for (const line of lines) {
        if (headingOnly.test(line)) {
          sectionHeading = line;
          continue;
        }
        const candidate = sectionHeading && (listLine.test(line) || line.length <= maxChars)
          ? `${sectionHeading}\n${line}`
          : line;
        if (candidate.length <= maxChars) units.push(candidate);
      }
      return;
    }
    for (const sentence of value.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)) {
      const candidate = sentence.trim();
      if (candidate && candidate.length <= maxChars) units.push(candidate);
    }
  };

  for (const block of blocks) {
    if (headingOnly.test(block)) {
      pendingHeading = block;
      continue;
    }
    const value = pendingHeading ? `${pendingHeading}\n${block}` : block;
    pendingHeading = undefined;
    pushNatural(value);
  }
  if (pendingHeading) pushNatural(pendingHeading);
  return units;
}

interface EpisodeSourceAnchor {
  sourceRef: string;
  rank: number;
  queryMatches: number;
  claims: Array<{
    terms: Set<string>;
    role?: string;
    rank: number;
  }>;
}

interface EpisodeEvidence {
  episode: EpisodeRecord;
  turn: EpisodeTurn;
  turnIndex: number;
  unitIndex: number;
  score: number;
  outOfScope: boolean;
}

interface RankedEpisodeUnit extends EpisodeEvidence {
  terms: Set<string>;
}

function localLexicalScore(
  needles: ReadonlySet<string>,
  unitTerms: ReadonlySet<string>,
  termWeights?: ReadonlyMap<string, number>,
): number {
  let weightedMatches = 0;
  for (const term of needles) {
    if (unitTerms.has(term)) weightedMatches += termWeights?.get(term) ?? 1;
  }
  if (weightedMatches === 0) return 0;
  // Episode-local inverse frequency stops a repeated topic word ("temple",
  // "construction") from drowning the rarer payload-bearing phrase. The
  // density term favors a precise list item over a generic long paragraph.
  return weightedMatches + (weightedMatches * 2) / Math.max(1, Math.sqrt(unitTerms.size));
}

/**
 * Claims are the hot index; Episodes are the cold, lossless source. Follow
 * provenance after a Claim hit, then use a scoped lexical fallback over cold
 * Episodes for themes the extractor missed entirely. No Message nodes or
 * per-turn vectors are created.
 */
function coldEpisodeEvidence(
  graph: MemoryGraph,
  query: string,
  hits: readonly RetrievalHit[],
  scopeSet: ReadonlySet<string> | undefined,
  maxLines: number,
  maxChars: number,
): EpisodeEvidence[] {
  if (maxLines <= 0) return [];
  const queryTerms = evidenceTerms(query);
  const preferredRole = preferredEvidenceRole(query);
  const anchors = new Map<string, EpisodeSourceAnchor>();
  hits.forEach((hit, rank) => {
    const statement = graph.getNode(hit.statementId) as StatementNode | undefined;
    if (!statement || statement.type !== "core:statement") return;
    for (const sourceRef of statement.source_refs ?? []) {
      if (!graph.getEpisode(sourceRef)) continue;
      const current = anchors.get(sourceRef) ?? {
        sourceRef,
        rank,
        queryMatches: 0,
        claims: [],
      };
      current.rank = Math.min(current.rank, rank);
      current.claims.push({
        terms: evidenceTerms(statementText(graph, statement)),
        role: statement.saidBy,
        rank,
      });
      anchors.set(sourceRef, current);
    }
  });

  // A Claim cannot lead back to a fact that was never extracted. Search only
  // the caller's Episode scope (or the single-tenant library when unscoped)
  // as a sparse, cold fallback. Requiring two meaningful query terms keeps
  // generic questions from turning this into a transcript dump.
  const episodeCandidates = scopeSet && scopeSet.size > 0
    ? [...scopeSet]
        .map((sourceRef) => graph.getEpisode(sourceRef))
        .filter((episode): episode is EpisodeRecord => Boolean(episode))
    : graph.getAllEpisodes();
  const minimumFallbackMatches = queryTerms.size <= 2 ? 1 : 2;
  for (const episode of episodeCandidates) {
    let queryMatches = 0;
    for (const turn of episode.turns) {
      queryMatches = Math.max(queryMatches, overlapCount(queryTerms, evidenceTerms(turn.content)));
    }
    const existing = anchors.get(episode.id);
    if (existing) {
      existing.queryMatches = queryMatches;
    } else if (queryMatches >= minimumFallbackMatches) {
      anchors.set(episode.id, {
        sourceRef: episode.id,
        rank: Number.POSITIVE_INFINITY,
        queryMatches,
        claims: [],
      });
    }
  }
  if (anchors.size === 0) return [];

  let ordered = [...anchors.values()].sort((a, b) => {
    const aScore = a.queryMatches * 10 + (a.claims.length > 0 ? 2 : 0);
    const bScore = b.queryMatches * 10 + (b.claims.length > 0 ? 2 : 0);
    return bScore - aScore || a.rank - b.rank;
  });
  if (scopeSet && scopeSet.size > 0) {
    const inScope = ordered.filter((anchor) => scopeSet.has(anchor.sourceRef));
    // Match grouped Claim behavior: cross-account evidence is a fallback,
    // never mixed into an account that already has source evidence.
    if (inScope.length > 0) ordered = inScope;
  }

  const perSource: EpisodeEvidence[][] = [];
  const maxSources = Math.max(1, Math.min(5, maxLines));
  for (const anchor of ordered.slice(0, maxSources)) {
    const episode = graph.getEpisode(anchor.sourceRef);
    if (!episode) continue;
    const units = episode.turns
      .flatMap((turn, turnIndex) =>
        episodeEvidenceUnits(turn.content, maxChars).map((content, unitIndex) => {
          const unitTerms = evidenceTerms(content);
          return {
            episode,
            turn: { ...turn, content },
            turnIndex,
            unitIndex,
            score: 0,
            terms: unitTerms,
            outOfScope: Boolean(scopeSet?.size && !scopeSet.has(anchor.sourceRef)),
          } satisfies RankedEpisodeUnit;
        }),
      )
      .filter((candidate) => candidate.turn.content.trim().length > 0);
    if (units.length === 0) continue;
    const documentFrequency = new Map<string, number>();
    for (const unit of units) {
      for (const term of unit.terms) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const termWeights = new Map(
      [...documentFrequency].map(([term, frequency]) => [
        term,
        Math.log(1 + (units.length + 1) / (frequency + 1)),
      ]),
    );

    // Do not collapse all anchor Claims into one max score. Each Claim is a
    // separate route back into the Episode and gets to nominate evidence of
    // its own. This preserves details adjacent to a concise Claim (breed near
    // a collar choice, a count inside a long encounter, etc.) instead of
    // letting the broadest Claim monopolize every local result.
    const roleCompatibleClaims = preferredRole && anchor.claims.some((claim) => claim.role === preferredRole)
      ? anchor.claims.filter((claim) => claim.role === preferredRole)
      : anchor.claims;
    const bestClaimRank = Math.min(...roleCompatibleClaims.map((claim) => claim.rank));
    const nearbyClaims = roleCompatibleClaims.filter((claim) => claim.rank <= bestClaimRank + 2);
    const claimsByQueryFit = nearbyClaims
      .map((claim) => ({ claim, queryFit: overlapCount(queryTerms, claim.terms) }))
      .sort((a, b) => b.queryFit - a.queryFit || a.claim.rank - b.claim.rank);
    const queryMatchingClaims = claimsByQueryFit.filter((entry) => entry.queryFit > 0);
    const bestQueryFit = queryMatchingClaims[0]?.queryFit ?? 0;
    const focusedClaims = bestQueryFit > 0
      ? queryMatchingClaims.filter((entry) => entry.queryFit >= Math.max(1, Math.ceil(bestQueryFit * 0.6)))
      : claimsByQueryFit;
    const nominatedClaims = focusedClaims
      .slice(0, 3)
      .map((entry) => entry.claim);

    const lanes: RankedEpisodeUnit[][] = nominatedClaims.map((claim) => {
      const rankWeight = Number.isFinite(claim.rank) ? 1 / Math.sqrt(claim.rank + 1) : 0.25;
      return units
        .map((unit) => {
          const queryFit = localLexicalScore(queryTerms, unit.terms, termWeights);
          const claimFit = localLexicalScore(claim.terms, unit.terms, termWeights);
          const speakerFit = claim.role === unit.turn.role ? 6 : 0;
          const preferredSpeakerFit = preferredRole === unit.turn.role ? 2 : 0;
          return {
            ...unit,
            // The question chooses among evidence nominated by this Claim;
            // Claim vocabulary bridges paraphrases; speaker is a tie-breaker.
            score:
              queryFit * 8 +
              claimFit * (3 + rankWeight) +
              speakerFit +
              preferredSpeakerFit,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort(
          (a, b) =>
            Number(b.turn.role === claim.role) - Number(a.turn.role === claim.role) ||
            b.score - a.score ||
            a.turnIndex - b.turnIndex ||
            a.unitIndex - b.unitIndex,
        );
    });

    // If this Episode was found only by the scoped cold fallback, the query
    // itself is its nomination lane. It is also a safe fallback for a Claim
    // whose vocabulary has no surviving overlap with any semantic unit.
    if (lanes.length === 0 || lanes.every((lane) => lane.length === 0)) {
      lanes.push(
        units
          .map((unit) => ({
            ...unit,
            score:
              localLexicalScore(queryTerms, unit.terms, termWeights) * 8 +
              (preferredRole === unit.turn.role ? 2 : 0),
          }))
          .filter((candidate) => candidate.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.turnIndex - b.turnIndex ||
              a.unitIndex - b.unitIndex,
          ),
      );
    }

    // Round-robin the Claim lanes as well as the Episode lanes. First-pass
    // evidence covers distinct semantic anchors; later passes recover nearby
    // detail without increasing the configured line or character budget.
    const rankedUnits: EpisodeEvidence[] = [];
    const emitted = new Set<string>();
    const cursors = lanes.map(() => 0);
    while (rankedUnits.length < units.length) {
      let added = false;
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        const lane = lanes[laneIndex]!;
        let candidate: RankedEpisodeUnit | undefined;
        while (cursors[laneIndex]! < lane.length) {
          const next = lane[cursors[laneIndex]!]!;
          cursors[laneIndex]! += 1;
          const key = `${next.turnIndex}:${next.unitIndex}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          candidate = next;
          break;
        }
        if (!candidate) continue;
        const { terms: _terms, ...evidence } = candidate;
        rankedUnits.push(evidence);
        added = true;
      }
      if (!added) break;
    }
    if (rankedUnits.length > 0) perSource.push(rankedUnits);
  }

  // Episode quota comes before global competition: every high-ranked source
  // gets one semantic unit before any source gets a second. This prevents one
  // verbose assistant response from starving another relevant Episode.
  const selected: EpisodeEvidence[] = [];
  const selectedContent = new Set<string>();
  const maxTotalChars = maxLines * maxChars; // never exceeds the old worst-case budget
  let selectedChars = 0;
  for (let round = 0; selected.length < maxLines; round++) {
    let added = false;
    for (const source of perSource) {
      const candidate = source[round];
      if (!candidate) continue;
      const normalized = candidate.turn.content.toLowerCase().replace(/\s+/g, " ");
      if (selectedContent.has(normalized)) continue;
      if (selectedChars + candidate.turn.content.length > maxTotalChars) continue;
      selected.push(candidate);
      selectedContent.add(normalized);
      selectedChars += candidate.turn.content.length;
      added = true;
      if (selected.length >= maxLines) break;
    }
    if (!added) break;
  }
  return selected;
}

/** Strictly bounded one-hop expansion through a shared core:about target. */
function aboutRelatedHits(
  graph: MemoryGraph,
  query: string,
  directHits: readonly RetrievalHit[],
  config: RetrievalConfig,
): RetrievalHit[] {
  const limit = config.maxGraphExpansionHits ?? 4;
  if (limit <= 0 || directHits.length === 0) return [];
  const directIds = new Set(directHits.map((hit) => hit.statementId));
  const directDims = new Set(directHits.map((hit) => hit.dimensionId));
  const targets = new Set<string>();
  for (const hit of directHits.slice(0, 6)) {
    for (const edge of graph.queryEdges({ type: "core:about", from: hit.statementId })) {
      targets.add(edge.to);
    }
  }
  if (targets.size === 0) return [];

  const candidateIds = new Set<string>();
  for (const target of targets) {
    for (const edge of graph.queryEdges({ type: "core:about", to: target })) {
      if (!directIds.has(edge.from)) candidateIds.add(edge.from);
    }
  }
  const queryTerms = evidenceTerms(query);
  const scopeSet = config.scopeSessionIds ? new Set(config.scopeSessionIds) : undefined;
  const candidates = [...candidateIds]
    .map((id) => graph.getNode(id))
    .filter((node): node is StatementNode => Boolean(node && node.type === "core:statement"))
    .filter((statement) => !directDims.has(statement.dimension_id))
    .filter((statement) => !config.states || config.states.includes(statement.state))
    .filter((statement) => {
      const day = statement.created_at.slice(0, 10).replace(/\//g, "-");
      return (!config.dateFrom || day >= config.dateFrom) && (!config.dateTo || day <= config.dateTo);
    })
    .map((statement) => ({
      statement,
      lexical: overlapCount(queryTerms, evidenceTerms(statementText(graph, statement))),
      inScope: !scopeSet || statement.source_refs.some((ref) => scopeSet.has(ref)),
    }));
  const inScope = candidates.filter((candidate) => candidate.inScope);
  const pool = scopeSet && inScope.length > 0 ? inScope : candidates;
  return pool
    .sort((a, b) =>
      Number(b.inScope) - Number(a.inScope) ||
      b.lexical - a.lexical ||
      b.statement.created_at.localeCompare(a.statement.created_at),
    )
    .slice(0, limit)
    .map(({ statement, lexical }) => {
      const dimension = graph.getNode(statement.dimension_id) as DimensionNode | undefined;
      return {
        nodeType: "statement" as const,
        statementId: statement.id,
        dimensionId: statement.dimension_id,
        dimensionKey: dimension?.key ?? "?",
        value: statement.value,
        state: statement.state,
        score: lexical,
        via: ["graph:about"],
      };
    });
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
  const semanticHitLimit = config.k ?? 8;
  const hits = await retrieveRelevant(graph, {
    query,
    // Statements and verbatim evidence are complementary lanes. Search a
    // wider pool so message chunks cannot consume every semantic-dimension
    // slot, and exact payloads buried in a long source response remain
    // available for provenance-aware promotion below.
    k: Math.max(semanticHitLimit * 4, 32),
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
  const directStatementHits = hits
    .filter((hit) => hit.nodeType !== "message")
    .slice(0, semanticHitLimit);
  const statementHits = [
    ...directStatementHits,
    ...aboutRelatedHits(graph, query, directStatementHits, config),
  ];
  const sourcePriority = new Map<string, number>();
  directStatementHits.forEach((hit, statementRank) => {
    for (const sourceRef of graph.getNode(hit.statementId)?.source_refs ?? []) {
      if (!sourcePriority.has(sourceRef)) sourcePriority.set(sourceRef, statementRank);
    }
  });
  const rankedMessages = hits
    .filter((hit) => hit.nodeType === "message")
    .map((hit, rank) => ({ hit, rank }))
    .map((entry) => ({
      ...entry,
      sourceRank: Math.min(
        ...(graph.getNode(entry.hit.statementId)?.source_refs ?? []).map(
          (ref) => sourcePriority.get(ref) ?? Number.POSITIVE_INFINITY,
        ),
        Number.POSITIVE_INFINITY,
      ),
    }));
  // Take a small bundle from each of the best semantic sources. This follows
  // provenance from a concise statement back to the exact response that
  // produced it, while preventing one long conversation from monopolizing
  // every evidence slot.
  const messageHits: typeof hits = [];
  const sourceRanks = [...new Set(rankedMessages.map((entry) => entry.sourceRank))].sort(
    (a, b) => a - b,
  );
  for (const sourceRank of sourceRanks) {
    const group = rankedMessages
      .filter((entry) => entry.sourceRank === sourceRank)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3);
    messageHits.push(...group.map(({ hit }) => hit));
    if (messageHits.length >= 6) break;
  }

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
  const maxEvidenceLines = Math.min(config.maxEpisodeEvidenceLines ?? 6, maxLines);
  const coldEvidence = coldEpisodeEvidence(
    graph,
    query,
    directStatementHits,
    scopeSet,
    maxEvidenceLines,
    config.maxEpisodeExcerptChars ?? 1_600,
  );
  const evidenceContent = new Set<string>();
  for (const evidence of coldEvidence) {
    if (lines.length >= maxLines || lines.length >= maxEvidenceLines) break;
    const tag = evidence.outOfScope ? " (non-user-account)" : "";
    evidenceContent.add(evidence.turn.content);
    lines.push(
      `conversationEvidence (verbatim ${evidence.turn.role} @${evidence.episode.created_at.slice(0, 10)}, source ${evidence.episode.id}, turn ${evidence.turnIndex})${tag}: ${JSON.stringify(evidence.turn.content)}`,
    );
  }
  // Verbatim evidence is rendered directly, not grouped into mutable fact
  // dimensions. Cap it so exact payloads are available without letting long
  // source messages crowd all semantic memories out of the context window.
  for (const hit of messageHits.slice(0, Math.max(0, maxEvidenceLines - lines.length))) {
    if (lines.length >= maxLines || lines.length >= maxEvidenceLines) break;
    const node = graph.getNode(hit.statementId);
    if (!node) continue;
    const value = String(hit.value ?? "");
    if (evidenceContent.has(value)) continue;
    const fallbackOut =
      scopeSet !== undefined &&
      scopeSet.size > 0 &&
      !(node.source_refs ?? []).some((sourceRef) => scopeSet.has(sourceRef));
    const tag = fallbackOut ? " (non-user-account)" : "";
    lines.push(
      `conversationEvidence (verbatim ${hit.role ?? "user"} @${node.created_at.slice(0, 10)})${tag}: ${JSON.stringify(hit.value)}`,
    );
  }

  const hitDims = [...new Set(statementHits.map((h) => h.dimensionId))];
  for (const dimId of hitDims) {
    const allMembers = membersByDim.get(dimId) ?? [];
    const scoped = scopeSet ? allMembers.filter(inScopeOf) : [];
    const members = scoped.length > 0 ? scoped : allMembers;
    const dimension = dimById.get(dimId);
    const key = dimension
      ? slotLabel(graph, dimension)
      : statementHits.find((h) => h.dimensionId === dimId)?.dimensionKey ?? "?";
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
  for (const hit of directStatementHits) {
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
