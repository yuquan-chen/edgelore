// edgelore · Graph enrichment — preserve extracted facts, add graph shape.
//
// This is intentionally a separate model pass from gate/extract. Extraction
// owns recall and wording; enrichment may only classify the already-extracted
// facts, identify reusable entities/events, and connect them. If this pass
// fails, callers can safely fall back to capture() without losing facts.

import type { GraphStore } from "../model/store.js";
import { scopesEqual } from "../model/store.js";
import type { GraphNode, NamespacedType, Scope } from "../model/types.js";
import type { CaptureContent } from "./capture.js";
import { AgentError } from "./errors.js";
import type { EntityDraft, GraphWritePlan, RelationDraft } from "./graph-write.js";
import { parseJsonReply, type LlmDriver } from "./llm-driver.js";
import type { KnownDimension } from "./prompt.js";

const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const NAMESPACED_TYPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/i;
const FACT_REF = (index: number) => `fact:${index}`;

export interface GraphEnrichmentInput {
  text: string;
  contents: readonly CaptureContent[];
  knownDimensions: readonly KnownDimension[];
  graph: GraphStore;
  driver: LlmDriver;
  scope?: Scope;
  maxEntityHints?: number;
}

interface FactMapping {
  factRef: string;
  dimensionKey: string;
  dimensionDescription?: string;
  cardinality?: "single" | "multi";
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
export async function runGraphEnrichment(input: GraphEnrichmentInput): Promise<GraphWritePlan> {
  if (input.contents.length === 0) return { entities: [], facts: [], relations: [] };

  const hints = entityHintsOf(
    input.graph,
    input.scope,
    input.maxEntityHints ?? 40,
  );
  const prompt = buildGraphEnrichmentPrompt({
    text: input.text,
    contents: input.contents,
    knownDimensions: input.knownDimensions,
    entityHints: hints,
  });
  const parsed = parseJsonReply(await input.driver.complete(prompt));
  return normalizeGraphEnrichment(parsed, input.contents);
}

export interface GraphEnrichmentPromptInput {
  text: string;
  contents: readonly CaptureContent[];
  knownDimensions: readonly KnownDimension[];
  entityHints: readonly EntityHint[];
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
    "Choose reusable subject-free dimension categories. A destination or event instance belongs in an entity, not in the dimension key: use familyTrips for both a Hawaii trip and a Paris trip, never familyTripHawaii/familyTripParis.",
    "Represent a distinct real-world occurrence as an event entity (for example travel:trip). Reuse an existing entity only when it is the same identity, not merely a similar kind.",
    "All claim-sensitive semantic relations MUST start at a factRef (the persisted Statement), so their trust follows that statement. Use core:about from a fact to its main entity/event.",
    "Never output ids, provenance, timestamps, state, saidBy, or fact values. The runtime owns those fields.",
    "Entity and relation types are open-world namespaced strings such as travel:trip, geo:place, travel:destination, or core:about.",
    `Known dimensions:\n${JSON.stringify(input.knownDimensions)}`,
    `Existing entities in the applicable context (reuse type+key only for the same identity):\n${JSON.stringify(input.entityHints)}`,
    `Immutable extracted facts:\n${JSON.stringify(facts)}`,
    `Source conversation:\n${input.text}`,
    `Respond with ONLY one JSON object:
{
  "factMappings": [
    {"factRef":"fact:0","dimensionKey":"familyTrips","dimensionDescription":"Family travel experiences","cardinality":"multi"}
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
): GraphWritePlan {
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
        dimensionKey: mapping.dimensionKey,
        ...(mapping.dimensionDescription
          ? { description: mapping.dimensionDescription }
          : {}),
        ...(mapping.cardinality ? { cardinality: mapping.cardinality } : {}),
      },
    };
  });

  const entities = reply.entities.map(normalizeEntityDraft);
  const allRefs = new Set(facts.map((fact) => fact.ref));
  for (const entity of entities) {
    if (allRefs.has(entity.ref)) throw new AgentError(`duplicate graph enrichment ref: ${entity.ref}`);
    allRefs.add(entity.ref);
  }
  const relations = reply.relations.map((value) => normalizeRelationDraft(value, allRefs));
  for (const relation of relations) {
    if (!expectedRefs.has(relation.from)) {
      throw new AgentError(
        `claim-sensitive relation ${relation.type} must start at a factRef, got: ${relation.from}`,
      );
    }
  }
  return { entities, facts, relations };
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
