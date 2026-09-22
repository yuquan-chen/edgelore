// edgelore · Fact Reconciler — compare Statements without self-adjudicating.
//
// Graph enrichment answers "what is this fact about?". This module answers a
// different question: "how does this Statement relate to an earlier one?".
// Deterministic rules run first; an Agent may classify ambiguous pairs, but its
// output remains a proposal until an authorized principal applies it.

import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import type { DimensionNode, GraphEdge, StatementNode } from "../model/types.js";
import { valuesEqual } from "./capture.js";
import { AgentError } from "./errors.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";

export type FactRelationKind =
  | "duplicate"
  | "refines"
  | "supersedes"
  | "contradicts"
  | "independent";

export interface FactRelationProposal {
  /** The newly considered Statement. Relation direction is subject -> object. */
  subjectId: string;
  /** An existing candidate Statement. */
  objectId: string;
  relation: FactRelationKind;
  basis: "deterministic" | "agent";
  confidence: number;
  reason: string;
  /** Agent judgments and every supersession require authorization to apply. */
  requiresApproval: boolean;
}

export interface ReconcileResult {
  statementId: string;
  proposals: FactRelationProposal[];
  /** Candidate ids left undecided when no Agent driver was supplied or when
   * the Agent omitted a pair. Nothing is guessed. */
  unresolvedIds: string[];
}

export interface ReconcileOptions {
  driver?: LlmDriver;
  maxCandidates?: number;
}

export interface ApplyFactRelationOptions {
  /** Required for Agent proposals and all supersession decisions. */
  approvedBy?: string;
  note?: string;
}

export interface ApplyFactRelationResult {
  relation: FactRelationKind;
  edgeId?: string;
  subjectState: string;
  objectState: string;
}

interface ReconciliationCandidate {
  statement: StatementNode;
  dimension: DimensionNode;
  sharedAbout: string[];
  /** capture() may already have flagged an incompatible single-value pair.
   * The Reconciler may still distinguish a temporal replacement from a
   * standing contradiction. */
  preFlaggedContradiction: boolean;
}

const EPISTEMIC_EDGE_TYPES = [
  "core:equivalent_to",
  "core:refines",
  "core:supersedes",
  "core:contradicts",
] as const;

/**
 * Compare one Statement with relevant live neighbors.
 *
 * Candidate generation is graph-native: same Dimension OR a shared
 * `core:about` entity/event. Exact duplicates and single-cardinality clashes
 * are deterministic. All other pairs are left unresolved unless a driver is
 * supplied, in which case one bounded Agent call classifies them together.
 */
export async function reconcileStatement(
  graph: GraphStore,
  statementId: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const subject = requireStatement(graph, statementId);
  const subjectDimension = requireDimension(graph, subject.dimension_id);
  const candidates = reconciliationCandidates(
    graph,
    subject,
    options.maxCandidates ?? 12,
  );
  const proposals: FactRelationProposal[] = [];
  const ambiguous: ReconciliationCandidate[] = [];

  for (const candidate of candidates) {
    const deterministic = deterministicProposal(
      subject,
      subjectDimension,
      candidate.statement,
      candidate.dimension,
      !options.driver,
    );
    if (deterministic) proposals.push(deterministic);
    else ambiguous.push(candidate);
  }

  if (!options.driver || ambiguous.length === 0) {
    return {
      statementId,
      proposals,
      unresolvedIds: ambiguous.map((candidate) => candidate.statement.id),
    };
  }

  const reply = parseJsonReply(
    await options.driver.complete(
      buildFactReconciliationPrompt(subject, subjectDimension, ambiguous),
    ),
  );
  const agent = normalizeAgentDecisions(reply, subject.id, ambiguous);
  proposals.push(...agent.proposals);
  return {
    statementId,
    proposals,
    unresolvedIds: agent.unresolvedIds,
  };
}

/**
 * Apply one proposal through the governance boundary.
 *
 * Agent proposals require a human approver. Supersession always requires a
 * human because it changes which fact is current. Deterministic duplicate,
 * refinement, and contradiction relations can be materialized by the runtime;
 * contradiction detection does not choose a winner.
 */
