// edgelore · M0 — Identifiers & namespace validation.
//
// Generates canonical ids (`node:<type>:<uuid>`, `constraint:<uuid>`,
// `edge:<uuid>`) and validates the open-world type / provenance strings so the
// data model stays self-consistent regardless of which agent writes it.

import { randomUUID } from "node:crypto";
import { CORE_NAMESPACE, type NamespacedType } from "./types.js";

/** `node:<type>:<uuid>` — global, cross-agent referenceable. */
export function nodeId(type: NamespacedType, uuid: string = randomUUID()): string {
  return `node:${type}:${uuid}`;
}

/** `constraint:<uuid>`. */
export function constraintId(uuid: string = randomUUID()): string {
  return `constraint:${uuid}`;
}

/** `edge:<uuid>`. */
export function edgeId(uuid: string = randomUUID()): string {
  return `edge:${uuid}`;
}

/** `constraint-revision:<n>`. */
export function revisionId(n: number): string {
  return `constraint-revision:${n}`;
}

const NAMESPACE_RE = /^[\w.-]+:[\w.-]+$/;
const ID_RE = /^[A-Za-z0-9._:-]+$/;
const CREATED_BY_RE = /^(agent|human):[\w.-]+(:[\w.-]+)?$/;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** A namespaced type must be `<scope>:<name>` (open-world, but well-formed). */
export function validateType(type: string): ValidationResult {
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, reason: "type must be a non-empty string" };
  }
  if (!NAMESPACE_RE.test(type)) {
    return {
      ok: false,
      reason: `type "${type}" must be namespaced as "<scope>:<name>" (e.g. core:actor, codex:task)`,
    };
  }
  return { ok: true };
}

/** `core:*` types are reserved for the edgelore maintainers. */
export function isCoreType(type: string): boolean {
  return type.startsWith(`${CORE_NAMESPACE}:`);
}

/** `created_by` must look like `agent:<name>:<id>` or `human:<id>`. */
export function validateCreatedBy(createdBy: string): ValidationResult {
  if (typeof createdBy !== "string" || createdBy.length === 0) {
    return { ok: false, reason: "created_by must be a non-empty string" };
  }
  if (!CREATED_BY_RE.test(createdBy)) {
    return {
      ok: false,
      reason: `created_by "${createdBy}" must match "agent:<name>:<id>" or "human:<id>"`,
    };
  }
  return { ok: true };
}

/** Ids are opaque but must be well-formed (no spaces / control chars). */
export function validateId(id: string): ValidationResult {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, reason: "id must be a non-empty string" };
  }
  if (!ID_RE.test(id)) {
    return { ok: false, reason: `id "${id}" contains illegal characters` };
  }
  return { ok: true };
}
