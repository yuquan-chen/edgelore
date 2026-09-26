// edgelore · Fact Reconciler — compare Statements without self-adjudicating.
//
// Graph enrichment answers "what is this fact about?". This module answers a
// different question: "how does this Statement relate to an earlier one?".
// Deterministic rules run first; an Agent may classify ambiguous pairs, but its
// output remains a proposal until an authorized principal applies it.

import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import type {
  Constraint,
  DimensionNode,
  GraphEdge,
  GraphNode,
  StatementNode,
} from "../model/types.js";
import { valuesEqual } from "./capture.js";
import type { DecisionDriver } from "./decision.js";
import { AgentError } from "./errors.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import { SCOPE_OWNER_SUBJECT, slotPropertyKey, slotSubjectRef } from "./slots.js";

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
  /** Read-only context selected by the Agent before its final decision. */
  readRequests: FactReconciliationReadRequest[];
}

export interface ReconcileOptions {
  /** Fast typed classifier (for example Jev). Uncertain rows fall through to driver. */
  decision?: DecisionDriver;
  driver?: LlmDriver;
  maxCandidates?: number;
  /** Restrict candidates to the exact Slot. Conflict resolution enables this. */
  sameDimensionOnly?: boolean;
  /** Minimum Jev confidence accepted as a proposal. Defaults to 0.85. */
  decisionMinConfidence?: number;
  /** Zero disables self-directed reads. Defaults to 3 and is capped at 3. */
  maxReadRequests?: number;
}

export type FactReconciliationReadTool =
  | "slot_context"
  | "episode_evidence"
  | "local_graph"
  | "relation_history"
  | "constraint_summary";

export interface FactReconciliationReadRequest {
  tool: FactReconciliationReadTool;
  /** Must be one of the supplied Candidate statement ids. */
  statementId: string;
}

export interface ApplyFactRelationOptions {
  /** Required for Agent proposals and all supersession decisions. */
  approvedBy?: string;
  note?: string;
}

export interface ApplyAgentFactRelationOptions {
  /** Audit principal for the autonomous decision. */
  resolvedBy: string;
  /** Minimum model confidence after provenance checks. Defaults to 0.85. */
  minConfidence?: number;
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
    options.sameDimensionOnly ?? false,
  );
  const proposals: FactRelationProposal[] = [];
  const ambiguous: ReconciliationCandidate[] = [];

  for (const candidate of candidates) {
    const deterministic = deterministicProposal(
      subject,
      subjectDimension,
      candidate.statement,
      candidate.dimension,
      !options.driver && !options.decision,
    );
    if (deterministic) proposals.push(deterministic);
    else ambiguous.push(candidate);
  }

  if (ambiguous.length === 0) {
    return {
      statementId,
      proposals,
      unresolvedIds: ambiguous.map((candidate) => candidate.statement.id),
      readRequests: [],
    };
  }

  let remaining = ambiguous;
  if (options.decision) {
    try {
      const fast = await classifyWithDecisionDriver(
        graph,
        subject,
        subjectDimension,
        ambiguous,
        options.decision,
        normalizeDecisionMinConfidence(options.decisionMinConfidence),
      );
      proposals.push(...fast.proposals);
      remaining = fast.unresolved;
    } catch {
      // The decision layer is an optimization, never a dependency. The full
      // Agent below remains the correctness fallback.
      remaining = ambiguous;
    }
  }

  if (!options.driver || remaining.length === 0) {
    return {
      statementId,
      proposals,
      unresolvedIds: remaining.map((candidate) => candidate.statement.id),
      readRequests: [],
    };
  }

  const maxReadRequests = normalizeMaxReadRequests(options.maxReadRequests);
  const initialPrompt = buildFactReconciliationPrompt(
    graph,
    subject,
    subjectDimension,
    remaining,
    maxReadRequests > 0,
  );
  const initialReply = parseJsonReply(await options.driver.complete(initialPrompt));
  const readRequests = normalizeReadRequests(
    initialReply,
    remaining,
    maxReadRequests,
  );
  const decisionReply =
    readRequests.length === 0
      ? initialReply
      : parseJsonReply(
          await options.driver.complete(
            buildFactReconciliationFollowupPrompt(
              initialPrompt,
              executeReadRequests(graph, subject, remaining, readRequests),
            ),
          ),
        );
  const agent = normalizeAgentDecisions(decisionReply, subject.id, remaining);
  proposals.push(...agent.proposals);
  return {
    statementId,
    proposals,
    unresolvedIds: agent.unresolvedIds,
    readRequests,
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
  return materializeFactRelationProposal(graph, proposal, subject, object, createdBy, options.note);
}