export function applyFactRelationProposal(
  graph: GraphStore,
  proposal: FactRelationProposal,
  options: ApplyFactRelationOptions = {},
): ApplyFactRelationResult {
  const subject = requireStatement(graph, proposal.subjectId);
  const object = requireStatement(graph, proposal.objectId);
  validateApplicableProposal(graph, proposal, subject, object);
  if (proposal.relation === "independent") {
    return {
      relation: proposal.relation,
      subjectState: subject.state,
      objectState: object.state,
    };
  }
  const approvalRequired = proposal.requiresApproval || proposal.basis === "agent" || proposal.relation === "supersedes";
  if (approvalRequired && !options.approvedBy?.startsWith("human:")) {
    throw new AgentError(
      `applying ${proposal.relation} requires approvedBy human:<id>`,
    );
  }
  const createdBy = options.approvedBy ?? "agent:edgelore:reconciler";
  return graph.transaction(() => {
    const edgeType = relationEdgeType(proposal.relation);
    let edge = findRelation(graph, edgeType, subject.id, object.id);
    if (!edge) {
      edge = graph.addEdge({
        type: edgeType,
        from: subject.id,
        to: object.id,
        scope: subject.scope,
        created_by: createdBy,
        source_refs: [...new Set([...subject.source_refs, ...object.source_refs])],
        attributes: {
          reconciliation: true,
          basis: proposal.basis,
          confidence: proposal.confidence,
          reason: proposal.reason,
          note: options.note ?? "",
        },
      });
    }

    if (proposal.relation === "contradicts" && subject.dimension_id === object.dimension_id) {
      const dimension = requireDimension(graph, subject.dimension_id);
      if (dimension.state !== "conflict") {
        graph.transitionNodeState(dimension.id, "conflict");
      }
    }
    if (proposal.relation === "supersedes") {
      if (subject.state === "tentative") graph.transitionNodeState(subject.id, "accepted");
      if (object.state !== "superseded") graph.transitionNodeState(object.id, "superseded");
      for (const dimensionId of new Set([subject.dimension_id, object.dimension_id])) {
        restoreDimensionIfSettled(graph, dimensionId);
      }
    }

    const finalSubject = requireStatement(graph, subject.id);
    const finalObject = requireStatement(graph, object.id);
    return {
      relation: proposal.relation,
      edgeId: edge.id,
      subjectState: finalSubject.state,
      objectState: finalObject.state,
    };
  });
}

function reconciliationCandidates(
  graph: GraphStore,
  subject: StatementNode,
  limit: number,
): ReconciliationCandidate[] {
  const live = (graph.queryNodes({ type: "core:statement" }) as StatementNode[]).filter(
    (statement) =>
      statement.id !== subject.id &&
      statement.state !== "rejected" &&
      statement.state !== "superseded" &&
      scopesEqual(statement.scope, subject.scope),
  );
  const subjectAbout = aboutTargets(graph, subject.id);
  const candidates: ReconciliationCandidate[] = [];
  for (const statement of live) {
    if (alreadyReconciled(graph, subject.id, statement.id)) continue;
    const sharedAbout = aboutTargets(graph, statement.id).filter((id) => subjectAbout.includes(id));
    if (statement.dimension_id !== subject.dimension_id && sharedAbout.length === 0) continue;
    candidates.push({
      statement,
      dimension: requireDimension(graph, statement.dimension_id),
      sharedAbout,
      preFlaggedContradiction: hasRelation(
        graph,
        "core:contradicts",
        subject.id,
        statement.id,
      ),
    });
  }
  return candidates
    .sort((a, b) => b.statement.created_at.localeCompare(a.statement.created_at))
    .slice(0, Math.max(0, limit));
}

function deterministicProposal(
  subject: StatementNode,
  subjectDimension: DimensionNode,
  object: StatementNode,
  objectDimension: DimensionNode,
  classifySingleClash = true,
): FactRelationProposal | null {
  if (valuesEqual(subject.value, object.value) || normalizedValue(subject.value) === normalizedValue(object.value)) {
    return proposal(subject.id, object.id, "duplicate", "deterministic", 1, "normalized values are equal");
  }
  if (
    classifySingleClash &&
    subject.dimension_id === object.dimension_id &&
    subjectDimension.cardinality === "single" &&
    objectDimension.cardinality === "single"
  ) {
    return proposal(
      subject.id,
      object.id,
      "contradicts",
      "deterministic",
      1,
      "different live values in the same single-cardinality Dimension",
    );
  }
  return null;
}

