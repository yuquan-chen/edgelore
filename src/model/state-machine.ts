// edgelore · M0 — State machines.
//
// Allowed transitions for fact-node acceptance state and constraint activation
// state. `superseded` and `rejected` are terminal: history is preserved, never
// silently revived (M0 spec §3). `deprecated` is the only soft off-ramp.

import type { ConstraintState, FactNodeState } from "./types.js";

/**
 * Fact-node transitions.
 *  - tentative:   the default initial state; may move anywhere as it gets confirmed.
 *  - accepted:    a confirmed fact; can still be disputed (conflict), superseded, or rejected.
 *  - conflict:    awaiting human-in-the-loop / orchestrator resolution.
 *  - superseded:  terminal — replaced by a newer version, kept for audit.
 *  - rejected:    terminal — explicitly judged false.
 */
export const FACT_STATE_TRANSITIONS: Record<FactNodeState, FactNodeState[]> = {
  tentative: ["tentative", "accepted", "conflict", "superseded", "rejected"],
  accepted: ["accepted", "conflict", "superseded", "rejected"],
  conflict: ["conflict", "accepted", "rejected", "superseded"],
  superseded: ["superseded"],
  rejected: ["rejected"],
};

/**
 * Constraint activation transitions.
 *  - proposed:   draft; may go active (needs a human approver, Q01) or straight to retired.
 *  - active:     approved; may be deprecated or retired.
 *  - deprecated: soft off-ramp; may still be retired.
 *  - retired:    terminal.
 */
export const CONSTRAINT_STATE_TRANSITIONS: Record<ConstraintState, ConstraintState[]> = {
  proposed: ["proposed", "active", "retired"],
  active: ["active", "deprecated", "retired"],
  deprecated: ["deprecated", "retired"],
  retired: ["retired"],
};

export function canTransitionFact(from: FactNodeState, to: FactNodeState): boolean {
  return FACT_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionConstraint(from: ConstraintState, to: ConstraintState): boolean {
  return CONSTRAINT_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
