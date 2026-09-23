// edgelore · Compatibility semantics for subject-bound memory slots.
//
// The persisted M0 names remain `core:dimension` / `core:statement` while we
// validate the stronger Property -> Slot -> Claim model.  Slot identity is
// (subject, property, scope); the two semantic coordinates live in open
// dimension attributes so existing databases and APIs remain readable.

import type { DimensionNode } from "../model/types.js";
import type { GraphStore } from "../model/store.js";

/** Reserved subject for memories about the owner of the current scope. */
export const SCOPE_OWNER_SUBJECT = "$scopeOwner";

export const SLOT_PROPERTY_KEY_ATTRIBUTE = "propertyKey";
export const SLOT_SUBJECT_REF_ATTRIBUTE = "subjectRef";

/** Legacy dimensions were implicitly about the scope owner. */
export function slotSubjectRef(dimension: DimensionNode): string {
  const stored = dimension.attributes?.[SLOT_SUBJECT_REF_ATTRIBUTE];
  return typeof stored === "string" && stored.length > 0 ? stored : SCOPE_OWNER_SUBJECT;
}

/** Until Property is formally migrated, the physical key is the fallback. */
export function slotPropertyKey(dimension: DimensionNode): string {
  const stored = dimension.attributes?.[SLOT_PROPERTY_KEY_ATTRIBUTE];
  return typeof stored === "string" && stored.length > 0 ? stored : dimension.key;
}

/** Human/retrieval label for a Slot's subject without changing its identity. */
export function slotSubjectLabel(graph: GraphStore, dimension: DimensionNode): string | null {
  const ref = slotSubjectRef(dimension);
  if (ref === SCOPE_OWNER_SUBJECT) return null;
  const subject = graph.getNode(ref);
  if (!subject) return ref;
  if (typeof subject.value === "string" && subject.value.trim().length > 0) return subject.value;
  if (subject.key) return subject.key;
  return ref;
}

/** Retrieval-facing label. Owner-bound slots keep the legacy compact key. */
export function slotLabel(graph: GraphStore, dimension: DimensionNode): string {
  const property = slotPropertyKey(dimension);
  const subject = slotSubjectLabel(graph, dimension);
  return subject ? `${subject}.${property}` : property;
}
