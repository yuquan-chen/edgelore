// edgelore · Agent Memory layer — conflict listing & adjudication.
//
// capture() FLAGS conflicts (single-cardinality clash: newcomer tentative,
// dimension conflict) but never resolves them (M3 boundary). This module is
// the resolution half of the story:
//
//   listConflicts   — the docket: dimensions in conflict with their
//                     incumbents (accepted) and challengers (tentative)
//   resolveConflict — human adjudication: pick the winner; losers are
//                     superseded (history preserved); the dimension returns
//                     to accepted. Attribution REQUIRED: human:<id> (Q01
//                     governance — agents never self-adjudicate here).
//   autoResolveConstraintGuided — the constraint-engine-as-referee mode:
//                     if an active constraint separates the candidates
//                     (exactly one satisfies), resolve automatically and
//                     cite the rule; otherwise ESCALATE — never guess.
//
// The audit record of a resolution is a `core:supersedes` edge (winner ->
// loser) whose mandatory provenance carries WHO resolved (created_by) and
// WHEN (created_at); the rationale rides in edge attributes. No new state
// values, no schema change — pure M0 primitives (narrow state, wide metadata).

import { AgentError } from "./errors.js";
import { valuesEqual } from "./capture.js";
import { MemoryGraph } from "../model/store.js";
import type { Constraint, DimensionNode, FactNodeState, SaidBy, StatementNode } from "../model/types.js";
import type { EvaluationResult } from "../engine/evaluate.js";

/** One statement row in a conflict docket. */
export interface ConflictStatement {
  statementId: string;
  value: unknown;
  state: FactNodeState;
  createdBy: string;
  createdAt: string;
  /** Content-axis speaker when recorded (assistant claims read differently
   * in a docket — an unconfirmed suggestion vs a user assertion). */
  saidBy?: SaidBy;
}

/** A pending conflict: one dimension with incompatible live statements. */
export interface ConflictCase {
  dimensionId: string;
  dimensionKey: string;
  /** Exact live statements participating in this connected contradiction. */
  participantIds: string[];
  /** The incumbents (accepted) — what the graph currently believes. */
  incumbents: ConflictStatement[];
  /** The challengers (tentative) — awaiting adjudication. */
  challengers: ConflictStatement[];
}

/**
 * List every dimension in conflict, with the statements facing off.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @returns one case per conflict dimension (empty docket when none)
 */
export function listConflicts(graph: MemoryGraph): ConflictCase[] {
  const stmts = graph.queryNodes({ type: "core:statement" }) as StatementNode[];
  const cases: ConflictCase[] = [];
  for (const dim of graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]) {
    if (dim.state !== "conflict") continue;
    const toRow = (s: StatementNode): ConflictStatement => ({
      statementId: s.id,
      value: s.value,
      state: s.state,
      createdBy: s.created_by,
      createdAt: s.created_at,
      ...(s.saidBy !== undefined ? { saidBy: s.saidBy } : {}),
    });
    const mine = stmts.filter((s) => s.dimension_id === dim.id);
    const live = mine.filter((s) => s.state !== "superseded" && s.state !== "rejected");
    const mineIds = new Set(mine.map((s) => s.id));
    const liveIds = new Set(live.map((s) => s.id));
    const allContradictions = graph
      .queryEdges({ type: "core:contradicts" })
      .filter((edge) => mineIds.has(edge.from) && mineIds.has(edge.to));
    const liveContradictions = allContradictions.filter(
      (edge) => liveIds.has(edge.from) && liveIds.has(edge.to),
    );

    // Explicit contradiction edges are the canonical conflict membership.
    // Legacy databases have no such edges, so retain their dimension-wide
    // docket as a compatibility fallback.
    const components: string[][] = [];
    if (allContradictions.length > 0) {
      const adjacency = new Map<string, Set<string>>();
      for (const edge of liveContradictions) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
        adjacency.get(edge.from)?.add(edge.to);
        adjacency.get(edge.to)?.add(edge.from);
      }
      const seen = new Set<string>();
      for (const start of adjacency.keys()) {
        if (seen.has(start)) continue;
        const stack = [start];
        const component: string[] = [];
        seen.add(start);
        while (stack.length > 0) {
          const current = stack.pop() as string;
          component.push(current);
          for (const next of adjacency.get(current) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            stack.push(next);
          }
        }
        if (component.length >= 2) components.push(component);
      }
    } else if (live.length >= 2) {
      components.push(live.map((s) => s.id));
    }

    for (const participantIds of components) {
      const participantSet = new Set(participantIds);
      const participants = live.filter((s) => participantSet.has(s.id));
      cases.push({
        dimensionId: dim.id,
        dimensionKey: dim.key,
        participantIds,
        incumbents: participants.filter((s) => s.state === "accepted").map(toRow),
        challengers: participants.filter((s) => s.state === "tentative").map(toRow),
      });
    }
  }
  return cases;
}

