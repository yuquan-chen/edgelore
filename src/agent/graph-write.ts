// edgelore · Graph-aware ingestion commit.
//
// Extraction describes facts and entity mentions with local refs. This layer
// resolves those refs into the EXISTING M0 families and commits one atomic
// mutation: GraphNode + GraphEdge, while capture() remains the Dimension /
// Statement storage primitive. Constraint proposals stay on their governed
// path and are deliberately not authored by this writer.

import type { FactNodeState, NamespacedType, Scope } from "../model/types.js";
import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import { capture, type CaptureContent, type CaptureContext, type CaptureResult } from "./capture.js";
import { AgentError } from "./errors.js";
import { SCOPE_OWNER_SUBJECT } from "./slots.js";

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
  content: CaptureContent;
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
}

export interface GraphWriteResult {
  /** Plan ref -> persisted node id (entities and statements). */
  refs: Record<string, string>;
  captures: CaptureResult[];
  createdEntityIds: string[];
  createdEdgeIds: string[];
}

function validatePlan(plan: GraphWritePlan): void {
  const refs = new Set<string>();
  const addRef = (ref: string, label: string) => {
    if (!ref) throw new AgentError(`${label}.ref must be non-empty`);
    if (refs.has(ref)) throw new AgentError(`duplicate graph-write ref: ${ref}`);
    refs.add(ref);
  };
  for (const entity of plan.entities) {
    addRef(entity.ref, "entity");
    if (!entity.key) throw new AgentError(`entity "${entity.ref}" requires a stable key`);
  }
  for (const fact of plan.facts) addRef(fact.ref, "fact");
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
    const createdEdgeIds: string[] = [];

    // Resolve entity identities before facts: a subject-bound Slot needs the
    // durable entity id. New entities start tentative unless the caller is an
    // authoritative non-LLM writer; after facts exist, accepted supporting
    // Claims promote them below.
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

    for (const draft of plan.facts) {
      const requestedSubject = draft.content.subjectRef;
      let subjectRef = requestedSubject;
      if (requestedSubject && requestedSubject !== SCOPE_OWNER_SUBJECT) {
        subjectRef = refs[requestedSubject] ?? (graph.getNode(requestedSubject) ? requestedSubject : undefined);
        if (!subjectRef) {
          throw new AgentError(
            `fact ${draft.ref} has unresolved subjectRef: ${requestedSubject}`,
          );
        }
      }
      const result = capture(
        graph,
        subjectRef ? { ...draft.content, subjectRef } : draft.content,
        ctx,
      );
      if (!result.statementId) {
        throw new AgentError(`capture returned no statement id for fact ref: ${draft.ref}`);
      }
      refs[draft.ref] = result.statementId;
      captures.push(result);
    }

    // Derive entity trust only after the supporting Claims have durable ids.
    for (const draft of plan.entities) {
      const id = refs[draft.ref];
      const node = id ? graph.getNode(id) : undefined;
      if (
        node?.state === "tentative" &&
        derivedEntityState(plan, draft.ref, refs, graph) === "accepted"
      ) {
        graph.transitionNodeState(node.id, "accepted");
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

    return { refs, captures, createdEntityIds, createdEdgeIds };
  });
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