function proposal(
  subjectId: string,
  objectId: string,
  relation: FactRelationKind,
  basis: "deterministic" | "agent",
  confidence: number,
  reason: string,
): FactRelationProposal {
  return {
    subjectId,
    objectId,
    relation,
    basis,
    confidence,
    reason,
    requiresApproval:
      relation !== "independent" && (basis === "agent" || relation === "supersedes"),
  };
}

function validateApplicableProposal(
  graph: GraphStore,
  proposal: FactRelationProposal,
  subject: StatementNode,
  object: StatementNode,
): void {
  if (!isFactRelationKind(proposal.relation)) {
    throw new AgentError(`invalid fact relation: ${String(proposal.relation)}`);
  }
  if (proposal.basis !== "deterministic" && proposal.basis !== "agent") {
    throw new AgentError(`invalid fact reconciliation basis: ${String(proposal.basis)}`);
  }
  if (subject.id === object.id) throw new AgentError("a Statement cannot reconcile with itself");
  if (!scopesEqual(subject.scope, object.scope)) {
    throw new AgentError("fact reconciliation cannot cross graph scopes");
  }
  if (
    subject.state === "rejected" ||
    subject.state === "superseded" ||
    object.state === "rejected" ||
    object.state === "superseded"
  ) {
    throw new AgentError("fact reconciliation requires two live Statements");
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    throw new AgentError("fact reconciliation confidence must be between 0 and 1");
  }
  if (typeof proposal.reason !== "string" || proposal.reason.trim().length === 0) {
    throw new AgentError("fact reconciliation reason must be non-empty");
  }

  const sameDimension = subject.dimension_id === object.dimension_id;
  const subjectAbout = new Set(aboutTargets(graph, subject.id));
  const sharedAbout = aboutTargets(graph, object.id).some((id) => subjectAbout.has(id));
  if (!sameDimension && !sharedAbout) {
    throw new AgentError("fact reconciliation requires a shared Dimension or core:about target");
  }

  if (proposal.basis === "deterministic") {
    const expected = deterministicProposal(
      subject,
      requireDimension(graph, subject.dimension_id),
      object,
      requireDimension(graph, object.dimension_id),
    );
    if (!expected || expected.relation !== proposal.relation) {
      throw new AgentError("deterministic fact proposal does not match deterministic rules");
    }
  }
}

function buildFactReconciliationPrompt(
  subject: StatementNode,
  subjectDimension: DimensionNode,
  candidates: readonly ReconciliationCandidate[],
): string {
  const row = (
    statement: StatementNode,
    dimension: DimensionNode,
    sharedAbout: string[],
    preFlaggedContradiction = false,
  ) => ({
    statementId: statement.id,
    dimensionKey: dimension.key,
    value: statement.value,
    state: statement.state,
    saidBy: statement.saidBy,
    createdAt: statement.created_at,
    sharedAbout,
    preFlaggedContradiction,
  });
  return [
    "You are a Fact Reconciler. Compare one new Statement with existing live Statements.",
    "Classify meaning, not topic. Return exactly one relation per candidate:",
    "duplicate = materially the same claim; refines = compatible added detail; supersedes = explicitly updates or corrects the older claim; contradicts = cannot both be true in the same context; independent = related topic but separate facts.",
    "preFlaggedContradiction only means storage saw different values in a single-cardinality Dimension. It may be a true contradiction or an explicit temporal update; decide from the claim text.",
    "Do not decide which contradictory fact wins. Do not output provenance, state changes, or graph ids other than the supplied statementId.",
    `New Statement:\n${JSON.stringify(row(subject, subjectDimension, []))}`,
    `Candidates:\n${JSON.stringify(candidates.map((candidate) => row(candidate.statement, candidate.dimension, candidate.sharedAbout, candidate.preFlaggedContradiction)))}`,
    'Respond with ONLY: {"decisions":[{"statementId":"<candidate id>","relation":"duplicate|refines|supersedes|contradicts|independent","confidence":0.0,"reason":"short evidence-based reason"}]}',
  ].join("\n\n");
}

