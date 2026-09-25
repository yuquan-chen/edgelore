// edgelore · One-call bulk ingestion for the Property -> Slot -> Claim graph.
//
// The model extracts facts and proposes graph organization in one response.
// Normalization remains split: valid Claims survive even when graph metadata
// is malformed, so the runtime can fall back to owner-bound capture.

import type { NamespacedType } from "../model/types.js";
import {
  normalizeBatchContents,
  normalizeBatchExtractionReply,
  type BatchExtractionNormalizeResult,
} from "./extract.js";
import {
  normalizeGraphEnrichment,
  type EntityHint,
  type GraphEnrichmentPlan,
} from "./graph-enrichment.js";
import {
  buildBatchExtractionPrompt,
  type BatchExtractionPromptInput,
} from "./prompt.js";
import { SCOPE_OWNER_SUBJECT } from "./slots.js";

export interface IntegratedGraphPromptInput extends BatchExtractionPromptInput {
  entityHints: readonly EntityHint[];
  relationTypes: readonly NamespacedType[];
}

/** Add graph organization to the existing high-recall extraction contract
 * without sending the transcript through a second model call. */
export function buildIntegratedGraphExtractionPrompt(input: IntegratedGraphPromptInput): string {
  return [
    buildBatchExtractionPrompt(input),
    "",
    "### v7 graph organization (part of the SAME response)",
    "dimensionKey is a reusable subject-free Property key. The runtime creates one Slot for each (subjectRef, Property, scope).",
    `Every fact object, including kept eventDecisions content, MUST also contain a unique factRef and subjectRef. Use "${SCOPE_OWNER_SUBJECT}" for the memory owner's preferences, plans, experiences, relationships, and recommendations addressed to them. Use an entity ref only for an intrinsic property of that specific entity/event.`,
    `Example: a family trip uses subjectRef "${SCOPE_OWNER_SUBJECT}" and Property familyTrips; an object's intrinsic color uses that object's entity ref and Property objectColor. Merely being about an entity does NOT mean that entity owns the memory.`,
    "Use this general subject test: an entity owns the Slot only when the Claim can truthfully be phrased as '<entity>\'s <Property> is <value>' and would remain a property of that entity if the memory owner changed. An owner's action, plan, experience, preference, recommendation, or relationship stays on $scopeOwner even when it mentions or is about an entity.",
    `For example, a phone's battery capacity is intrinsic to the phone; the owner's plan to replace the phone is owner-bound. A professional's own license is intrinsic to that person; the owner's working relationship with the professional is owner-bound.`,
    "Measurements, specifications, capacities, and current physical/technical states of an owned object are intrinsic to that object even when phrased as 'I get', 'I have', or 'my'. For example, 'I get 10 hours of battery life from my laptop' belongs to the laptop's batteryLife Slot. Acquisition, usage, maintenance experiences, and future plans remain owner-bound.",
    "After extracting, organize every fact in factMappings. Reuse the SAME Property for facts that answer the same reusable question; remove destinations, dates, brands, and event identities from Property keys. Do not mint one Property per fact.",
    "Graph organization is metadata and does NOT compete with the contents budget. Do not shorten or omit Claims to make room for entities/relations. Preserve detailed assistant recommendations, mappings, lists, and quantities as Claims before organizing them.",
    "A non-owner subjectRef MUST match an entity ref returned in entities. Reuse a Property across different subjects; never put an entity identity in the Property key.",
    "Create entities for distinct people, places, owned objects, products, and real-world events mentioned by kept facts. A user experience remains owner-bound, but core:about should connect its Claim to the event/entity. entities may be empty ONLY when none of the kept facts mentions a distinct entity or occurrence.",
    "Every fact about a specific entity/event should have one core:about relation. Represent travel, purchases, workshops, ceremonies, incidents, repairs, and races as event entities; do not turn them into Property identities.",
    "Relations may start at a factRef. Never emit core:contradicts, core:refines, or core:supersedes; governed reconciliation owns those decisions.",
    `Existing entities (reuse only for the same identity): ${JSON.stringify(input.entityHints)}`,
    `Existing relation types: ${JSON.stringify(input.relationTypes)}`,
    "",
    "The single JSON response must therefore contain contents, eventDecisions, factMappings, entities, and relations:",
    `{ "contents": [{"factRef":"f1","subjectRef":"${SCOPE_OWNER_SUBJECT}","dimensionKey":"NEW:familyTrips","value":"...","saidBy":"user"}],`,
    `  "eventDecisions": [],`,
    `  "factMappings": [{"factRef":"f1","subjectRef":"${SCOPE_OWNER_SUBJECT}","dimensionKey":"NEW:familyTrips","dimensionDescription":"Family travel experiences","cardinality":"multi"}],`,
    `  "entities": [{"ref":"trip","type":"travel:trip","key":"hawaii-family-trip","value":"Hawaii family trip","scope":"context"}],`,
    `  "relations": [{"type":"core:about","from":"f1","to":"trip"}] }`,
    "Return that ONE object only. Do not repeat the transcript or explain the graph.",
  ].join("\n");
}

export interface IntegratedGraphNormalizeResult {
  batch: BatchExtractionNormalizeResult;
  plan: GraphEnrichmentPlan;
}

/** Normalize the one-call response. Throws only for a malformed graph plan;
 * callers should retain `normalizeBatchExtractionReply(raw, ...)` as their
 * Claim-preserving fallback. */