/**
 * Apply a high-confidence Agent supersession through a narrow provenance gate.
 *
 * This is deliberately separate from human approval. The Agent may only make
 * the already-newer tentative value current when both Statements belong to
 * the same single-value Slot and came through the same authority and speaker
 * channel. Anything less certain stays in the human conflict docket.
 */
export function applyAgentFactRelationProposal(
  graph: GraphStore,
  proposal: FactRelationProposal,
  options: ApplyAgentFactRelationOptions,
): ApplyFactRelationResult {
  const subject = requireStatement(graph, proposal.subjectId);
  const object = requireStatement(graph, proposal.objectId);
  validateApplicableProposal(graph, proposal, subject, object);
  if (!options.resolvedBy.startsWith("agent:")) {
    throw new AgentError("Agent resolution requires resolvedBy agent:<name>:<id>");
  }
  const minConfidence = options.minConfidence ?? 0.85;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new AgentError("Agent resolution minConfidence must be between 0 and 1");
  }
  if (proposal.basis !== "agent" || proposal.relation !== "supersedes") {
    throw new AgentError("Agent resolution may only apply Agent supersedes proposals");
  }
  if (proposal.confidence < minConfidence) {
    throw new AgentError(
      `Agent supersession confidence ${proposal.confidence} is below ${minConfidence}`,
    );
  }
  const dimension = requireDimension(graph, subject.dimension_id);
  if (
    subject.dimension_id !== object.dimension_id ||
    dimension.cardinality !== "single" ||
    subject.state !== "tentative" ||
    object.state !== "accepted" ||
    subject.created_by !== object.created_by ||
    subject.saidBy === undefined ||
    subject.saidBy !== object.saidBy ||
    subject.created_at <= object.created_at
  ) {
    throw new AgentError(
      "Agent supersession requires a newer tentative Claim in the same single Slot, from the same authority and speaker channel",
    );
  }
  return materializeFactRelationProposal(
    graph,
    proposal,
    subject,
    object,
    options.resolvedBy,
    options.note,
  );
}

function materializeFactRelationProposal(
  graph: GraphStore,
  proposal: FactRelationProposal,
  subject: StatementNode,
  object: StatementNode,
  createdBy: string,
  note?: string,
): ApplyFactRelationResult {
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
          note: note ?? "",
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
  sameDimensionOnly: boolean,
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
    if (sameDimensionOnly && statement.dimension_id !== subject.dimension_id) continue;
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

function normalizeDecisionMinConfidence(value: number | undefined): number {
  if (value === undefined) return 0.85;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AgentError("fact reconciler decisionMinConfidence must be between 0 and 1");
  }
  return value;
}

