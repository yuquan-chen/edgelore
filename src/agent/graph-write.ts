// edgelore · Graph-aware ingestion commit.
//
// Extraction describes facts and entity mentions with local refs. This layer
// resolves those refs into the EXISTING M0 families and commits one atomic
// mutation: GraphNode + GraphEdge, while capture() remains the Dimension /
// Statement storage primitive. Constraint proposals stay on their governed
// path and are deliberately not authored by this writer.

import type { FactNodeState, GraphNode, NamespacedType, Scope } from "../model/types.js";
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

function validatePlan(plan: GraphWritePlan, graph: GraphStore): void {
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
    if (!refs.has(relation.from) && !graph.getNode(relation.from)) {
      throw new AgentError(`relation ${relation.type} has unknown from ref: ${relation.from}`);
    }
    if (!refs.has(relation.to) && !graph.getNode(relation.to)) {
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

function referenceAliases(draft: EntityDraft): string[] {
  const values = [draft.ref, draft.key];
  if (typeof draft.value === "string") values.push(draft.value);
  const aliases = new Set<string>();
  for (const value of values) {
    const canonical = canonicalEntityKey(value);
    if (canonical) aliases.add(canonical);
    for (const prefix of [`${draft.type}:`, `${draft.type}/`]) {
      if (value.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"))) {
        const withoutType = canonicalEntityKey(value.slice(prefix.length));
        if (withoutType) aliases.add(withoutType);
      }
    }
  }
  const key = canonicalEntityKey(draft.key);
  aliases.add(canonicalEntityKey(`${draft.type}:${key}`));
  aliases.add(canonicalEntityKey(`${draft.type}/${key}`));
  return [...aliases].filter(Boolean);
}

/** Models sometimes spell one plan-local reference as `place`, `place-key`,
 * or `world:place:place-key` inside the same JSON object. Resolve only a
 * unique alias; ambiguity is deliberately left as an error. */
function storedEntityByReference(
  graph: GraphStore,
  ref: string,
  contextScope?: Scope,
): GraphNode | undefined {
  const matches = graph.queryNodes({}).filter((node) => {
    if (node.type === "core:dimension" || node.type === "core:statement" || !node.key) return false;
    if (!scopesEqual(node.scope, contextScope) && !scopesEqual(node.scope, undefined)) return false;
    const requested = canonicalEntityKey(ref);
    const key = canonicalEntityKey(node.key);
    const aliases = [
      key,
      canonicalEntityKey(`${node.type}:${key}`),
      canonicalEntityKey(`${node.type}/${key}`),
      ...(typeof node.value === "string" ? [canonicalEntityKey(node.value)] : []),
    ];
    return aliases.includes(requested);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizePlanReferences(
  plan: GraphWritePlan,
  graph: GraphStore,
  contextScope?: Scope,
): GraphWritePlan {
  const declaredRefs = new Set([
    ...plan.entities.map((entity) => entity.ref),
    ...plan.facts.map((fact) => fact.ref),
  ]);
  const aliases = new Map<string, Set<string>>();
  for (const entity of plan.entities) {
    for (const alias of referenceAliases(entity)) {
      const refs = aliases.get(alias) ?? new Set<string>();
      refs.add(entity.ref);
      aliases.set(alias, refs);
    }
  }
  const resolve = (ref: string): string => {
    if (declaredRefs.has(ref) || ref === SCOPE_OWNER_SUBJECT) return ref;
    const matches = aliases.get(canonicalEntityKey(ref));
    if (matches?.size === 1) return [...matches][0] as string;
    return storedEntityByReference(graph, ref, contextScope)?.id ?? ref;
  };
  return {
    entities: plan.entities,
    facts: plan.facts.map((fact) => ({
      ...fact,
      content: fact.content.subjectRef
        ? { ...fact.content, subjectRef: resolve(fact.content.subjectRef) }
        : fact.content,
    })),
    relations: plan.relations.map((relation) => ({
      ...relation,
      from: resolve(relation.from),
      to: resolve(relation.to),
    })),
  };
}

const ACRONYM_STOP_WORDS = new Set(["a", "an", "and", "of", "the"]);

function words(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function acronym(value: string): string | undefined {
  const tokens = words(value).filter((token) => !ACRONYM_STOP_WORDS.has(token));
  if (tokens.length < 2) return undefined;
  return tokens.map((token) => [...token][0]).join("");
}

function entitySurfaces(value: Pick<EntityDraft, "ref" | "key" | "value"> | GraphNode): string[] {
  const surfaces = new Set<string>();
  if ("ref" in value) surfaces.add(value.ref);
  if (value.key) surfaces.add(value.key);
  if (typeof value.value === "string") surfaces.add(value.value);
  return [...surfaces].filter(Boolean);
}

function isAcronymPair(left: string, right: string): boolean {
  const leftCanonical = canonicalEntityKey(left).replace(/-/g, "");
  const rightCanonical = canonicalEntityKey(right).replace(/-/g, "");
  const leftAcronym = acronym(left);
  const rightAcronym = acronym(right);
  return (
    (leftAcronym !== undefined && leftAcronym === rightCanonical) ||
    (rightAcronym !== undefined && rightAcronym === leftCanonical)
  );
}

function resolveExistingEntity(
  graph: GraphStore,
  draft: EntityDraft,
  scope: Scope | undefined,
): GraphNode | undefined {
  const candidates = graph
    .queryNodes({ type: draft.type })
    .filter((node) => node.key !== undefined && scopesEqual(node.scope, scope));
  const exact = candidates.filter(
    (node) => canonicalEntityKey(node.key as string) === canonicalEntityKey(draft.key),
  );
  if (exact.length > 1) {
    throw new AgentError(
      `ambiguous entity identity for ${draft.type}:${draft.key} in the requested scope`,
    );
  }
  if (exact[0]) return exact[0];

  const draftSurfaces = entitySurfaces(draft);
  const labelMatches = candidates.filter((node) => {
    const nodeSurfaces = entitySurfaces(node);
    return draftSurfaces.some((left) =>
      nodeSurfaces.some(
        (right) =>
          canonicalEntityKey(left) === canonicalEntityKey(right) || isAcronymPair(left, right),
      ),
    );
  });
  if (labelMatches.length === 1) return labelMatches[0];
  return undefined;
}

function exactEntityObjectTarget(
  graph: GraphStore,
  value: unknown,
  subjectId: string | undefined,
  scope: Scope | undefined,
): GraphNode | undefined {
  if (typeof value !== "string") return undefined;
  const wanted = canonicalEntityKey(value);
  if (!wanted) return undefined;
  const matches = graph.queryNodes({}).filter((node) => {
    if (
      node.id === subjectId ||
      node.type === "core:dimension" ||
      node.type === "core:statement" ||
      node.type === "core:constraint" ||
      node.type === "core:message" ||
      !node.key
    ) {
      return false;
    }
    if (!scopesEqual(node.scope, scope) && !scopesEqual(node.scope, undefined)) return false;
    return entitySurfaces(node).some((surface) => canonicalEntityKey(surface) === wanted);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Resolve and atomically commit one graph write plan.
 *
 * The LLM never supplies ids, provenance, or states for statements. Entity
 * reuse is conservative: type and scope are hard boundaries; exact labels or
 * unique acronyms may match directly. Semantic similarity never auto-merges.
 */
export function commitGraphWritePlan(
  graph: GraphStore,
  inputPlan: GraphWritePlan,
  ctx: CaptureContext,
): GraphWriteResult {
  const plan = normalizePlanReferences(inputPlan, graph, ctx.scope);
  validatePlan(plan, graph);

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
      const existing = resolveExistingEntity(graph, draft, scope);
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
      const from = refs[draft.from] ?? (graph.getNode(draft.from) ? draft.from : undefined);
      const to = refs[draft.to] ?? (graph.getNode(draft.to) ? draft.to : undefined);
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

    // The organizer is asked to connect every relational fact to its object,
    // but a model may occasionally omit an otherwise unambiguous core:about
    // edge. Complete only the safest case here: the Claim value exactly names
    // one in-scope (or global) Entity. Explicit model relations above win and
    // keep their metadata. No fuzzy or semantic matching is used.
    for (const draft of plan.facts) {
      const statementId = refs[draft.ref];
      if (!statementId) continue;
      const requestedSubject = draft.content.subjectRef;
      const subjectId = requestedSubject
        ? refs[requestedSubject] ?? (graph.getNode(requestedSubject) ? requestedSubject : undefined)
        : undefined;
      const target = exactEntityObjectTarget(graph, draft.content.value, subjectId, ctx.scope);
      if (!target) continue;
      const duplicate = graph
        .queryEdges({ type: "core:about", from: statementId, to: target.id })
        .find((edge) => scopesEqual(edge.scope, ctx.scope));
      if (duplicate) continue;
      const edge = graph.addEdge({
        type: "core:about",
        from: statementId,
        to: target.id,
        scope: ctx.scope,
        attributes: { inferred_by: "exact_entity_value" },
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
