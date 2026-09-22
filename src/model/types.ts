// edgelore · M0 — Core data model types.
//
// These types are the open contract for every agent that reads or writes the
// shared memory graph. They mirror `schema.json` 1:1 and MUST stay in sync with
// it. See docs/shared-memory-m0-spec.md for the design rationale.

/** Current schema version emitted on every object's `schema_version`. */
export const SCHEMA_VERSION = "m0.1";

/** The namespace reserved for types maintained by the edgelore core team. */
export const CORE_NAMESPACE = "core" as const;

/**
 * A type identifier is a namespaced string, NOT a closed enum (open-world
 * typing, see M0 spec §1.1). Core types use the `core:` prefix; each agent /
 * third party uses its own scope (`codex:task`, `com.acme:invoice`, ...).
 */
export type NamespacedType = string;

/**
 * Provenance is mandatory on EVERY object (node / edge / constraint).
 * It records who introduced the object and on what basis — the audit trail
 * that lets multiple agents trace "who wrote this, when, and why".
 *
 * `created_by` is self-reported by default (single-tenant, mutually-trusted
 * deployments). Identity *verification* is an optional, opt-in auth layer that
 * only matters for multi-tenant / federated deployments (M0 spec §1.2).
 */
export interface Provenance {
  /** `agent:<name>:<id>` or `human:<id>`. */
  created_by: string;
  /** ISO-8601 timestamp. */
  created_at: string;
  /** Schema version this object was written against (e.g. "m0.1"). */
  schema_version: string;
  /** Ids of the message / source that introduced this object. */
  source_refs: string[];
}

/** Applicability boundary for a node / edge / constraint (M0 spec §2, Q06). */
export interface Scope {
  /** Person / account whose memory this object belongs to. */
  owner_id?: string;
  project_id?: string;
  phase_id?: string;
}

// ---------------------------------------------------------------------------
// State enums (closed, precise core semantics — see M0 spec §3).
// ---------------------------------------------------------------------------

/**
 * Fact-node acceptance state. The minimal closed set chosen for M0. Business
 * detail goes in `attributes` / `tags`, never into more state values
 * (M0 spec §1.3: narrow state + wide metadata).
 */
export type FactNodeState =
  | "tentative" // default initial: written, not yet confirmed
  | "accepted" // confirmed, safe to use without reservation
  | "conflict" // >=2 incompatible statements exist, awaiting resolution
  | "superseded" // replaced by a newer version (history kept, not current)
  | "rejected"; // explicitly judged false / wrong

/**
 * Constraint (hyperedge) activation state. 3 from the design doc + 1 optional.
 */
export type ConstraintState =
  | "proposed" // draft, not yet approved
  | "active" // approved, participates in formal checks
  | "retired" // decommissioned
  | "deprecated"; // marked outdated but not forcibly retired yet

// ---------------------------------------------------------------------------
// Nodes (entities). Base + core-specific shapes + an open fallback.
// ---------------------------------------------------------------------------

export interface BaseNode extends Provenance {
  /** `node:<type>:<uuid>` — globally unique, cross-agent referenceable. */
  id: string;
  type: NamespacedType;
  updated_at: string;
  scope?: Scope;
  state: FactNodeState;
  /** Open metadata — the extension point. Never add state values instead. */
  attributes: Record<string, unknown>;
  /** Open labels — the other extension point. */
  tags: string[];
  /** Optional stable identity within `type + scope` for open-world entities. */
  key?: string;
  /** Optional generic payload for open-world entities. */
  value?: unknown;
  /** Optional unit accompanying a generic payload. */
  unit?: string;
  /**
   * Cardinality — how many accepted statements a dimension may hold.
   * Carried on every node for model flatness (everything is a Node, no
   * special-cased type); only `core:dimension` actually uses it.
   *   - "single": at most one accepted value (a new conflicting value is
   *     flagged, never silently overwritten)
   *   - "multi" | undefined: many accepted values allowed (default)
   */
  cardinality?: "single" | "multi";
}

export interface ActorNode extends BaseNode {
  type: "core:actor";
  attributes: Record<string, unknown>;
}

export interface ProjectNode extends BaseNode {
  type: "core:project";
  attributes: Record<string, unknown>;
}

export interface DeliverableNode extends BaseNode {
  type: "core:deliverable";
  attributes: Record<string, unknown>;
}

export interface MessageNode extends BaseNode {
  type: "core:message";
  attributes: Record<string, unknown>;
}

export interface SourceNode extends BaseNode {
  type: "core:source";
  attributes: Record<string, unknown>;
}