export function normalizeIntegratedGraphExtractionReply(
  raw: unknown,
  expectedEventCount: number,
  knownKeys?: ReadonlySet<string>,
): IntegratedGraphNormalizeResult {
  const batch = normalizeBatchExtractionReply(raw, expectedEventCount, knownKeys);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("integrated graph extraction reply must be an object");
  }
  const reply = raw as Record<string, unknown>;
  const rawCandidates: unknown[] = [];
  if (Array.isArray(reply.eventDecisions)) {
    for (const value of reply.eventDecisions) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const decision = value as Record<string, unknown>;
      if (decision.decision !== "keep") continue;
      rawCandidates.push(decision.content ?? decision.entry ?? decision.memory ?? decision);
    }
  }
  if (Array.isArray(reply.contents)) rawCandidates.push(...reply.contents);

  const metadataByIdentity = new Map<string, { factRefs: Set<string>; subjectRef: string }>();
  for (const candidate of rawCandidates) {
    const normalized = normalizeBatchContents([candidate], knownKeys).contents[0];
    if (!normalized || typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      continue;
    }
    const entry = candidate as Record<string, unknown>;
    const identity = contentIdentity(normalized);
    const factRef =
      typeof entry.factRef === "string" && entry.factRef.trim()
        ? entry.factRef.trim()
        : undefined;
    const subjectRef =
      typeof entry.subjectRef === "string" && entry.subjectRef.trim()
        ? entry.subjectRef.trim()
        : SCOPE_OWNER_SUBJECT;
    const existing = metadataByIdentity.get(identity);
    if (existing) {
      if (factRef) existing.factRefs.add(factRef);
      if (existing.subjectRef === SCOPE_OWNER_SUBJECT && subjectRef !== SCOPE_OWNER_SUBJECT) {
        existing.subjectRef = subjectRef;
      }
      continue;
    }
    metadataByIdentity.set(identity, {
      factRefs: new Set(factRef ? [factRef] : []),
      subjectRef,
    });
  }

  const modelToCanonical = new Map<string, string>();
  const proposedMappings = new Map<string, Record<string, unknown>>();
  if (Array.isArray(reply.factMappings)) {
    for (const rawMapping of reply.factMappings) {
      if (typeof rawMapping !== "object" || rawMapping === null || Array.isArray(rawMapping)) continue;
      const mapping = rawMapping as Record<string, unknown>;
      if (typeof mapping.factRef === "string") proposedMappings.set(mapping.factRef, mapping);
    }
  }
  const factMappings = batch.contents.map((content, index) => {
    const metadata = metadataByIdentity.get(contentIdentity(content));
    const canonical = `fact:${index}`;
    for (const factRef of metadata?.factRefs ?? []) modelToCanonical.set(factRef, canonical);
    const proposed = [...(metadata?.factRefs ?? [])]
      .map((factRef) => proposedMappings.get(factRef))
      .find(Boolean);
    return {
      factRef: canonical,
      subjectRef: preferredSubjectRef(proposed?.subjectRef, metadata?.subjectRef),
      dimensionKey:
        typeof proposed?.dimensionKey === "string"
          ? proposed.dimensionKey
          : content.dimensionKey,
      ...(typeof proposed?.dimensionDescription === "string"
        ? { dimensionDescription: proposed.dimensionDescription }
        : content.description
          ? { dimensionDescription: content.description }
          : {}),
      ...(proposed?.cardinality === "single" || proposed?.cardinality === "multi"
        ? { cardinality: proposed.cardinality }
        : content.cardinality
          ? { cardinality: content.cardinality }
          : {}),
    };
  });
  const relations = Array.isArray(reply.relations)
    ? reply.relations.map((value) => rewriteRelationRefs(value, modelToCanonical))
    : [];
  const plan = normalizeGraphEnrichment(
    {
      factMappings,
      entities: Array.isArray(reply.entities) ? reply.entities : [],
      relations,
    },
    batch.contents,
  );
  return {
    batch: { ...batch, contents: plan.facts.map((fact) => fact.content) },
    plan,
  };
}

function preferredSubjectRef(proposed: unknown, extracted: string | undefined): string {
  const proposedRef = typeof proposed === "string" && proposed.trim() ? proposed.trim() : undefined;
  const extractedRef = extracted?.trim() || undefined;
  // A concrete entity subject is more informative than the safe owner
  // default, regardless of which same-response section supplied it.
  if (proposedRef && proposedRef !== SCOPE_OWNER_SUBJECT) return proposedRef;
  if (extractedRef && extractedRef !== SCOPE_OWNER_SUBJECT) return extractedRef;
  return proposedRef ?? extractedRef ?? SCOPE_OWNER_SUBJECT;
}

function contentIdentity(content: {
  dimensionKey: string;
  value: unknown;
  unit?: string;
  saidBy?: string;
}): string {
  return JSON.stringify([
    content.dimensionKey,
    content.value,
    content.unit ?? null,
    content.saidBy ?? null,
  ]);
}

function rewriteRelationRefs(raw: unknown, refs: ReadonlyMap<string, string>): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const relation = raw as Record<string, unknown>;
  return {
    ...relation,
    ...(typeof relation.from === "string" && refs.has(relation.from)
      ? { from: refs.get(relation.from) }
      : {}),
    ...(typeof relation.to === "string" && refs.has(relation.to)
      ? { to: refs.get(relation.to) }
      : {}),
  };
}