async function classifyWithDecisionDriver(
  graph: GraphStore,
  subject: StatementNode,
  subjectDimension: DimensionNode,
  candidates: readonly ReconciliationCandidate[],
  driver: DecisionDriver,
  minConfidence: number,
): Promise<{
  proposals: FactRelationProposal[];
  unresolved: ReconciliationCandidate[];
}> {
  const questions: Record<
    string,
    { instructions: string; criteria: Record<string, string> }
  > = {};
  const keyed = new Map<string, ReconciliationCandidate>();
  candidates.forEach((candidate, index) => {
    const key = `candidate_${index}`;
    keyed.set(key, candidate);
    questions[key] = {
      instructions: [
        `Classify New Statement -> Candidate ${candidate.statement.id}.`,
        "Use only the supplied memory state and provenance.",
        "For the exact same single-value Slot, a later value from the same recording authority and speaker is a supersession even when source record ids differ.",
        "Choose needs_context when original wording, subject identity, source order, graph relations, or constraints must be inspected before deciding.",
      ].join(" "),
      criteria: {
        duplicate: "Materially the same core claim.",
        refines: "The New Statement adds compatible detail to the Candidate.",
        supersedes: "The New Statement is a later replacement for the Candidate.",
        contradicts: "They cannot both be true, but provenance does not establish replacement.",
        independent: "They are related in topic but are separate facts.",
        needs_context: "The bounded state is insufficient; inspect read-only memory context.",
      },
    };
  });
  const state = JSON.stringify({
    direction: "New Statement -> Candidate",
    newStatement: reconciliationRow(graph, subject, subjectDimension, []),
    candidates: candidates.map((candidate) =>
      reconciliationRow(
        graph,
        candidate.statement,
        candidate.dimension,
        candidate.sharedAbout,
        candidate.preFlaggedContradiction,
      ),
    ),
  });
  const answers = await driver.choiceFanOut(state, questions);
  const proposals: FactRelationProposal[] = [];
  const unresolved: ReconciliationCandidate[] = [];
  for (const [key, candidate] of keyed) {
    const answer = answers[key];
    if (
      !answer ||
      answer.choice === "needs_context" ||
      !isFactRelationKind(answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < minConfidence
    ) {
      unresolved.push(candidate);
      continue;
    }
    proposals.push(
      proposal(
        subject.id,
        candidate.statement.id,
        answer.choice,
        "agent",
        answer.confidence,
        `Jev classified the bounded memory state as ${answer.choice}`,
      ),
    );
  }
  return { proposals, unresolved };
}

function reconciliationRow(
  graph: GraphStore,
  statement: StatementNode,
  dimension: DimensionNode,
  sharedAbout: string[],
  preFlaggedContradiction = false,
): unknown {
  return {
    statementId: statement.id,
    dimensionId: dimension.id,
    dimensionKey: dimension.key,
    propertyKey: slotPropertyKey(dimension),
    subjectRef: slotSubjectRef(dimension),
    subjectLabel: slotSubjectLabel(graph, dimension),
    cardinality: dimension.cardinality,
    value: statement.value,
    state: statement.state,
    saidBy: statement.saidBy,
    createdAt: statement.created_at,
    createdBy: statement.created_by,
    sourceRefs: statement.source_refs,
    scope: statement.scope,
    sharedAbout,
    preFlaggedContradiction,
  };
}

function buildFactReconciliationPrompt(
  graph: GraphStore,
  subject: StatementNode,
  subjectDimension: DimensionNode,
  candidates: readonly ReconciliationCandidate[],
  readsEnabled: boolean,
): string {
  const row = (
    statement: StatementNode,
    dimension: DimensionNode,
    sharedAbout: string[],
    preFlaggedContradiction = false,
  ) => reconciliationRow(graph, statement, dimension, sharedAbout, preFlaggedContradiction);
  const prompt = [
    "You are a Fact Reconciler. Compare one new Statement with existing live Statements.",
    "Every relation is directional: New Statement -> Candidate. Never reverse that direction.",
    "Judge memory truth relative to provenance, not from your own world knowledge. createdBy identifies the recording authority, saidBy identifies the speaker, sourceRefs identify source records, createdAt establishes order, and scope establishes the memory boundary.",
    "Classify meaning, not topic. Return exactly one relation per candidate:",
    "duplicate = materially the same core claim, including when the Candidate contains details omitted by the New Statement; refines = the New Statement adds compatible detail to the Candidate; supersedes = provenance establishes that the New Statement is a later replacement for the Candidate; contradicts = they cannot both be true but provenance does not establish which one replaces the other; independent = related topic but separate facts.",
    "For competing values with the exact same dimensionId in a single-cardinality Dimension and scope, classify supersedes when the New Statement is later and comes through the same recording authority and speaker trust channel. This rule is decisive: an explicit correction phrase and matching sourceRefs are NOT required. Different sourceRefs are normal episode identities, not different authorities.",
    "For a Candidate, sharedAbout lists graph targets shared with the New Statement. A shared person, work, organization, place, or event supports that the two claims concern the same subject; different value entities do not make the subject different.",
    "Use contradicts when authority, speaker, time, subject, or context is incompatible or insufficient to establish replacement. Never prefer a familiar real-world fact over a later claim merely because you believe it is true.",
    "preFlaggedContradiction only means storage saw different values in a single-cardinality Dimension. Use the supplied provenance to decide whether it is a replacement or an unresolved contradiction.",
    "Do not decide which contradictory fact wins. Do not output provenance, state changes, or graph ids other than the supplied statementId.",
    `New Statement:\n${JSON.stringify(row(subject, subjectDimension, []))}`,
    `Candidates:\n${JSON.stringify(candidates.map((candidate) => row(candidate.statement, candidate.dimension, candidate.sharedAbout, candidate.preFlaggedContradiction)))}`,
  ];
  if (readsEnabled) {
    prompt.push(
      "If the supplied context is insufficient, you may request read-only context instead of deciding. You may only target supplied Candidate statementIds. The runtime—not you—executes these reads, and no read can modify memory.",
      "Available read tools: slot_context = exact subject/property coordinates; episode_evidence = bounded original source excerpts; local_graph = bounded one-hop subject/about relationships; relation_history = prior epistemic edges; constraint_summary = relevant active constraint verdicts.",
      "For an exact same-dimensionId pair, request the smallest relevant read before returning contradicts or independent when the uncertainty is source wording, subject identity, or within-source order. Do not request reads merely to reconfirm a clear provenance-based supersession.",
      'Either respond with final decisions, or ONLY: {"reads":[{"tool":"slot_context|episode_evidence|local_graph|relation_history|constraint_summary","statementId":"<candidate id>"}]}. Request only information needed to decide.',
    );
  }
  prompt.push(
    'Final decision format: {"decisions":[{"statementId":"<candidate id>","relation":"duplicate|refines|supersedes|contradicts|independent","confidence":0.0,"reason":"short evidence-based reason"}]}',
  );
  return prompt.join("\n\n");
}

type ReconciliationReadStore = Pick<
  GraphStore,
  "getNode" | "queryNodes" | "queryEdges" | "getEpisode"
> & {
  getAllConstraints?: () => Constraint[];
  evaluateConstraint?: (id: string) => string;
};

interface FactReconciliationReadResult {
  tool: FactReconciliationReadTool;
  statementId: string;
  data: unknown;
}

function normalizeMaxReadRequests(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentError("fact reconciler maxReadRequests must be a non-negative integer");
  }
  return Math.min(value, 3);
}

