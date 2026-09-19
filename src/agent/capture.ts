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
  SaidBy,
  StatementNode,
} from "../model/types.js";
import type { GraphStore } from "../model/store.js";
import { AgentError } from "./errors.js";

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
  /** Human-language description of the slot — ONLY used when CREATING a new
   * dimension, stored as `attributes.description`. This is what later sessions'
   * extractors read to map phrases onto the same key (anti-drift). */
  description?: string;
  /**
   * Content-axis speaker (who said this IN the conversation) — see SaidBy.
   * This does NOT break the "Agent never writes provenance" rule: provenance
   * (`created_by`) is the SYSTEM axis (which principal wrote the object),
   * runtime-injected; `saidBy` is the CONTENT axis (part of what the fact
   * is), agent-authored. Trust policy keys off it: assistant statements
   * enter `tentative` pending user confirmation.
   */
  saidBy?: SaidBy;
}

/** ① Provenance — populated by the runtime (reads context), NOT by the Agent. */
export interface CaptureContext {
  /** Resolved speaker, e.g. "agent:workbuddy:1" or "human:charles". */
  created_by: string;
  /** Resolved source references (message / conversation ids). */
  source_refs: string[];
  /** When the fact was actually said — for importing historical data. Omit
   * for live captures (defaults to now). ISO-8601. */
  createdAt?: string;
}

export interface CaptureResult {
  dimensionId: string;
  statementId: string | null; // null when deduplicated (no new statement)
  created: boolean; // a new dimension was created
  deduplicated: boolean; // value already existed -> no new statement
  conflict: boolean; // a user-side clash got (or is) flagged on the dimension
  /** Final statement state (so callers can distinguish "pending user
   * confirmation" from "conflict flagged" without re-reading the graph). */
  state: FactNodeState;
}

/** Deep-equality for arbitrary JSON-serializable values. */
export function valuesEqual(a: unknown, b: unknown): boolean {
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
  // 0. Validate the agent-authored attribution at the boundary — capture is
  // the last wall before the graph; malformed attribution fails loud here.
  if (content.saidBy !== undefined && content.saidBy !== "user" && content.saidBy !== "assistant") {
    throw new AgentError(
      `CaptureContent.saidBy must be "user" | "assistant", got: ${JSON.stringify(content.saidBy)}`,
    );
  }
  const saidByAssistant = content.saidBy === "assistant";

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
      // description rides in open metadata (M0 §1.3: narrow state, wide
      // metadata) — it is what future extractors match phrases against.
      attributes: content.description ? { description: content.description } : {},
      created_by: ctx.created_by,
      created_at: ctx.createdAt,
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
    // A user restating a tentative value carries intent — three cases:
    //   a. plain confirmation (no rival, no live adjudication): promote it;
    //   b. restating AGAINST an incumbent accepted value (single-cardinality):
    //      the restatement makes the clash user-backed — flag the dimension so
    //      resolve can adjudicate (never silently mint a second accepted);
    //   c. an adjudication is already running (dimension conflict): hands off —
    //      flipping values behind resolve's back would bypass the human.
    const rivalAccepted =
      cardinality === "single" &&
      sameDim.some((s) => s.state === "accepted" && !valuesEqual(s.value, content.value));
    let conflictFlagged = false;
    if (dup.state === "tentative" && !saidByAssistant) {
      if (rivalAccepted) {
        if (dimension.state !== "conflict") graph.transitionNodeState(dimension.id, "conflict");
        conflictFlagged = true;
      } else if (dimension.state !== "conflict") {
        graph.transitionNodeState(dup.id, "accepted");
      }
    }
    return {
      dimensionId: dimension.id,
      statementId: dup.id,
      created,
      deduplicated: true,
      conflict: conflictFlagged,
      state: graph.getNode(dup.id)!.state,
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
  // Assistant-authored facts always await user confirmation (W2), regardless
  // of cardinality. The dimension is deliberately NOT flagged: an assistant
  // claim is not a user-vs-user clash, so it must not pollute the human
  // adjudication queue (listConflicts reads dimension.state).
  if (saidByAssistant && newState === "accepted") {
    newState = "tentative";
  }

  const stmt = graph.addNode({
    type: "core:statement",
    dimension_id: dimension.id,
    value: content.value,
    unit: content.unit,
    state: newState,
    ...(content.saidBy !== undefined ? { saidBy: content.saidBy } : {}),
    created_by: ctx.created_by,
    created_at: ctx.createdAt,
    source_refs: ctx.source_refs,
  }) as StatementNode;

  // Only USER-side tentative states flag the dimension (see above).
  if (newState === "tentative" && !saidByAssistant) {
    graph.transitionNodeState(dimension.id, "conflict");
  }

  return {
    dimensionId: dimension.id,
    statementId: stmt.id,
    created,
    deduplicated: false,
    conflict: newState === "tentative" && !saidByAssistant,
    state: newState,
  };
}
