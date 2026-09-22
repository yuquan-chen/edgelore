// edgelore · Graph-aware ingestion commit.
//
// Extraction describes facts and entity mentions with local refs. This layer
// resolves those refs into the EXISTING M0 families and commits one atomic
// mutation: GraphNode + GraphEdge, while capture() remains the Dimension /
// Statement storage primitive. Constraint proposals stay on their governed
// path and are deliberately not authored by this writer.

import type {
  FactNodeState,
  NamespacedType,
  RelationAssertionNode,
  Scope,
} from "../model/types.js";
import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import { capture, type CaptureContent, type CaptureContext, type CaptureResult } from "./capture.js";
import { AgentError } from "./errors.js";

/** An open-world entity or event that a fact may refer to. */
export interface EntityDraft {
  /** Plan-local reference used by RelationDraft endpoints. */
  ref: string;
  /** Open-world node type, e.g. travel:trip or geo:place. */
  type: NamespacedType;
  /** Stable identity within type + scope; never a domain-specific field set. */
  key: string;
  /** Optional human / retrieval payload. Domain semantics still live on edges. */
  value?: unknown;
  state?: FactNodeState;
  attributes?: Record<string, unknown>;
  tags?: string[];
  /** Defaults to the capture context. Global is opt-in, never guessed. */
  scope?: "context" | "global";
}

/** One claim persisted through the existing capture primitive. */
export interface FactDraft {
  ref: string;
  /** Optional plan-local alias for capture()'s resolved Dimension node. */
  dimensionRef?: string;
  content: CaptureContent;
}

/**
 * A governed structural relation. Role names remain open-world, while the
 * relation itself is a stateful node that may participate in another one.
 */
export interface RelationAssertionDraft {
  ref: string;
  predicate: NamespacedType;
  /** Open role -> plan-local fact/entity/dimension/relation ref. */
  bindings: Record<string, string>;
  /** Fact refs whose trust and provenance support this relation claim. */
  supportedBy: string[];
  attributes?: Record<string, unknown>;
  tags?: string[];
}

/** Open-world relation between two plan-local facts/entities. */
export interface RelationDraft {
  type: NamespacedType;
  from: string;
  to: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
}

export interface GraphWritePlan {
  entities: EntityDraft[];
  facts: FactDraft[];
  relations: RelationDraft[];
  relationAssertions?: RelationAssertionDraft[];
}

export interface GraphWriteResult {
  /** Plan ref -> persisted node id (entities and statements). */
  refs: Record<string, string>;
  captures: CaptureResult[];
  createdEntityIds: string[];
  createdRelationIds: string[];
  createdEdgeIds: string[];
}

function validatePlan(plan: GraphWritePlan): void {
  const refs = new Set<string>();
  const factRefs = new Set<string>();
  const addRef = (ref: string, label: string) => {
    if (!ref) throw new AgentError(`${label}.ref must be non-empty`);
    if (refs.has(ref)) throw new AgentError(`duplicate graph-write ref: ${ref}`);
    refs.add(ref);
  };
  for (const entity of plan.entities) {
    addRef(entity.ref, "entity");
    if (!entity.key) throw new AgentError(`entity "${entity.ref}" requires a stable key`);
  }
  for (const fact of plan.facts) {
    addRef(fact.ref, "fact");
    factRefs.add(fact.ref);
    if (fact.dimensionRef) addRef(fact.dimensionRef, "fact.dimensionRef");
  }
  for (const assertion of plan.relationAssertions ?? []) {
    addRef(assertion.ref, "relationAssertion");
  }
  for (const assertion of plan.relationAssertions ?? []) {
    if (Object.keys(assertion.bindings).length < 2) {
      throw new AgentError(
        `relation assertion "${assertion.ref}" requires at least two role bindings`,
      );
    }
    for (const [role, ref] of Object.entries(assertion.bindings)) {
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(role)) {
        throw new AgentError(
          `relation assertion "${assertion.ref}" has invalid role: ${role}`,
        );
      }
      if (!refs.has(ref)) {
        throw new AgentError(
          `relation assertion "${assertion.ref}" has unknown binding ref: ${ref}`,
        );
      }
      if (factRefs.has(ref)) {
        throw new AgentError(
          `relation assertion "${assertion.ref}" cannot bind Statement ref ${ref}; use supportedBy`,
        );
      }
    }
    if (assertion.supportedBy.length === 0) {
      throw new AgentError(`relation assertion "${assertion.ref}" requires supporting facts`);
    }
    for (const ref of assertion.supportedBy) {
      if (!factRefs.has(ref)) {
        throw new AgentError(
          `relation assertion "${assertion.ref}" has unknown supporting fact: ${ref}`,
        );
      }
    }
  }
  for (const relation of plan.relations) {
    if (!refs.has(relation.from)) {
      throw new AgentError(`relation ${relation.type} has unknown from ref: ${relation.from}`);
    }
    if (!refs.has(relation.to)) {
      throw new AgentError(`relation ${relation.type} has unknown to ref: ${relation.to}`);
    }
  }
}