/** Options for {@link resolveConflict}. */
export interface ResolveOptions {
  /** WHO decided — MUST be `human:<id>` (Q01-style governance). */
  resolvedBy: string;
  /** Optional rationale, stored on the audit edges. */
  note?: string;
}

/** Result of {@link resolveConflict}. */
export interface ResolveResult {
  dimensionId: string;
  dimensionKey: string;
  /** The winning statement — accepted. */
  winnerId: string;
  /** Superseded statements (history preserved, never deleted). */
  supersededIds: string[];
}

/**
 * Adjudicate a conflict: the chosen statement becomes THE value.
 *
 * The winner is accepted; only statements in the SAME contradiction component
 * are superseded. Independent memories sharing a multi-value dimension are
 * untouched. The dimension returns to accepted only when no open component
 * remains.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param dimensionId the conflicted dimension
 * @param winnerStatementId the statement that should win
 * @param opts who decided (human) and why
 * @returns the resolution summary
 * @throws AgentError if resolvedBy is not human:<id>, the dimension is not
 *   in conflict, or the winner is missing / foreign / terminal
 */
export function resolveConflict(
  graph: MemoryGraph,
  dimensionId: string,
  winnerStatementId: string,
  opts: ResolveOptions,
): ResolveResult {
  if (!opts.resolvedBy.startsWith("human:")) {
    throw new AgentError("resolution requires a human adjudicator: resolvedBy must be human:<id>");
  }
  const dim = graph.getNode(dimensionId);
  if (!dim || dim.type !== "core:dimension") {
    throw new AgentError(`dimension not found: ${dimensionId}`);
  }
  if (dim.state !== "conflict") {
    throw new AgentError(`dimension "${(dim as DimensionNode).key}" is not in conflict (state: ${dim.state})`);
  }
  const winner = graph.getNode(winnerStatementId);
  if (!winner || winner.type !== "core:statement") {
    throw new AgentError(`statement not found: ${winnerStatementId}`);
  }
  const w = winner as StatementNode;
  if (w.dimension_id !== dimensionId) {
    throw new AgentError(`statement ${winnerStatementId} does not belong to dimension ${dimensionId}`);
  }
  if (w.state === "superseded" || w.state === "rejected") {
    throw new AgentError(`winner is already terminal (${w.state}) and cannot be revived`);
  }

  const conflict = listConflicts(graph).find(
    (candidate) =>
      candidate.dimensionId === dimensionId && candidate.participantIds.includes(winnerStatementId),
  );
  if (!conflict) {
    throw new AgentError(`statement ${winnerStatementId} is not part of an open conflict`);
  }
  const participantIds = new Set(conflict.participantIds);
  const others = (graph.queryNodes({ type: "core:statement" }) as StatementNode[]).filter(
    (s) =>
      participantIds.has(s.id) &&
      s.id !== winnerStatementId &&
      s.state !== "superseded" &&
      s.state !== "rejected",
  );

  if (w.state !== "accepted") graph.transitionNodeState(w.id, "accepted");
  const supersededIds: string[] = [];
  for (const loser of others) {
    graph.transitionNodeState(loser.id, "superseded");
    // The audit record: an M0-native edge whose provenance IS the resolution.
    graph.addEdge({
      type: "core:supersedes",
      from: w.id,
      to: loser.id,
      created_by: opts.resolvedBy,
      attributes: { resolution: true, note: opts.note ?? "" },
    });
    supersededIds.push(loser.id);
  }
  const stillOpen = listConflicts(graph).some((candidate) => candidate.dimensionId === dimensionId);
  if (!stillOpen) graph.transitionNodeState(dimensionId, "accepted");

  return {
    dimensionId,
    dimensionKey: (dim as DimensionNode).key,
    winnerId: w.id,
    supersededIds,
  };
}