function normalizeReadRequests(
  raw: unknown,
  candidates: readonly ReconciliationCandidate[],
  limit: number,
): FactReconciliationReadRequest[] {
  if (limit === 0 || typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const reads = (raw as Record<string, unknown>).reads;
  if (!Array.isArray(reads)) return [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.statement.id));
  const allowedTools = new Set<FactReconciliationReadTool>([
    "slot_context",
    "episode_evidence",
    "local_graph",
    "relation_history",
    "constraint_summary",
  ]);
  const normalized: FactReconciliationReadRequest[] = [];
  const seen = new Set<string>();
  for (const rawRead of reads) {
    if (normalized.length >= limit) break;
    if (typeof rawRead !== "object" || rawRead === null || Array.isArray(rawRead)) continue;
    const read = rawRead as Record<string, unknown>;
    if (typeof read.tool !== "string" || !allowedTools.has(read.tool as FactReconciliationReadTool)) {
      continue;
    }
    if (typeof read.statementId !== "string" || !candidateIds.has(read.statementId)) continue;
    const key = `${read.tool}\u0000${read.statementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      tool: read.tool as FactReconciliationReadTool,
      statementId: read.statementId,
    });
  }
  return normalized;
}

function executeReadRequests(
  graph: ReconciliationReadStore,
  subject: StatementNode,
  candidates: readonly ReconciliationCandidate[],
  requests: readonly FactReconciliationReadRequest[],
): FactReconciliationReadResult[] {
  const byId = new Map(candidates.map((candidate) => [candidate.statement.id, candidate]));
  return requests.flatMap((request) => {
    const candidate = byId.get(request.statementId);
    if (!candidate) return [];
    return [
      {
        ...request,
        data: executeReadTool(graph, subject, candidate, request.tool),
      },
    ];
  });
}

function executeReadTool(
  graph: ReconciliationReadStore,
  subject: StatementNode,
  candidate: ReconciliationCandidate,
  tool: FactReconciliationReadTool,
): unknown {
  if (tool === "slot_context") {
    return {
      newStatement: slotSnapshot(graph, subject),
      candidate: slotSnapshot(graph, candidate.statement),
    };
  }
  if (tool === "episode_evidence") {
    return {
      newStatement: episodeEvidence(graph, subject),
      candidate: episodeEvidence(graph, candidate.statement),
    };
  }
  if (tool === "local_graph") {
    return localGraphSnapshot(graph, subject, candidate.statement);
  }
  if (tool === "relation_history") {
    return relationHistory(graph, subject, candidate.statement);
  }
  return constraintSummary(graph, subject, candidate.statement);
}

function buildFactReconciliationFollowupPrompt(
  initialPrompt: string,
  results: readonly FactReconciliationReadResult[],
): string {
  return [
    initialPrompt,
    "The runtime completed your approved READ-ONLY requests. These results are bounded to the current conflict and cannot modify memory:",
    JSON.stringify(results),
    "This is the final round. Do not request more reads. Return ONLY the final decisions object in the previously specified format. If evidence is still insufficient, use contradicts or independent instead of guessing supersedes.",
  ].join("\n\n");
}

function slotSnapshot(graph: ReconciliationReadStore, statement: StatementNode): unknown {
  const dimension = readDimension(graph, statement.dimension_id);
  const subjectRef = slotSubjectRef(dimension);
  const subject = subjectRef === SCOPE_OWNER_SUBJECT ? undefined : graph.getNode(subjectRef);
  return {
    dimensionId: dimension.id,
    propertyKey: slotPropertyKey(dimension),
    description:
      typeof dimension.attributes.description === "string"
        ? dimension.attributes.description
        : null,
    subjectRef,
    subject: subject ? nodeSnapshot(subject) : subjectRef,
    cardinality: dimension.cardinality ?? "multi",
    claimState: statement.state,
    sourceOrder: {
      turnIndex: numericAttribute(statement, "turnIndex"),
      sourceOrdinal: numericAttribute(statement, "sourceOrdinal"),
    },
  };
}

function episodeEvidence(graph: ReconciliationReadStore, statement: StatementNode): unknown[] {
  const dimension = readDimension(graph, statement.dimension_id);
  const tokens = evidenceTokens(`${slotPropertyKey(dimension)} ${stringValue(statement.value)}`);
  const results: unknown[] = [];
  for (const sourceRef of statement.source_refs.slice(0, 2)) {
    const episode = graph.getEpisode(sourceRef);
    if (!episode || !scopesEqual(episode.scope, statement.scope)) continue;
    const ranked = episode.turns
      .map((turn, turnIndex) => ({
        turn,
        turnIndex,
        score: tokens.reduce(
          (score, token) => score + (turn.content.toLocaleLowerCase("en-US").includes(token) ? 1 : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score || a.turnIndex - b.turnIndex)
      .slice(0, 2);
    results.push({
      sourceRef,
      episodeCreatedAt: episode.created_at,
      turns: ranked.map(({ turn, turnIndex }) => ({
        turnIndex,
        role: turn.role,
        excerpt: focusedExcerpt(turn.content, tokens, 900),
      })),
    });
  }
  return results;
}

function localGraphSnapshot(
  graph: ReconciliationReadStore,
  subject: StatementNode,
  object: StatementNode,
): unknown {
  const subjectDimension = readDimension(graph, subject.dimension_id);
  const objectDimension = readDimension(graph, object.dimension_id);
  const subjectRefs = [...new Set([slotSubjectRef(subjectDimension), slotSubjectRef(objectDimension)])]
    .filter((id) => id !== SCOPE_OWNER_SUBJECT);
  const subjectAbout = aboutTargets(graph, subject.id);
  const objectAbout = aboutTargets(graph, object.id);
  const sharedAbout = subjectAbout.filter((id) => objectAbout.includes(id));
  const aboutIds = [...new Set([...subjectAbout, ...objectAbout])].slice(0, 12);
  const oneHop = subjectRefs.flatMap((id) => [
    ...graph.queryEdges({ from: id }),
    ...graph.queryEdges({ to: id }),
  ]).filter((edge) => scopesEqual(edge.scope, subject.scope));
  const uniqueEdges = [...new Map(oneHop.map((edge) => [edge.id, edge])).values()].slice(0, 12);
  return {
    slotSubjects: subjectRefs.map((id) => nodeSnapshotOrId(graph, id)),
    sharedAbout: sharedAbout.map((id) => nodeSnapshotOrId(graph, id)),
    aboutTargets: aboutIds.map((id) => ({
      role: subjectRefs.includes(id)
        ? "slot_subject"
        : sharedAbout.includes(id)
          ? "shared_related"
          : "claim_value_or_context",
      node: nodeSnapshotOrId(graph, id),
    })),
    oneHopEdges: uniqueEdges.map((edge) => ({
      type: edge.type,
      from: nodeSnapshotOrId(graph, edge.from),
      to: nodeSnapshotOrId(graph, edge.to),
    })),
  };
}

function relationHistory(
  graph: ReconciliationReadStore,
  subject: StatementNode,
  object: StatementNode,
): unknown[] {
  const dimensionIds = new Set([subject.dimension_id, object.dimension_id]);
  const statementIds = new Set(
    (graph.queryNodes({ type: "core:statement" }) as StatementNode[])
      .filter((statement) => dimensionIds.has(statement.dimension_id))
      .map((statement) => statement.id),
  );
  return graph
    .queryEdges({})
    .filter(
      (edge) =>
        EPISTEMIC_EDGE_TYPES.includes(edge.type as (typeof EPISTEMIC_EDGE_TYPES)[number]) &&
        (statementIds.has(edge.from) || statementIds.has(edge.to)) &&
        scopesEqual(edge.scope, subject.scope),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 12)
    .map((edge) => ({
      type: edge.type,
      from: edge.from,
      to: edge.to,
      createdBy: edge.created_by,
      createdAt: edge.created_at,
      reason: typeof edge.attributes.reason === "string" ? edge.attributes.reason : null,
    }));
}

function constraintSummary(
  graph: ReconciliationReadStore,
  subject: StatementNode,
  object: StatementNode,
): unknown {
  if (!graph.getAllConstraints || !graph.evaluateConstraint) {
    return { available: false, constraints: [] };
  }
  const dimensionIds = new Set([subject.dimension_id, object.dimension_id]);
  const constraints = graph
    .getAllConstraints()
    .filter(
      (constraint) =>
        constraint.activation_state === "active" &&
        constraint.participants.some((id) => dimensionIds.has(id)) &&
        scopesEqual(constraint.scope, subject.scope),
    )
    .slice(0, 8)
    .map((constraint) => ({
      id: constraint.id,
      name: constraint.name ?? null,
      participants: constraint.participants,
      currentEvaluation: graph.evaluateConstraint?.(constraint.id) ?? "unavailable",
    }));
  return { available: true, constraints };
}

function readDimension(graph: ReconciliationReadStore, id: string): DimensionNode {
  const node = graph.getNode(id);
  if (!node || node.type !== "core:dimension") throw new AgentError(`dimension not found: ${id}`);
  return node as DimensionNode;
}

function slotSubjectLabel(graph: ReconciliationReadStore, dimension: DimensionNode): string | null {
  const ref = slotSubjectRef(dimension);
  if (ref === SCOPE_OWNER_SUBJECT) return null;
  const subject = graph.getNode(ref);
  if (!subject) return ref;
  const snapshot = nodeSnapshot(subject);
  return typeof snapshot.label === "string" ? snapshot.label : ref;
}

function nodeSnapshotOrId(graph: ReconciliationReadStore, id: string): unknown {
  const node = graph.getNode(id);
  return node ? nodeSnapshot(node) : { id };
}

function nodeSnapshot(node: GraphNode): { id: string; type: string; label: string } {
  return {
    id: node.id,
    type: node.type,
    label:
      typeof node.value === "string" && node.value.trim().length > 0
        ? node.value.trim().slice(0, 240)
        : node.key ?? node.id,
  };
}

function numericAttribute(statement: StatementNode, key: string): number | null {
  const value = statement.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceTokens(text: string): string[] {
  return [...new Set(text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(
    0,
    16,
  );
}

function focusedExcerpt(content: string, tokens: readonly string[], limit: number): string {
  if (content.length <= limit) return content;
  const lower = content.toLocaleLowerCase("en-US");
  const positions = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  const anchor = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, anchor - Math.floor(limit / 3));
  const end = Math.min(content.length, start + limit);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
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
      continue;
    }
    const decision = rawDecision as Record<string, unknown>;
    if (typeof decision.statementId !== "string" || !candidateIds.has(decision.statementId)) {
      continue;
    }
    if (seen.has(decision.statementId)) {
      continue;
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

function aboutTargets(
  graph: Pick<GraphStore, "queryEdges">,
  statementId: string,
): string[] {
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
