// edgelore · M0 — In-memory graph store with model enforcement.
//
// The store is the reference implementation of the M0 data model. It enforces:
//  - mandatory provenance on every object (created_by / created_at /
//    schema_version / source_refs)
//  - open-world type well-formedness
//  - valid id format
//  - fact / constraint state transitions (state-machine.ts)
//  - Q01: a constraint may only go `active` with a human approver
//  - type-specific required fields (dimension.key, statement.dimension_id+value)
//
// Storage is pluggable per M0 spec (SQLite default, graph DB later); this is
// the canonical in-memory backend used by tests and the early reference impl.

import { randomUUID } from "node:crypto";
import {
  CONSTRAINT_STATE_TRANSITIONS,
  FACT_STATE_TRANSITIONS,
  canTransitionConstraint,
  canTransitionFact,
} from "./state-machine.js";
import {
  constraintId,
  edgeId,
  nodeId,
  revisionId,
  validateCreatedBy,
  validateId,
  validateType,
} from "./identifiers.js";
import {
  SCHEMA_VERSION,
  type Constraint,
  type ConstraintState,
  type FactNodeState,
  type GraphEdge,
  type GraphNode,
  type NamespacedType,
  type Scope,
} from "./types.js";

/** Thrown on any model-level validation failure. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

// --- input shapes: caller supplies the meaningful fields; store fills the rest.

export interface AddNodeInput {
  type: NamespacedType;
  created_by: string;
  state?: FactNodeState;
  scope?: Scope;
  schema_version?: string;
  source_refs?: string[];
  created_at?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  // type-specific (optional at the type level; validated per core type)
  key?: string;
  project_id?: string;
  phase_id?: string;
  dimension_id?: string;
  value?: unknown;
  unit?: string;
}

export interface AddEdgeInput {
  type: NamespacedType;
  from: string;
  to: string;
  created_by: string;
  scope?: Scope;
  schema_version?: string;
  source_refs?: string[];
  created_at?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
}

export interface AddConstraintInput {
  kind?: NamespacedType;
  name?: string;
  scope?: Scope;
  participants: string[];
  bindings: Record<string, string>;
  parameter_types?: Record<string, string>;
  expression?: Constraint["expression"];
  activation_state?: ConstraintState;
  created_by: string;
  approved_by?: string | null;
  schema_version?: string;
  source_refs?: string[];
  created_at?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
}

const now = () => new Date().toISOString();

function assertValidCreatedBy(createdBy: string): void {
  const r = validateCreatedBy(createdBy);
  if (!r.ok) throw new ModelError(r.reason!);
}

function assertValidType(type: string): void {
  const r = validateType(type);
  if (!r.ok) throw new ModelError(r.reason!);
}

function assertValidId(id: string, label = "id"): void {
  const r = validateId(id);
  if (!r.ok) throw new ModelError(`${label}: ${r.reason!}`);
}

export class MemoryGraph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private constraints = new Map<string, Constraint>();

  // ---------------------------------------------------------------- nodes

  addNode(input: AddNodeInput): GraphNode {
    assertValidType(input.type);
    assertValidCreatedBy(input.created_by);

    const ts = input.created_at ?? now();
    const base = {
      id: nodeId(input.type),
      type: input.type,
      created_by: input.created_by,
      created_at: ts,
      updated_at: ts,
      schema_version: input.schema_version ?? SCHEMA_VERSION,
      source_refs: input.source_refs ?? [],
      scope: input.scope,
      state: input.state ?? "tentative",
      attributes: input.attributes ?? {},
      tags: input.tags ?? [],
    };

    let node: GraphNode;
    switch (input.type) {
      case "core:dimension":
        if (!input.key) throw new ModelError("core:dimension requires `key`");
        node = {
          ...base,
          type: "core:dimension",
          key: input.key,
          project_id: input.project_id,
          phase_id: input.phase_id,
        };
        break;
      case "core:statement":
        if (!input.dimension_id) throw new ModelError("core:statement requires `dimension_id`");
        if (input.value === undefined) throw new ModelError("core:statement requires `value`");
        node = {
          ...base,
          type: "core:statement",
          dimension_id: input.dimension_id,
          value: input.value,
          unit: input.unit,
        };
        break;
      default:
        node = base;
    }

    this.nodes.set(node.id, node);
    return node;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Transition a fact node's state, enforcing the state machine. */
  transitionNodeState(id: string, to: FactNodeState): GraphNode {
    const node = this.nodes.get(id);
    if (!node) throw new ModelError(`node not found: ${id}`);
    if (!canTransitionFact(node.state, to)) {
      throw new ModelError(
        `illegal fact-node transition: ${node.state} -> ${to} (allowed: ${FACT_STATE_TRANSITIONS[node.state].join(", ")})`,
      );
    }
    node.state = to;
    node.updated_at = now();
    return node;
  }

  // ---------------------------------------------------------------- edges

  addEdge(input: AddEdgeInput): GraphEdge {
    assertValidType(input.type);
    assertValidCreatedBy(input.created_by);
    assertValidId(input.from, "edge.from");
    assertValidId(input.to, "edge.to");
    if (!this.nodes.has(input.from))
      throw new ModelError(`edge.from references unknown node: ${input.from}`);
    if (!this.nodes.has(input.to))
      throw new ModelError(`edge.to references unknown node: ${input.to}`);

    const edge: GraphEdge = {
      id: edgeId(),
      type: input.type,
      from: input.from,
      to: input.to,
      created_by: input.created_by,
      created_at: input.created_at ?? now(),
      schema_version: input.schema_version ?? SCHEMA_VERSION,
      source_refs: input.source_refs ?? [],
      scope: input.scope,
      attributes: input.attributes ?? {},
      tags: input.tags ?? [],
    };
    this.edges.set(edge.id, edge);
    return edge;
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  // ---------------------------------------------------------- constraints

  addConstraint(input: AddConstraintInput): Constraint {
    assertValidCreatedBy(input.created_by);
    if (!Array.isArray(input.participants) || input.participants.length === 0) {
      throw new ModelError("constraint requires at least one participant (the honest hyperedge)");
    }
    for (const p of input.participants) assertValidId(p, "constraint.participant");

    const activation_state = input.activation_state ?? "proposed";

    // Q01 governance: a constraint may only be created `active` if a human
    // already approved it. No silent self-activation by an agent.
    const approved_by: string | null = input.approved_by ?? null;
    let approved_at: string | null = null;
    if (activation_state === "active") {
      if (!approved_by)
        throw new ModelError("Q01: a constraint cannot go `active` without approved_by");
      if (!validateCreatedBy(approved_by).ok || !approved_by.startsWith("human:")) {
        throw new ModelError("Q01: approved_by must be a human:<id>");
      }
      approved_at = now();
    }

    const ts = input.created_at ?? now();
    const constraint: Constraint = {
      id: constraintId(),
      kind: input.kind ?? "core:constraint",
      revision_id: revisionId(1),
      name: input.name,
      scope: input.scope,
      participants: input.participants,
      bindings: input.bindings,
      parameter_types: input.parameter_types,
      expression: input.expression,
      activation_state,
      approved_by,
      approved_at,
      created_by: input.created_by,
      created_at: ts,
      schema_version: input.schema_version ?? SCHEMA_VERSION,
      source_refs: input.source_refs ?? [],
      attributes: input.attributes ?? {},
      tags: input.tags ?? [],
    };
    this.constraints.set(constraint.id, constraint);
    return constraint;
  }

  getConstraint(id: string): Constraint | undefined {
    return this.constraints.get(id);
  }

  /**
   * Transition a constraint's activation state. Going to `active` requires a
   * human approver (Q01 governance point) the first time.
   */
  transitionConstraintState(
    id: string,
    to: ConstraintState,
    opts?: { approved_by?: string },
  ): Constraint {
    const c = this.constraints.get(id);
    if (!c) throw new ModelError(`constraint not found: ${id}`);
    if (!canTransitionConstraint(c.activation_state, to)) {
      throw new ModelError(
        `illegal constraint transition: ${c.activation_state} -> ${to} (allowed: ${CONSTRAINT_STATE_TRANSITIONS[c.activation_state].join(", ")})`,
      );
    }
    if (to === "active" && !c.approved_by) {
      const approver = opts?.approved_by;
      if (!approver)
        throw new ModelError("Q01: activating a constraint requires approved_by (a human:<id>)");
      if (!validateCreatedBy(approver).ok || !approver.startsWith("human:")) {
        throw new ModelError("Q01: approved_by must be a human:<id>");
      }
      c.approved_by = approver;
      c.approved_at = now();
    }
    if (to === "retired") c.retired_at = now();
    c.activation_state = to;
    return c;
  }

  // --------------------------------------------------------------- queries

  /** Simple filter over nodes. Pass `undefined` for a field to ignore it. */
  queryNodes(filter: {
    type?: NamespacedType;
    state?: FactNodeState;
    project_id?: string;
    phase_id?: string;
  }): GraphNode[] {
    const out: GraphNode[] = [];
    for (const n of this.nodes.values()) {
      if (filter.type && n.type !== filter.type) continue;
      if (filter.state && n.state !== filter.state) continue;
      if (filter.project_id && n.scope?.project_id !== filter.project_id) continue;
      if (filter.phase_id && n.scope?.phase_id !== filter.phase_id) continue;
      out.push(n);
    }
    return out;
  }

  getAllNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }
  getAllEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }
  getAllConstraints(): Constraint[] {
    return [...this.constraints.values()];
  }
}

export { randomUUID };
