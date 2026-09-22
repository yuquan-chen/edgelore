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
import type {
  EntityDraft,
  GraphWritePlan,
  RelationAssertionDraft,
  RelationDraft,
} from "./graph-write.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import type { KnownDimension } from "./prompt.js";

const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const NAMESPACED_TYPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/i;
const FACT_REF = (index: number) => `fact:${index}`;
const DIMENSION_REF = (index: number) => `dimension:${index}`;
const GOVERNED_STATEMENT_RELATIONS = new Set([
  "core:equivalent_to",
  "core:contradicts",
  "core:refines",
  "core:supersedes",
]);
const EDGE_ONLY_PREDICATES = new Set([
  "core:said_by",
  "core:about",
  "core:has_source",
  "core:belongs_to",
  "core:branch",
  "core:supports",
  "core:participates_in",
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
  dimensionKey: string;
  dimensionDescription?: string;
  cardinality?: "single" | "multi";
}

export interface DimensionHint extends KnownDimension {
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
    return { entities: [], facts: [], relations: [], relationAssertions: [], warnings: [] };
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
    relationTypes: [
      ...new Set([
        ...input.graph.queryEdges({}).map((edge) => edge.type),
        ...input.graph
          .queryNodes({ type: "core:relation" })
          .map((node) => ("predicate" in node ? node.predicate : undefined))
          .filter((predicate): predicate is string => typeof predicate === "string"),
      ]),
    ].slice(0, 40),
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
    "Choose reusable subject-free dimension categories. A Dimension is the reusable QUESTION/CATEGORY; its Statements are the answers or event instances. A destination, person, product, date, or event identity belongs in an entity/Statement, never in the dimension key.",
    "For every factMapping, dimensionKey MUST be either an exact key from Known dimensions or NEW:<lowerCamelCase>. Reuse an existing key whenever its sample values answer the same kind of question, even if its wording differs. Use NEW: only when no existing Dimension can hold the fact.",
    "Example: Hawaii and Paris family trips both map to familyTrips; their destinations and trip instances differ only in entities/Statements. Never create familyTripHawaii/familyTripParis.",
    "Represent a distinct real-world occurrence as an event entity (for example travel:trip). Reuse an existing entity only when it is the same identity, not merely a similar kind.",
    "Use ordinary relations only for Statement-originating links such as core:about. All claim-sensitive ordinary relations MUST start at a factRef so their trust follows that Statement.",
    "Use relationAssertions for structural or taxonomic claims between entities, Dimensions, or other relations. Each assertion is a governed hyperedge with an open-world predicate, named role bindings, and one or more supportedBy factRefs.",
    "A fact's resolved Dimension is available as dimension:<index>. Use core:dimension_of to bind that Dimension to its precise subject/aspect. Use core:part_of only for a constitutive component -> whole in the same structural domain (for example vehicle:interior -> vehicle:car), never for an event, policy, product, advice, or program that merely uses, covers, recommends, or concerns an object. Use a precise custom predicate for those associations. Use core:instance_of for instance/subtype -> class. Do not infer a taxonomy merely from word similarity.",
    "Relations may have multiple parents: an interior may be part_of a particular car and instance_of a decoration concept. Keep those as separate relationAssertions; never force a tree.",
    "Never output core:equivalent_to, core:contradicts, core:refines, or core:supersedes. Those epistemic decisions belong to a separate governed fact reconciler, not graph organization.",
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
    {"factRef":"fact:0","dimensionKey":"NEW:familyTrips","dimensionDescription":"Family travel experiences","cardinality":"multi"}
  ],
  "entities": [
    {"ref":"car","type":"vehicle:car","key":"current-car","value":"Current car","scope":"context"},
    {"ref":"interior","type":"vehicle:interior","key":"current-car-interior","value":"Car interior","scope":"context"},
    {"ref":"decoration","type":"concept:category","key":"decoration","value":"Decoration","scope":"global"}
  ],
  "relations": [
    {"type":"core:about","from":"fact:0","to":"interior"}
  ],
  "relationAssertions": [
    {"ref":"interiorPartOfCar","predicate":"core:part_of","bindings":{"part":"interior","whole":"car"},"supportedBy":["fact:0"]},
    {"ref":"interiorIsDecoration","predicate":"core:instance_of","bindings":{"instance":"interior","class":"decoration"},"supportedBy":["fact:0"]},
    {"ref":"tipsDimensionSubject","predicate":"core:dimension_of","bindings":{"dimension":"dimension:0","subject":"interior"},"supportedBy":["fact:0"]}
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
  if (reply.relationAssertions !== undefined && !Array.isArray(reply.relationAssertions)) {
    throw new AgentError('graph enrichment field "relationAssertions" must be an array');
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
      dimensionRef: DIMENSION_REF(index),
      content: {
        ...content,
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
  const allRefs = new Set(
    facts.flatMap((fact) => [fact.ref, fact.dimensionRef as string]),
  );
  const uniqueEntities: EntityDraft[] = [];
  for (const entity of entities) {
    if (allRefs.has(entity.ref)) {
      warnings.push(`duplicate graph enrichment ref skipped: ${entity.ref}`);
      continue;
    }
    allRefs.add(entity.ref);
    uniqueEntities.push(entity);
  }

  const rawAssertions = (reply.relationAssertions ?? []) as unknown[];
  const proposedAssertionRefs = new Set<string>();
  const assertionRows: Array<{ raw: unknown; ref: string }> = [];
  for (const value of rawAssertions) {
    try {
      const entry = objectEntry(value, "relation assertion");
      const ref = requiredString(entry.ref, "relationAssertion.ref");
      if (allRefs.has(ref) || proposedAssertionRefs.has(ref)) {
        warnings.push(`duplicate graph enrichment ref skipped: ${ref}`);
        continue;
      }
      proposedAssertionRefs.add(ref);
      assertionRows.push({ raw: value, ref });
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }
  for (const ref of proposedAssertionRefs) allRefs.add(ref);
  const refTypes = new Map<string, string>();
  for (const fact of facts) {
    refTypes.set(fact.ref, "core:statement");
    refTypes.set(fact.dimensionRef as string, "core:dimension");
  }
  for (const entity of uniqueEntities) refTypes.set(entity.ref, entity.type);
  for (const ref of proposedAssertionRefs) refTypes.set(ref, "core:relation");
  let relationAssertions: RelationAssertionDraft[] = [];
  for (const row of assertionRows) {
    try {
      relationAssertions.push(
        normalizeRelationAssertionDraft(row.raw, allRefs, expectedRefs, refTypes),
      );
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }
  // Resolve assertion dependencies now. This both orders nested relations and
  // turns a missing/cyclic assertion dependency into a local warning instead
  // of rolling the whole fact commit back later.
  const baseRefs = new Set(
    [...allRefs].filter((ref) => !proposedAssertionRefs.has(ref)),
  );
  const orderedAssertions: RelationAssertionDraft[] = [];
  const pendingAssertions = [...relationAssertions];
  const availableRefs = new Set(baseRefs);
  while (pendingAssertions.length > 0) {
    const readyIndex = pendingAssertions.findIndex((draft) =>
      Object.values(draft.bindings).every((ref) => availableRefs.has(ref)),
    );
    if (readyIndex === -1) {
      for (const dropped of pendingAssertions) {
        warnings.push(
          `relation assertion ${dropped.ref} skipped: dependency is missing or cyclic`,
        );
      }
      break;
    }
    const ready = pendingAssertions.splice(readyIndex, 1)[0]!;
    orderedAssertions.push(ready);
    availableRefs.add(ready.ref);
  }
  relationAssertions = orderedAssertions;
  const validRefs = new Set([...baseRefs, ...relationAssertions.map((draft) => draft.ref)]);
  const relationCandidates: RelationDraft[] = [];
  for (const value of reply.relations) {
    try {
      const relation = normalizeRelationDraft(value, validRefs);
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
  return { entities: uniqueEntities, facts, relations, relationAssertions, warnings };
}

function normalizeFactMapping(raw: unknown): FactMapping {
  const entry = objectEntry(raw, "fact mapping");
  const factRef = requiredString(entry.factRef, "factMapping.factRef");
  let dimensionKey = requiredString(entry.dimensionKey, "factMapping.dimensionKey");
  if (/^new:/i.test(dimensionKey)) dimensionKey = dimensionKey.slice(dimensionKey.indexOf(":") + 1);
  if (!LOWER_CAMEL_CASE.test(dimensionKey)) {
    throw new AgentError(`graph enrichment dimensionKey must be lowerCamelCase: ${dimensionKey}`);
  }
  const mapping: FactMapping = { factRef, dimensionKey };
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

function normalizeRelationAssertionDraft(
  raw: unknown,
  refs: ReadonlySet<string>,
  factRefs: ReadonlySet<string>,
  refTypes: ReadonlyMap<string, string>,
): RelationAssertionDraft {
  const entry = objectEntry(raw, "relation assertion");
  const ref = requiredString(entry.ref, "relationAssertion.ref");
  const predicate = requiredString(entry.predicate, "relationAssertion.predicate");
  if (!NAMESPACED_TYPE.test(predicate)) {
    throw new AgentError(`relationAssertion.predicate must be namespaced: ${predicate}`);
  }
  if (GOVERNED_STATEMENT_RELATIONS.has(predicate)) {
    throw new AgentError(
      `governed statement relation skipped during enrichment: ${predicate}`,
    );
  }
  if (EDGE_ONLY_PREDICATES.has(predicate)) {
    throw new AgentError(
      `edge-only predicate cannot be a relation assertion: ${predicate}`,
    );
  }
  if (!isRecord(entry.bindings) || Object.keys(entry.bindings).length < 2) {
    throw new AgentError(`relationAssertion.bindings requires at least two roles: ${ref}`);
  }
  const bindings: Record<string, string> = {};
  for (const [role, value] of Object.entries(entry.bindings)) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(role)) {
      throw new AgentError(`relationAssertion has invalid role: ${role}`);
    }
    const target = requiredString(value, `relationAssertion.bindings.${role}`);
    if (!refs.has(target)) {
      throw new AgentError(`relationAssertion has unknown binding ref: ${target}`);
    }
    if (factRefs.has(target)) {
      throw new AgentError(
        `relationAssertion cannot bind Statement ref ${target}; use supportedBy`,
      );
    }
    bindings[role] = target;
  }
  validateCoreRelationShape(predicate, bindings, refTypes);
  if (!Array.isArray(entry.supportedBy) || entry.supportedBy.length === 0) {
    throw new AgentError(`relationAssertion.supportedBy requires at least one factRef: ${ref}`);
  }
  const supportedBy = [...new Set(entry.supportedBy.map((value) =>
    requiredString(value, "relationAssertion.supportedBy"),
  ))];
  for (const support of supportedBy) {
    if (!factRefs.has(support)) {
      throw new AgentError(`relationAssertion has unknown supporting fact: ${support}`);
    }
  }
  return {
    ref,
    predicate,
    bindings,
    supportedBy,
    ...(isRecord(entry.attributes) ? { attributes: entry.attributes } : {}),
    ...(stringArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
  };
}

function validateCoreRelationShape(
  predicate: string,
  bindings: Readonly<Record<string, string>>,
  refTypes: ReadonlyMap<string, string>,
): void {
  const roles = Object.keys(bindings).sort().join(",");
  if (predicate === "core:part_of") {
    if (roles !== "part,whole") {
      throw new AgentError("core:part_of requires exactly { part, whole }");
    }
    const partType = refTypes.get(bindings.part!);
    const wholeType = refTypes.get(bindings.whole!);
    if (partType?.startsWith("event:") !== wholeType?.startsWith("event:")) {
      throw new AgentError(
        `core:part_of cannot mix an event with a non-event whole: ${partType} -> ${wholeType}`,
      );
    }
    if (partType?.split(":", 1)[0] !== wholeType?.split(":", 1)[0]) {
      throw new AgentError(
        `core:part_of participants must share a structural namespace: ${partType} -> ${wholeType}`,
      );
    }
  }
  if (predicate === "core:instance_of" && roles !== "class,instance") {
    throw new AgentError("core:instance_of requires exactly { instance, class }");
  }
  if (predicate === "core:dimension_of") {
    if (roles !== "dimension,subject") {
      throw new AgentError("core:dimension_of requires exactly { dimension, subject }");
    }
    if (refTypes.get(bindings.dimension!) !== "core:dimension") {
      throw new AgentError("core:dimension_of dimension role must bind a Dimension");
    }
  }
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
  const byKey = new Map(dimensions.map((dimension) => [dimension.key, dimension.id]));
  const samples = new Map<string, unknown[]>();
  for (const statement of graph.queryNodes({ type: "core:statement" }) as StatementNode[]) {
    const values = samples.get(statement.dimension_id) ?? [];
    if (values.length >= 2) continue;
    values.push(statement.value);
    samples.set(statement.dimension_id, values);
  }
  return known.map((dimension) => ({
    ...dimension,
    sampleValues: samples.get(byKey.get(dimension.key) ?? "") ?? [],
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