function normalizeAgentDecisions(
  raw: unknown,
  subjectId: string,
  candidates: readonly ReconciliationCandidate[],
): { proposals: FactRelationProposal[]; unresolvedIds: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentError("fact reconciler reply must be a JSON object");
  }
  const decisions = (raw as Record<string, unknown>).decisions;
  if (!Array.isArray(decisions)) {
    throw new AgentError('fact reconciler field "decisions" must be an array');
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.statement.id));
  const seen = new Set<string>();
  const proposals: FactRelationProposal[] = [];
  for (const rawDecision of decisions) {
    if (typeof rawDecision !== "object" || rawDecision === null || Array.isArray(rawDecision)) {
      throw new AgentError("fact reconciler decision must be an object");
    }
    const decision = rawDecision as Record<string, unknown>;
    if (typeof decision.statementId !== "string" || !candidateIds.has(decision.statementId)) {
      throw new AgentError(`fact reconciler decision has unknown statementId: ${String(decision.statementId)}`);
    }
    if (seen.has(decision.statementId)) {
      throw new AgentError(`fact reconciler repeats statementId: ${decision.statementId}`);
    }
    if (!isFactRelationKind(decision.relation)) {
      throw new AgentError(`fact reconciler has invalid relation: ${String(decision.relation)}`);
    }
    if (
      typeof decision.confidence !== "number" ||
      !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 ||
      decision.confidence > 1
    ) {
      throw new AgentError("fact reconciler confidence must be between 0 and 1");
    }
    if (typeof decision.reason !== "string" || decision.reason.trim().length === 0) {
      throw new AgentError("fact reconciler reason must be a non-empty string");
    }
    seen.add(decision.statementId);
    proposals.push(
      proposal(
        subjectId,
        decision.statementId,
        decision.relation,
        "agent",
        decision.confidence,
        decision.reason.trim(),
      ),
    );
  }
  return {
    proposals,
    unresolvedIds: [...candidateIds].filter((id) => !seen.has(id)),
  };
}

function normalizedValue(value: unknown): string {
  if (typeof value === "string") {
    return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
  }
  return JSON.stringify(value) ?? String(value);
}

function aboutTargets(graph: GraphStore, statementId: string): string[] {
  return graph.queryEdges({ type: "core:about", from: statementId }).map((edge) => edge.to);
}

function alreadyReconciled(graph: GraphStore, a: string, b: string): boolean {
  return EPISTEMIC_EDGE_TYPES.filter((type) => type !== "core:contradicts").some((type) =>
    hasRelation(graph, type, a, b),
  );
}

function hasRelation(graph: GraphStore, type: string, a: string, b: string): boolean {
  return (
    graph.queryEdges({ type, from: a, to: b }).length > 0 ||
    graph.queryEdges({ type, from: b, to: a }).length > 0
  );
}

function findRelation(
  graph: GraphStore,
  type: string,
  from: string,
  to: string,
): GraphEdge | undefined {
  return graph.queryEdges({ type, from, to })[0];
}

function relationEdgeType(relation: FactRelationKind): string {
  if (relation === "independent") {
    throw new AgentError("independent facts do not create a relation edge");
  }
  if (relation === "duplicate") return "core:equivalent_to";
  return `core:${relation}`;
}

function restoreDimensionIfSettled(graph: GraphStore, dimensionId: string): void {
  const dimension = requireDimension(graph, dimensionId);
  if (dimension.state !== "conflict") return;
  const liveIds = new Set(
    (graph.queryNodes({ type: "core:statement" }) as StatementNode[])
      .filter(
        (statement) =>
          statement.dimension_id === dimensionId &&
          statement.state !== "rejected" &&
          statement.state !== "superseded",
      )
      .map((statement) => statement.id),
  );
  const stillConflicted = graph
    .queryEdges({ type: "core:contradicts" })
    .some((edge) => liveIds.has(edge.from) && liveIds.has(edge.to));
  if (!stillConflicted) graph.transitionNodeState(dimensionId, "accepted");
}

function isFactRelationKind(value: unknown): value is FactRelationKind {
  return (
    value === "duplicate" ||
    value === "refines" ||
    value === "supersedes" ||
    value === "contradicts" ||
    value === "independent"
  );
}

function requireStatement(graph: GraphStore, id: string): StatementNode {
  const node = graph.getNode(id);
  if (!node || node.type !== "core:statement") throw new AgentError(`statement not found: ${id}`);
  return node as StatementNode;
}

function requireDimension(graph: GraphStore, id: string): DimensionNode {
  const node = graph.getNode(id);
  if (!node || node.type !== "core:dimension") throw new AgentError(`dimension not found: ${id}`);
  return node as DimensionNode;
}