/** Result of {@link autoResolveConstraintGuided}. */
export interface AutoResolutionOutcome {
  /** "resolved" = a constraint decided; "escalated" = back to the human queue. */
  status: "resolved" | "escalated";
  /** Why — the constraint verdicts, or why arbitration was impossible. */
  reason: string;
  /** Present only when status === "resolved". */
  result?: ResolveResult;
}

/** Options for {@link confirmStatement}. */
export interface ConfirmOptions {
  /** WHO confirmed — MUST be `human:<id>` (Q01-style governance). */
  confirmedBy: string;
  /** Optional rationale, stored on the statement attributes. */
  note?: string;
}

/** Result of {@link confirmStatement}. */
export interface ConfirmResult {
  statementId: string;
  dimensionId: string;
  state: "accepted";
}

/**
 * Confirm a tentative statement — typically an assistant-authored fact that
 * entered `tentative` pending user confirmation (W2 trust policy).
 *
 * Deliberately NOT resolveConflict: there is no facing incumbent and no
 * dimension conflict here, so there is nothing to supersede — the statement
 * simply becomes accepted, and the decision is recorded in attributes
 * (narrow state, wide metadata). The human requirement matches resolve.
 *
 * Refuses when the dimension is single-cardinality and already holds a
 * DIFFERENT accepted value: that IS a real conflict, and confirming past it
 * would create two live accepted values behind resolve's back — route it
 * through resolveConflict instead.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param statementId the tentative statement to promote
 * @param opts who confirmed (human) and why
 * @returns the confirmation summary
 * @throws AgentError if confirmedBy is not human:<id>, the statement is
 *   missing / not tentative, or a single-cardinality rival exists
 */
export function confirmStatement(
  graph: MemoryGraph,
  statementId: string,
  opts: ConfirmOptions,
): ConfirmResult {
  if (!opts.confirmedBy.startsWith("human:")) {
    throw new AgentError("confirmation requires a human: confirmedBy must be human:<id>");
  }
  const node = graph.getNode(statementId);
  if (!node || node.type !== "core:statement") {
    throw new AgentError(`statement not found: ${statementId}`);
  }
  const stmt = node as StatementNode;
  if (stmt.state !== "tentative") {
    throw new AgentError(`statement is not tentative (state: ${stmt.state}) — nothing to confirm`);
  }
  const dim = graph.getNode(stmt.dimension_id);
  if (!dim || dim.type !== "core:dimension") {
    throw new AgentError(`dimension not found: ${stmt.dimension_id}`);
  }
  if ((dim as DimensionNode).cardinality === "single") {
    const rival = (graph.queryNodes({ type: "core:statement" }) as StatementNode[]).find(
      (s) =>
        s.dimension_id === dim.id &&
        s.id !== stmt.id &&
        s.state === "accepted" &&
        !valuesEqual(s.value, stmt.value),
    );
    if (rival) {
      throw new AgentError(
        `single-cardinality dimension "${(dim as DimensionNode).key}" already holds a different ` +
          `accepted value (${JSON.stringify(rival.value)}) — confirming here would mint a second ` +
          `accepted value. Have the user restate the value in conversation (that flags the ` +
          `conflict), then use resolve.`,
      );
    }
  }
  // The decision record rides in open metadata; mutating attributes BEFORE
  // the transition means the SqliteGraph write-through persists both.
  stmt.attributes = {
    ...stmt.attributes,
    confirmed_by: opts.confirmedBy,
    confirmed_at: new Date().toISOString(),
    ...(opts.note ? { confirm_note: opts.note } : {}),
  };
  graph.transitionNodeState(stmt.id, "accepted");
  return { statementId: stmt.id, dimensionId: dim.id, state: "accepted" };
}

