// edgelore · Graph enrichment — preserve extracted facts, add graph shape.
//
// This is intentionally a separate model pass from gate/extract. Extraction
// owns recall and wording; enrichment may only classify the already-extracted
// facts, identify reusable entities/events, and connect them. If this pass
// fails, callers can safely fall back to capture() without losing facts.

import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import type { DimensionNode, GraphNode, NamespacedType, Scope, StatementNode } from "../model/types.js";
import type { CaptureContent } from "./capture.js";
import { AgentError } from "./errors.js";
import type { EntityDraft, GraphWritePlan, RelationDraft } from "./graph-write.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import type { KnownDimension } from "./prompt.js";
import { SCOPE_OWNER_SUBJECT, slotSubjectLabel, slotSubjectRef } from "./slots.js";

const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const NAMESPACED_TYPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/i;
const FACT_REF = (index: number) => `fact:${index}`;
const GOVERNED_STATEMENT_RELATIONS = new Set([
  "core:contradicts",
  "core:refines",
  "core:supersedes",
]);

export interface GraphEnrichmentInput {
  text: string;
  contents: readonly CaptureContent[];
  knownDimensions: readonly KnownDimension[];
  graph: GraphStore;
  driver: LlmDriver;
  scope?: Scope;
  maxEntityHints?: number;
}

export interface GraphEnrichmentPlan extends GraphWritePlan {
  /** Recoverable model-output defects. Facts remain complete; only the bad
   * entity/relation is omitted or rewritten. */
  warnings: string[];
}

interface FactMapping {
  factRef: string;
  /** `$scopeOwner` or a plan-local entity ref. Resolved to a durable id by
   * commitGraphWritePlan before capture. */
  subjectRef: string;
  dimensionKey: string;
  dimensionDescription?: string;
  cardinality?: "single" | "multi";
}

export interface DimensionHint extends KnownDimension {
  dimensionId: string;
  subjectRef: string;
  subjectLabel?: string;
  /** A small, bounded sample makes semantic reuse possible even when keys use
   * different wording (for example gasMileage vs carPerformanceMetrics). */
  sampleValues: unknown[];
}

export interface EntityHint {
  type: NamespacedType;
  key: string;
  value?: unknown;
  scope: "context" | "global";
}

/**
 * Run the non-destructive graph-enrichment pass.
 *
 * Every input fact must appear exactly once in `factMappings`. Values, units,
 * and speaker attribution are copied from the trusted extraction result and
 * are never accepted back from the model.
 */
export async function runGraphEnrichment(input: GraphEnrichmentInput): Promise<GraphEnrichmentPlan> {
  if (input.contents.length === 0) {
    return { entities: [], facts: [], relations: [], warnings: [] };
  }

  const hints = entityHintsOf(
    input.graph,
    input.scope,
    input.maxEntityHints ?? 40,
  );
  const prompt = buildGraphEnrichmentPrompt({
    text: input.text,
    contents: input.contents,
    dimensionHints: dimensionHintsOf(input.graph, input.knownDimensions, input.scope),
    entityHints: hints,
    relationTypes: [...new Set(input.graph.queryEdges({}).map((edge) => edge.type))].slice(0, 40),
  });
  const parsed = parseJsonReply(await input.driver.complete(prompt));
  const plan = normalizeGraphEnrichment(parsed, input.contents);
  guardDimensionRemapping(plan, input.contents);
  return plan;
}

export interface GraphEnrichmentPromptInput {
  text: string;
  contents: readonly CaptureContent[];
  dimensionHints: readonly DimensionHint[];
  entityHints: readonly EntityHint[];
  relationTypes: readonly NamespacedType[];
}