/**
 * Content-axis attribution: who said this IN THE CONVERSATION. Distinct from
 * the system-axis provenance `created_by` (which records which principal
 * wrote the object to the graph — runtime-injected, never agent-authored).
 * `saidBy` is CONTENT (who spoke the words is part of what the fact IS), so
 * it belongs to the agent-authored side of the frozen field trichotomy:
 * provenance system-injected / content agent-filled / states system-generated.
 * capture() validates it at the boundary; widen the union deliberately if a
 * third conversational role ever appears.
 */
export type SaidBy = "user" | "assistant";

/** Dimension identity, e.g. "design cost of project P". */
export interface DimensionNode extends BaseNode {
  type: "core:dimension";
  /** Stable dimension key within its scope (e.g. "design_cost"). */
  key: string;
  project_id?: string;
  phase_id?: string;
  attributes: Record<string, unknown>;
}

/** A candidate value for a dimension, attributed to some speaker / source. */
export interface StatementNode extends BaseNode {
  type: "core:statement";
  dimension_id: string;
  value: unknown;
  unit?: string;
  /** In-conversation speaker (content axis — see {@link SaidBy}). Absent on
   * legacy rows; capture() defaults its trust policy off it (assistant
   * statements enter `tentative` pending user confirmation). */
  saidBy?: SaidBy;
  attributes: Record<string, unknown>;
}

/**
 * A governed N-ary relation claim. Unlike a bare GraphEdge, the relation is a
 * first-class fact node: it has acceptance state, provenance, open role names,
 * and can itself participate in another RelationAssertion.
 */
export interface RelationAssertionNode extends BaseNode {
  type: "core:relation";
  /** Open-world relation meaning, e.g. core:part_of or core:instance_of. */
  predicate: NamespacedType;
  /** Open role -> participant node id, e.g. { part, whole }. */
  bindings: Record<string, string>;
  attributes: Record<string, unknown>;
}

/** All built-in core node shapes. */
export type CoreNode =
  | ActorNode
  | ProjectNode
  | DeliverableNode
  | MessageNode
  | SourceNode
  | DimensionNode
  | StatementNode
  | RelationAssertionNode;

/** Any node whose type lives outside the `core:` namespace. */
export interface OpenNode extends BaseNode {
  type: NamespacedType;
}

export type GraphNode = CoreNode | OpenNode;

// ---------------------------------------------------------------------------
// Edges (entity relations). Open-world typed, provenance-bearing.
// ---------------------------------------------------------------------------

/** Built-in core edge kinds (M0 spec §2.2). */
export type CoreEdgeType =
  | "core:said_by" // statement -> actor
  | "core:about" // statement -> the entity / event the claim describes
  | "core:has_source" // statement -> source
  | "core:belongs_to" // dimension -> project|deliverable
  | "core:branch" // node -> node (git-like branch)
  | "core:equivalent_to" // statement -> materially duplicate statement
  | "core:refines" // statement -> earlier statement (adds compatible detail)
  | "core:contradicts" // statement -> incompatible statement
  | "core:supersedes" // node -> node (correction / replacement)
  | "core:supports" // statement -> relation assertion
  | "core:participates_in"; // dimension -> constraint (index of hyperedge)

export interface GraphEdge extends Provenance {
  id: string;
  type: NamespacedType;
  from: string; // node id
  to: string; // node id
  scope?: Scope;
  attributes: Record<string, unknown>;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Constraint (the hyperedge / multi-arity rule). M0 spec §2.4.
// ---------------------------------------------------------------------------

/**
 * Expression AST. The concrete operators + evaluator are defined in M1; in M0
 * we reserve the shape so the data model is complete. `op` is a whitelisted
 * operator (D09); args are either nested nodes, numeric literals, or `{ref}`
 * references to a bound parameter.
 */
export interface ExpressionNode {
  op: string;
  args: Array<ExpressionNode | { ref: string } | number>;
}

export interface Constraint extends Provenance {
  /** `constraint:<uuid>`. */
  id: string;
  /** Usually `core:constraint` (open-world). */
  kind: NamespacedType;
  /** `constraint-revision:<n>` — version of this rule. */
  revision_id: string;
  name?: string;
  scope?: Scope;
  /**
   * The honest hyperedge: an N-ary set of participating dimension node ids.
   * Visualizable either as a bounding envelope or as constraint-node + spokes.
   */
  participants: string[];
  /** Parameter name -> dimension id (e.g. `{ x1: "node:core:dimension:9f1a" }`). */
  bindings: Record<string, string>;
  /** Parameter name -> type / unit hint (e.g. `{ x1: "money:CNY" }`). */
  parameter_types?: Record<string, string>;
  /** The rule body (D09 whitelist). Evaluated in M1. */
  expression?: ExpressionNode;
  activation_state: ConstraintState;
  /** ★ Q01 governance point — who approved this rule to go `active`. */
  approved_by: string | null;
  approved_at: string | null;
  retired_at?: string | null;
  attributes: Record<string, unknown>;
  tags: string[];
}