/**
 * Constraint-guided automatic resolution: let the M1 engine referee.
 *
 * For each active constraint bound to exactly this dimension, every
 * candidate is evaluated in isolation (hypothetical single-value graph). If
 * exactly one candidate SATISFIES the rule while the others do not, the rule
 * decides. Governance: the resolution is attributed to the HUMAN who
 * approved the arbitrating constraint (Q01 activation = standing
 * pre-authorization to reject rule-violating values), with the verdicts as
 * the note. Any other outcome (no constraint, all verdicts equal,
 * multi-dimension rules) ESCALATES to the human queue: the referee only
 * blows the whistle when the rules are unambiguous.
 *
 * @param graph a concrete MemoryGraph (or SqliteGraph)
 * @param dimensionId the conflicted dimension
 * @returns resolved (with the ResolveResult) or escalated (with the reason)
 */
export function autoResolveConstraintGuided(graph: MemoryGraph, dimensionId: string): AutoResolutionOutcome {
  const conflict = listConflicts(graph).find((c) => c.dimensionId === dimensionId);
  if (!conflict) return { status: "escalated", reason: "no conflict on this dimension" };
  const candidates = [...conflict.challengers, ...conflict.incumbents];
  if (candidates.length < 2) {
    return { status: "escalated", reason: "fewer than two live candidates" };
  }
  const dim = graph.getNode(dimensionId) as DimensionNode;
  const referees = graph
    .getAllConstraints()
    .filter((c) => c.activation_state === "active")
    .filter(
      (c) =>
        (Object.values(c.bindings).includes(dimensionId) || c.participants.includes(dimensionId)) &&
        // per-candidate hypotheticals are only sound for single-dimension rules
        new Set(Object.values(c.bindings)).size === 1 &&
        c.participants.length === 1,
    );
  if (referees.length === 0) {
    return { status: "escalated", reason: "no active single-dimension constraint can arbitrate" };
  }

  for (const referee of referees) {
    const verdicts = candidates.map((candidate) => ({
      candidate,
      verdict: hypotheticalVerdict(graph, referee, dim.key, candidate.value),
    }));
    const satisfied = verdicts.filter((v) => v.verdict === "satisfied");
    if (satisfied.length === 1) {
      const winner = satisfied[0]!.candidate;
      const others = verdicts
        .filter((v) => v.verdict !== "satisfied")
        .map((v) => `${JSON.stringify(v.candidate.value)}=${v.verdict}`)
        .join(", ");
      const reason =
        `constraint-guided: "${referee.name ?? referee.id}" decides — ` +
        `${JSON.stringify(winner.value)} satisfied; others: ${others || "none"}`;
      // Governance: attribute to the human who approved the arbitrating rule
      // (their Q01 activation IS the pre-authorization for this execution).
      const result = resolveConflict(graph, dimensionId, winner.statementId, {
        resolvedBy: referee.approved_by as string,
        note: reason,
      });
      return { status: "resolved", reason, result };
    }
  }
  return { status: "escalated", reason: "no active constraint separates the candidates" };
}

/**
 * Evaluate a constraint against a HYPOTHETICAL world where the dimension
 * holds exactly one value — via a throwaway scratch graph (no mutation of
 * the real one). The original human approval carries over to the rebuilt
 * constraint (Q01 stays satisfied).
 */
function hypotheticalVerdict(
  graph: MemoryGraph,
  constraint: Constraint,
  dimensionKey: string,
  value: unknown,
): EvaluationResult {
  const scratch = new MemoryGraph();
  const dim = scratch.addNode({
    type: "core:dimension",
    key: dimensionKey,
    created_by: "agent:edgelore:auto",
  });
  scratch.addNode({
    type: "core:statement",
    dimension_id: dim.id,
    value,
    state: "accepted",
    created_by: "agent:edgelore:auto",
  });
  const bindings: Record<string, string> = {};
  for (const name of Object.keys(constraint.bindings)) bindings[name] = dim.id;
  const rebuilt = scratch.addConstraint({
    participants: [dim.id],
    bindings,
    expression: constraint.expression,
    created_by: "agent:edgelore:auto",
    activation_state: "active",
    approved_by: constraint.approved_by ?? undefined,
  });
  return scratch.evaluateConstraint(rebuilt.id);
}