/** Prompt is exported so benchmark smoke tests can inspect the contract. */
export function buildGraphEnrichmentPrompt(input: GraphEnrichmentPromptInput): string {
  const facts = input.contents.map((content, index) => ({
    factRef: FACT_REF(index),
    dimensionKey: content.dimensionKey,
    value: content.value,
    ...(content.saidBy ? { saidBy: content.saidBy } : {}),
  }));
  return [
    "You organize already-extracted memories into a reusable graph.",
    "This is NOT another extraction pass. Preserve every supplied fact exactly once; never add, drop, merge, or rewrite a fact value.",
    "Treat dimensionKey as a reusable subject-free PROPERTY key. The runtime materializes a separate subject-bound Slot for (subjectRef, dimensionKey, scope); Statements are the Slot's candidate values.",
    "For every factMapping, dimensionKey MUST be either an exact key from Known slots or NEW:<lowerCamelCase>. Reuse a key whenever the facts ask the same kind of question, even when their subjects differ. Use NEW: only when no known Property fits.",
    `Every factMapping MUST include subjectRef. Use "${SCOPE_OWNER_SUBJECT}" for the memory owner's own preferences, plans, experiences, relationships, or assistant recommendations addressed to them. Use a plan-local entity ref for an intrinsic property of a specific entity/event; that ref MUST also appear in entities, even when reusing an existing entity.`,
    `Example: Hawaii and Paris family trips both use dimensionKey familyTrips and subjectRef "${SCOPE_OWNER_SUBJECT}"; the trip events remain separate entities connected with core:about. Never create familyTripHawaii/familyTripParis.`,
    'Example: an object\'s intrinsic color uses dimensionKey objectColor and that object\'s entity ref as subjectRef. Another object may reuse objectColor without sharing the same Slot or conflicting.',
    "Represent a distinct real-world occurrence as an event entity (for example travel:trip). Reuse an existing entity only when it is the same identity, not merely a similar kind.",
    "All claim-sensitive semantic relations MUST start at a factRef (the persisted Statement), so their trust follows that statement. Use core:about from a fact to its main entity/event.",
    "Never output core:contradicts, core:refines, or core:supersedes. Those epistemic decisions belong to a separate governed fact reconciler, not graph organization.",
    "Never output ids, provenance, timestamps, state, saidBy, or fact values. The runtime owns those fields.",
    "Entity and relation types are open-world namespaced strings such as travel:trip, geo:place, travel:destination, or core:about.",
    `Known dimensions with real stored examples:\n${JSON.stringify(input.dimensionHints)}`,
    `Existing entities in the applicable context (reuse type+key only for the same identity):\n${JSON.stringify(input.entityHints)}`,
    `Existing relation types (reuse when the meaning matches; invent a new namespaced type only when necessary):\n${JSON.stringify(input.relationTypes)}`,
    `Immutable extracted facts:\n${JSON.stringify(facts)}`,
    `Source conversation:\n${input.text}`,
    `Respond with ONLY one JSON object:
{
  "factMappings": [
    {"factRef":"fact:0","subjectRef":"${SCOPE_OWNER_SUBJECT}","dimensionKey":"NEW:familyTrips","dimensionDescription":"Family travel experiences","cardinality":"multi"}
  ],
  "entities": [
    {"ref":"tripHawaii","type":"travel:trip","key":"hawaii-2023-05","value":"Hawaii family trip","scope":"context"},
    {"ref":"hawaii","type":"geo:place","key":"hawaii","value":"Hawaii","scope":"global"}
  ],
  "relations": [
    {"type":"core:about","from":"fact:0","to":"tripHawaii"},
    {"type":"travel:destination","from":"fact:0","to":"hawaii"}
  ]
}`,
  ].join("\n\n");
}

