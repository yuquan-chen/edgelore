# edgelore · M3 — Memory Capture Primitive (spec, draft for review)

> Status: **frozen — implemented**. Built per the two-layer model: `capture`
> consumes the Agent Memory layer's structured JSON and persists it.
> Precedes: M0 (model), M1 (engine), M2 (persistence + CLI). All shipped.
> Companion note: `docs/notes/m3.md` (written after build).

## 1. Goal

M3 is **not** a full "memory agent". It is the **storage primitive** that turns
a memory the Agent decided to keep into correct graph mutations.

M0–M2 gave us a graph, a rule engine, and durable storage. What is still missing
is the **"how to store"** step: given a memory the Agent already understood, put
it into the graph the right way — find/create the dimension, dedupe, set the
right state, and flag conflicts. M3 builds exactly that, and nothing more.

**Out of scope (explicitly deferred):**
- *What* to store / *when* to capture (the trigger & extraction from a live
  conversation). That is a later milestone.
- LLM-based "understand this sentence → which dimension" resolution. In M3 the
  Agent already supplies the structured content; capture does not guess.
- Scope/namespacing of dimensions, MCP server, visualization.

## 2. The field dichotomy (the core principle of M3)

Every field on a stored node originates from exactly one of three sources. This
is the spine of the design and must not be blurred:

| Source | Fields | Who decides the value |
|--------|--------|----------------------|
| **① Read from context** (provenance) | `created_by`, `source_refs`, `created_at` | The **runtime reads** it (who is speaking, which message/conversation). The Agent (LLM) never types these. |
| **② Agent-operated** (content) | `dimensionKey` → dimension `key` + statement `dimension_id`; `value`; `cardinality`; `unit` | The **Agent** decides by understanding the memory. |
| **③ System-mechanism** (auto) | `id`, `type`, `state`, `updated_at`, `schema_version`, dimension `cardinality` default | `capture` generates on store. |

Consequence: `capture`'s input carries **only ②**. Provenance (①) is supplied by
a *runtime-read* context object, never authored by the Agent's reasoning. This
keeps the Agent honest (it cannot forge "who said it") and keeps capture testable.

## 3. Interface

```ts
// ② Agent-operated content — the ONLY thing the Agent authors.
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

// ① Provenance — populated by the runtime (reads context), NOT by the Agent.
export interface CaptureContext {
  /** Resolved speaker, e.g. "agent:workbuddy:1" or "human:charles". */
  created_by: string;
  /** Resolved source references (message / conversation ids). */
  source_refs: string[];
}

// The primitive. Works on MemoryGraph and SqliteGraph alike.
export function capture(
  graph: GraphStore,
  content: CaptureContent,
  ctx: CaptureContext,
): CaptureResult;
```

`CaptureContext` is intentionally separate from `CaptureContent` so it is obvious
which fields the Agent controls and which the runtime injects.

## 4. Storage mechanics ("how to store")

Executed in order:

1. **Resolve dimension.** Look up an existing `core:dimension` whose `key`
   equals `content.dimensionKey` (global scope in M3; scope is a future
   extension). If none, create one with `cardinality` = `content.cardinality ??
   "multi"`.
2. **Dedupe.** If a statement already exists under this dimension with a
   deep-equal `value`, **do not create a duplicate**. Return
   `deduplicated: true` and the existing statement id. (Multi-value dimensions
   still dedupe exact repeats — they just allow *different* values to coexist.)
3. **Write statement.** Create a `core:statement` with `dimension_id` =
   dimension id, `value`, `unit`, `state = "accepted"`, and provenance from
   `ctx` (`created_by`, `source_refs`, `created_at = now()`, `schema_version`).
4. **Conflict (single-cardinality only).** If the dimension is `cardinality:
   "single"` and an **accepted** statement with a *different* value already
   exists:
   - the new statement is created with `state = "tentative"` (awaiting human
     resolution),
   - the existing accepted statement is left untouched,
   - the dimension node's `state` is set to `"conflict"`,
   - `CaptureResult.conflict = true`.
   Multi-cardinality dimensions never conflict — every distinct value is added
   as `accepted`.

## 5. Return value

```ts
export interface CaptureResult {
  dimensionId: string;
  statementId: string | null; // null when deduplicated (no new statement)
  created: boolean;           // a new dimension was created
  deduplicated: boolean;      // value already existed → no new statement
  conflict: boolean;          // single-cardinality clash → tentative + flagged
}
```

## 6. Tests (the M3 contract)

All tests follow the user-mandated pattern: **one `CaptureContent` input (+ an
injected `CaptureContext`) → assert the resulting graph state.** No trigger /
extraction logic is exercised. Cases:

1. **First capture** of a key → dimension created (`multi` default) + accepted
   statement.
2. **Exact duplicate** → no new statement, `deduplicated: true`.
3. **Multi-cardinality, distinct values** → both `accepted`, no conflict.
4. **Single-cardinality, conflicting value** → new statement `tentative`, old
   `accepted` untouched, dimension `state = conflict`, `conflict: true`.
5. **Single-cardinality, same value after conflict** → still deduplicated.
6. **Provenance auto-filled** → `created_by` / `source_refs` come from `ctx`,
   never from `content`; assert they land on the statement.
7. **Durable** → run on `SqliteGraph`, reopen, assert the same state (parity
   with the in-memory graph).

## 7. Files

| File | Role |
|------|------|
| `src/agent/capture.ts` | `capture()`, `CaptureContent`, `CaptureContext`, `CaptureResult`. |
| `src/model/store.ts` | `GraphStore` interface extracted so `capture` accepts both backends (small refactor: pull the shared method signatures into an interface; both `MemoryGraph` and `SqliteGraph` already implement them). |
| `test/capture.test.ts` | The 7 cases above, run against both backends. |
| `docs/shared-memory-m3-spec.md` | This document. |
| `docs/notes/m3.md` | Post-build technical note (concrete types + mechanics). |

## 8. Decisions (resolved during build)

- **Dimension scope**: M3 keeps dimensions **global** (no project/phase
  partitioning yet). Deferred — matches the "先全局" decision.
- **`capture` location**: `src/agent/capture.ts` — mirrors the "Agent operates
  content" framing; the runtime injects provenance separately.
- **Conflict resolution**: M3 only *flags* single-cardinality conflicts
  (dimension → `conflict`, newcomer → `tentative`). The human-resolution step
  (`resolveConflict()`) is deferred to M4.
- **Two-layer model (the guiding principle)**: the whole memory loop is two
  segments — ① the Agent Memory layer turns a raw sentence into a structured
  `CaptureContent` JSON; ② the storage layer (`capture`) persists that JSON.
  M3 implements only ②. The "一句话进来" is the *external* entry of ①, not an
  input to `capture`.
