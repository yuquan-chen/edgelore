// edgelore · M3 — Memory capture primitive (the storage layer).
//
// capture() is the "hand" of the memory agent. The full loop is two layers:
//   ① Agent Memory layer (future): a raw sentence -> decides whether to store
//      -> emits a structured CaptureContent (the JSON/API contract).
//   ② Storage layer (this file, M3): takes that CaptureContent + a runtime-
//      supplied CaptureContext (provenance) and persists it correctly.
//
// capture does NOT decide *what* to remember or *when* — that is the Agent
// Memory layer's job. It only stores, deduplicates, and flags conflicts.

import type {
  DimensionNode,
  FactNodeState,
  GraphNode,
  StatementNode,
} from "../model/types.js";
import type { GraphStore } from "../model/store.js";

/** ② Agent-operated content — the ONLY fields the Agent authors. This is the
 * JSON/API contract between the Agent Memory layer and storage. */
export interface CaptureContent {
  /** Stable dimension key, e.g. "edgelore_author". Finds or creates the dimension. */
  dimensionKey: string;
  /** The memory value (any JSON-serializable type). */
  value: unknown;
  /** Only used when CREATING a new dimension. Defaults to "multi". */
  cardinality?: "single" | "multi";
  /** Optional unit, e.g. "CNY". */
  unit?: string;
}

/** ① Provenance — populated by the runtime (reads context), NOT by the Agent. */
export interface CaptureContext {
  /** Resolved speaker, e.g. "agent:workbuddy:1" or "human:charles". */
  created_by: string;
  /** Resolved source references (message / conversation ids). */
  source_refs: string[];
}

export interface CaptureResult {
  dimensionId: string;
  statementId: string | null; // null when deduplicated (no new statement)
  created: boolean; // a new dimension was created
  deduplicated: boolean; // value already existed -> no new statement
  conflict: boolean; // single-cardinality clash -> tentative + flagged
}

/** Deep-equality for arbitrary JSON-serializable values. */
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persist a memory the Agent Memory layer already understood.
 *
 * @param graph any backend implementing GraphStore (in-memory or SQLite)
 * @param content the structured memory (Agent-authored)
 * @param ctx provenance (runtime-authored)
 */
export function capture(graph: GraphStore, content: CaptureContent, ctx: CaptureContext): CaptureResult {
  // 1. Resolve dimension (global scope in M3; scope is a future extension).
  const dimensions = graph.queryNodes({ type: "core:dimension" }) as DimensionNode[];
  const existing = dimensions.find((d) => d.key === content.dimensionKey);
  let dimension: GraphNode;
  let created = false;
  if (existing) {
    dimension = existing;
  } else {
    dimension = graph.addNode({
      type: "core:dimension",
      key: content.dimensionKey,
      cardinality: content.cardinality ?? "multi",
      created_by: ctx.created_by,
      source_refs: ctx.source_refs,
    });
    created = true;
  }
  const cardinality = dimension.cardinality ?? "multi";

  // 2. Dedupe — an exact repeat of an existing statement value is not re-added.
  const statements = graph.queryNodes({ type: "core:statement" }) as StatementNode[];
  const sameDim = statements.filter((s) => s.dimension_id === dimension.id);
  const dup = sameDim.find((s) => valuesEqual(s.value, content.value));
  if (dup) {
    return {
      dimensionId: dimension.id,
      statementId: dup.id,
      created,
      deduplicated: true,
      conflict: false,
    };
  }

  // 3+4. Decide the new statement's state.
  // Single-cardinality: if an ACCEPTED statement with a different value already
  // exists, the newcomer is tentative (awaiting human resolution) and the
  // dimension is flagged "conflict". Otherwise the newcomer is accepted.
  let newState: FactNodeState = "accepted";
  if (cardinality === "single") {
    const accepted = sameDim.find((s) => s.state === "accepted");
    if (accepted && !valuesEqual(accepted.value, content.value)) {
      newState = "tentative";
    }
  }

  const stmt = graph.addNode({
    type: "core:statement",
    dimension_id: dimension.id,
    value: content.value,
    unit: content.unit,
    state: newState,
    created_by: ctx.created_by,
    source_refs: ctx.source_refs,
  }) as StatementNode;

  if (newState === "tentative") {
    graph.transitionNodeState(dimension.id, "conflict");
  }

  return {
    dimensionId: dimension.id,
    statementId: stmt.id,
    created,
    deduplicated: false,
    conflict: newState === "tentative",
  };
}