/** Convert the model reply while keeping content payloads immutable. */
export function normalizeGraphEnrichment(
  raw: unknown,
  contents: readonly CaptureContent[],
): GraphEnrichmentPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentError("graph enrichment reply must be a JSON object");
  }
  const reply = raw as Record<string, unknown>;
  if (!Array.isArray(reply.factMappings)) {
    throw new AgentError('graph enrichment field "factMappings" must be an array');
  }
  if (!Array.isArray(reply.entities)) {
    throw new AgentError('graph enrichment field "entities" must be an array');
  }
  if (!Array.isArray(reply.relations)) {
    throw new AgentError('graph enrichment field "relations" must be an array');
  }

  const expectedRefs = new Set(contents.map((_content, index) => FACT_REF(index)));
  const mappings = new Map<string, FactMapping>();
  for (const value of reply.factMappings) {
    const mapping = normalizeFactMapping(value);
    if (!expectedRefs.has(mapping.factRef)) {
      throw new AgentError(`graph enrichment has unknown factRef: ${mapping.factRef}`);
    }
    if (mappings.has(mapping.factRef)) {
      throw new AgentError(`graph enrichment repeats factRef: ${mapping.factRef}`);
    }
    mappings.set(mapping.factRef, mapping);
  }
  for (const ref of expectedRefs) {
    if (!mappings.has(ref)) throw new AgentError(`graph enrichment omitted factRef: ${ref}`);
  }

  const facts = contents.map((content, index) => {
    const ref = FACT_REF(index);
    const mapping = mappings.get(ref) as FactMapping;
    return {
      ref,
      content: {
        ...content,
        subjectRef: mapping.subjectRef,
        dimensionKey: mapping.dimensionKey,
        ...(mapping.dimensionDescription
          ? { description: mapping.dimensionDescription }
          : {}),
        ...(mapping.cardinality ? { cardinality: mapping.cardinality } : {}),
      },
    };
  });

  const warnings: string[] = [];
  const entities: EntityDraft[] = [];
  for (const value of reply.entities) {
    try {
      entities.push(normalizeEntityDraft(value));
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }
  const allRefs = new Set(facts.map((fact) => fact.ref));
  const uniqueEntities: EntityDraft[] = [];
  for (const entity of entities) {
    if (allRefs.has(entity.ref)) {
      warnings.push(`duplicate graph enrichment ref skipped: ${entity.ref}`);
      continue;
    }
    allRefs.add(entity.ref);
    uniqueEntities.push(entity);
  }
  const relationCandidates: RelationDraft[] = [];
  for (const value of reply.relations) {
    try {
      const relation = normalizeRelationDraft(value, allRefs);
      if (GOVERNED_STATEMENT_RELATIONS.has(relation.type)) {
        warnings.push(`governed statement relation skipped during enrichment: ${relation.type}`);
        continue;
      }
      relationCandidates.push(relation);
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }
  const relations: RelationDraft[] = [];
  for (const relation of relationCandidates) {
    if (expectedRefs.has(relation.from)) {
      relations.push(relation);
      continue;
    }
    // Models naturally emit entity->entity triples. Preserve Statement-level
    // trust by projecting the relation back to the unique fact that introduced
    // or described the source entity. Ambiguous support is skipped, not guessed.
    const supporters = relationCandidates.filter(
      (candidate) =>
        candidate.type === "core:about" &&
        candidate.to === relation.from &&
        expectedRefs.has(candidate.from),
    );
    if (supporters.length === 1) {
      relations.push({ ...relation, from: supporters[0]!.from });
      warnings.push(
        `relation ${relation.type} was projected from entity ${relation.from} to supporting ${supporters[0]!.from}`,
      );
      continue;
    }
    warnings.push(
      `claim-sensitive relation ${relation.type} skipped: no unique supporting fact for ${relation.from}`,
    );
  }
  return { entities: uniqueEntities, facts, relations, warnings };
}

function normalizeFactMapping(raw: unknown): FactMapping {
  const entry = objectEntry(raw, "fact mapping");
  const factRef = requiredString(entry.factRef, "factMapping.factRef");
  const subjectRef = requiredString(entry.subjectRef, "factMapping.subjectRef");
  let dimensionKey = requiredString(entry.dimensionKey, "factMapping.dimensionKey");
  if (/^new:/i.test(dimensionKey)) dimensionKey = dimensionKey.slice(dimensionKey.indexOf(":") + 1);
  if (!LOWER_CAMEL_CASE.test(dimensionKey)) {
    throw new AgentError(`graph enrichment dimensionKey must be lowerCamelCase: ${dimensionKey}`);
  }
  const mapping: FactMapping = { factRef, subjectRef, dimensionKey };
  if (entry.dimensionDescription !== undefined) {
    mapping.dimensionDescription = requiredString(
      entry.dimensionDescription,
      "factMapping.dimensionDescription",
    );
  }
  if (entry.cardinality !== undefined) {
    if (entry.cardinality !== "single" && entry.cardinality !== "multi") {
      throw new AgentError("factMapping.cardinality must be single or multi");
    }
    mapping.cardinality = entry.cardinality;
  }
  return mapping;
}

function normalizeEntityDraft(raw: unknown): EntityDraft {
  const entry = objectEntry(raw, "entity");
  const ref = requiredString(entry.ref, "entity.ref");
  const type = requiredString(entry.type, "entity.type");
  if (!NAMESPACED_TYPE.test(type)) throw new AgentError(`entity.type must be namespaced: ${type}`);
  const key = requiredString(entry.key, "entity.key");
  if (entry.scope !== undefined && entry.scope !== "context" && entry.scope !== "global") {
    throw new AgentError("entity.scope must be context or global");
  }
  return {
    ref,
    type,
    key,
    ...(entry.value !== undefined ? { value: entry.value } : {}),
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    ...(isRecord(entry.attributes) ? { attributes: entry.attributes } : {}),
    ...(stringArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
  };
}

function normalizeRelationDraft(raw: unknown, refs: ReadonlySet<string>): RelationDraft {
  const entry = objectEntry(raw, "relation");
  const type = requiredString(entry.type, "relation.type");
  if (!NAMESPACED_TYPE.test(type)) throw new AgentError(`relation.type must be namespaced: ${type}`);
  const from = requiredString(entry.from, "relation.from");
  const to = requiredString(entry.to, "relation.to");
  if (!refs.has(from)) throw new AgentError(`relation has unknown from ref: ${from}`);
  if (!refs.has(to)) throw new AgentError(`relation has unknown to ref: ${to}`);
  return {
    type,
    from,
    to,
    ...(isRecord(entry.attributes) ? { attributes: entry.attributes } : {}),
    ...(stringArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
  };
}

function entityHintsOf(graph: GraphStore, scope: Scope | undefined, limit: number): EntityHint[] {
  const hints: EntityHint[] = [];
  for (const node of graph.queryNodes({})) {
    if (node.type === "core:dimension" || node.type === "core:statement" || !node.key) continue;
    const kind = entityScopeKind(node, scope);
    if (!kind) continue;
    hints.push({
      type: node.type,
      key: node.key,
      ...(node.value !== undefined ? { value: node.value } : {}),
      scope: kind,
    });
    if (hints.length >= limit) break;
  }
  return hints;
}

function dimensionHintsOf(
  graph: GraphStore,
  known: readonly KnownDimension[],
  scope?: Scope,
): DimensionHint[] {
  const wanted = new Set(known.map((dimension) => dimension.key));
  const dimensions = (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[]).filter(
    (dimension) => wanted.has(dimension.key) && scopesEqual(dimension.scope, scope),
  );
  const knownByKey = new Map(known.map((dimension) => [dimension.key, dimension]));
  const samples = new Map<string, unknown[]>();
  for (const statement of graph.queryNodes({ type: "core:statement" }) as StatementNode[]) {
    const values = samples.get(statement.dimension_id) ?? [];
    if (values.length >= 2) continue;
    values.push(statement.value);
    samples.set(statement.dimension_id, values);
  }
  return dimensions.map((dimension) => ({
    ...(knownByKey.get(dimension.key) ?? {
      key: dimension.key,
      description: dimension.key,
      cardinality: dimension.cardinality ?? "multi",
    }),
    dimensionId: dimension.id,
    subjectRef: slotSubjectRef(dimension),
    ...(slotSubjectLabel(graph, dimension)
      ? { subjectLabel: slotSubjectLabel(graph, dimension) as string }
      : {}),
    sampleValues: samples.get(dimension.id) ?? [],
  }));
}

/**
 * Prevent topical catch-all dimensions. The organizer may remap a fact to an
 * existing OR newly proposed Dimension only when its key describes the same
 * predicate as the extractor's original key. This is deliberately
 * conservative: uncertain cases keep the original slot and can be merged
 * later with evidence; a false merge destroys retrieval boundaries immediately.
 */
function guardDimensionRemapping(
  plan: GraphEnrichmentPlan,
  originals: readonly CaptureContent[],
): void {
  plan.facts.forEach((fact, index) => {
    const original = originals[index];
    if (!original) return;
    const proposed = fact.content.dimensionKey;
    if (
      proposed === original.dimensionKey ||
      dimensionKeysCompatible(original.dimensionKey, proposed)
    ) {
      return;
    }
    // Property and subject form one semantic address. Keeping a proposed
    // entity subject after rejecting its Property remap can create nonsense
    // such as `car.carAccessories = "Silver Honda Civic"`. Fall back as one
    // unit; legacy extracted facts are owner-bound unless they already carry
    // an explicit, trusted subject.
    fact.content = { ...original };
    plan.warnings.push(
      `unsafe dimension remap rejected: ${original.dimensionKey} -> ${proposed}`,
    );
  });
}

function dimensionKeysCompatible(a: string, b: string): boolean {
  const left = keyTokens(a);
  const right = keyTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  if (overlap < 2) return false;
  return overlap / Math.min(left.size, right.size) >= 0.5;
}

function keyTokens(key: string): Set<string> {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word));
  return new Set(words);
}

function entityScopeKind(node: GraphNode, contextScope?: Scope): "context" | "global" | null {
  if (scopesEqual(node.scope, contextScope)) return "context";
  if (scopesEqual(node.scope, undefined)) return "global";
  return null;
}

function objectEntry(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new AgentError(`graph enrichment ${label} must be an object`);
  return raw;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentError(`graph enrichment ${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