function entityScope(draft: EntityDraft, contextScope?: Scope): Scope | undefined {
  return draft.scope === "global" ? undefined : contextScope;
}

/** Conservative identity normalisation: spelling separators and case do not
 * create a second entity, while semantic similarity never auto-merges. */
export function canonicalEntityKey(key: string): string {
  return key
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Resolve and atomically commit one graph write plan.
 *
 * The LLM never supplies ids, provenance, or states for statements. Entity
 * identity is exact type + key + scope here; semantic candidate selection
 * belongs to EntityResolver before this boundary.
 */
export function commitGraphWritePlan(
  graph: GraphStore,
  plan: GraphWritePlan,
  ctx: CaptureContext,
): GraphWriteResult {
  validatePlan(plan);

  return graph.transaction(() => {
    const refs: Record<string, string> = {};
    const captures: CaptureResult[] = [];
    const createdEntityIds: string[] = [];
    const createdRelationIds: string[] = [];
    const createdEdgeIds: string[] = [];

    // Facts are committed first so entity state can be derived from the
    // statements that actually support it (rather than model-authored).
    for (const draft of plan.facts) {
      const result = capture(graph, draft.content, ctx);
      if (!result.statementId) {
        throw new AgentError(`capture returned no statement id for fact ref: ${draft.ref}`);
      }
      refs[draft.ref] = result.statementId;
      if (draft.dimensionRef) refs[draft.dimensionRef] = result.dimensionId;
      captures.push(result);
    }

    for (const draft of plan.entities) {
      const scope = entityScope(draft, ctx.scope);
      const key = canonicalEntityKey(draft.key);
      if (!key) throw new AgentError(`entity "${draft.ref}" has no usable identity key`);
      const matches = graph
        .queryNodes({ type: draft.type })
        .filter(
          (node) =>
            node.key !== undefined &&
            canonicalEntityKey(node.key) === key &&
            scopesEqual(node.scope, scope),
        );
      if (matches.length > 1) {
        throw new AgentError(
          `ambiguous entity identity for ${draft.type}:${draft.key} in the requested scope`,
        );
      }
      const existing = matches[0];
      if (existing) {
        if (existing.state === "tentative" && derivedEntityState(plan, draft.ref, refs, graph) === "accepted") {
          graph.transitionNodeState(existing.id, "accepted");
        }
        refs[draft.ref] = existing.id;
        continue;
      }
      const node = graph.addNode({
        type: draft.type,
        key,
        value: draft.value,
        state: draft.state ?? derivedEntityState(plan, draft.ref, refs, graph),
        scope,
        attributes: draft.attributes,
        tags: draft.tags,
        created_by: ctx.created_by,
        created_at: ctx.createdAt,
        source_refs: ctx.source_refs,
      });
      refs[draft.ref] = node.id;
      createdEntityIds.push(node.id);
    }

    // RelationAssertions are reified hyperedges. Resolve them after ordinary
    // participants, with a small topological loop so one relation may bind to
    // another relation assertion without turning semantic claims into bare
    // entity-to-entity edges.
    const pending = [...(plan.relationAssertions ?? [])];
    while (pending.length > 0) {
      const readyIndex = pending.findIndex((draft) =>
        Object.values(draft.bindings).every((ref) => refs[ref] !== undefined),
      );
      if (readyIndex === -1) {
        throw new AgentError(
          `unresolvable relation assertion bindings: ${pending.map((draft) => draft.ref).join(", ")}`,
        );
      }
      const draft = pending.splice(readyIndex, 1)[0]!;
      const bindings = Object.fromEntries(
        Object.entries(draft.bindings).map(([role, ref]) => [role, refs[ref] as string]),
      );
      const supportIds = [...new Set(draft.supportedBy.map((ref) => refs[ref] as string))];
      const state = supportIds.some((id) => graph.getNode(id)?.state === "accepted")
        ? "accepted"
        : "tentative";
      const matches = (graph.queryNodes({ type: "core:relation" }) as RelationAssertionNode[])
        .filter(
          (node) =>
            node.predicate === draft.predicate &&
            bindingsEqual(node.bindings, bindings) &&
            scopesEqual(node.scope, ctx.scope),
        );
      if (matches.length > 1) {
        throw new AgentError(
          `ambiguous relation identity for ${draft.predicate} ${JSON.stringify(bindings)}`,
        );
      }
      let relation = matches[0];
      if (!relation) {
        relation = graph.addNode({
          type: "core:relation",
          predicate: draft.predicate,
          bindings,
          state,
          scope: ctx.scope,
          attributes: draft.attributes,
          tags: draft.tags,
          created_by: ctx.created_by,
          created_at: ctx.createdAt,
          source_refs: ctx.source_refs,
        }) as RelationAssertionNode;
        createdRelationIds.push(relation.id);
      } else if (relation.state === "tentative" && state === "accepted") {
        graph.transitionNodeState(relation.id, "accepted");
      }
      refs[draft.ref] = relation.id;

      if (state === "accepted") {
        for (const participantId of Object.values(bindings)) {
          const participant = graph.getNode(participantId);
          if (participant?.state === "tentative") {
            graph.transitionNodeState(participantId, "accepted");
          }
        }
      }

      for (const supportId of supportIds) {
        const duplicate = graph
          .queryEdges({ type: "core:supports", from: supportId, to: relation.id })
          .find((edge) => scopesEqual(edge.scope, ctx.scope));
        if (duplicate) continue;
        const edge = graph.addEdge({
          type: "core:supports",
          from: supportId,
          to: relation.id,
          scope: ctx.scope,
          created_by: ctx.created_by,
          created_at: ctx.createdAt,
          source_refs: ctx.source_refs,
          attributes: { role: "evidence" },
        });
        createdEdgeIds.push(edge.id);
      }
    }

    for (const draft of plan.relations) {
      const from = refs[draft.from];
      const to = refs[draft.to];
      if (!from || !to) throw new AgentError(`unresolved relation refs: ${draft.from} -> ${draft.to}`);
      const duplicate = graph
        .queryEdges({ type: draft.type, from, to })
        .find((edge) => scopesEqual(edge.scope, ctx.scope));
      if (duplicate) continue;
      const edge = graph.addEdge({
        type: draft.type,
        from,
        to,
        scope: ctx.scope,
        attributes: draft.attributes,
        tags: draft.tags,
        created_by: ctx.created_by,
        created_at: ctx.createdAt,
        source_refs: ctx.source_refs,
      });
      createdEdgeIds.push(edge.id);
    }

    return { refs, captures, createdEntityIds, createdRelationIds, createdEdgeIds };
  });
}

function bindingsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aEntries = Object.entries(a).sort(([left], [right]) => left.localeCompare(right));
  const bEntries = Object.entries(b).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(aEntries) === JSON.stringify(bEntries);
}

/** Entity identity is accepted when at least one accepted Statement supports
 * it; otherwise it remains tentative. Relations retain the detailed trust. */
function derivedEntityState(
  plan: GraphWritePlan,
  entityRef: string,
  refs: Readonly<Record<string, string>>,
  graph: GraphStore,
): FactNodeState {
  for (const relation of plan.relations) {
    if (relation.to !== entityRef) continue;
    const statementId = refs[relation.from];
    if (statementId && graph.getNode(statementId)?.state === "accepted") return "accepted";
  }
  return "tentative";
}
