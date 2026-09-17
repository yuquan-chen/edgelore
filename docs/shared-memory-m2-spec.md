# edgelore · M2 — Persistence (SQLite) + Minimal CLI (FROZEN)

> M0 froze the data model; M1 made constraints evaluable. But the graph still
> lived only in process memory — nothing survived a restart, and no agent could
> touch it. **M2 makes the memory durable and gives agents a mouth.**
>
> Companion technical note: [`docs/notes/m2.md`](./notes/m2.md).

## 1. Goal

Two deliverables, one validation story:

1. **Persistence** — the graph survives process restarts (SQLite, zero external
   dependencies).
2. **Minimal CLI** — the bridge through which real agents (claude code, codex)
   read/write the graph via plain shell commands with JSON in/out.

The M2 acceptance test is deliberately human-verifiable: write memory through
the CLI, kill the process, reopen, and the memory (and rule evaluation) is
still there.

## 2. Storage engine: built-in `node:sqlite`

- **Decision:** Node 22's built-in `node:sqlite` (`DatabaseSync`). Probed and
  verified working on the project's pinned runtime (22.22.2): `exec`,
  `prepare().run()`, `prepare().get()` all behave. **Zero npm dependencies.**
- **Trade-off accepted:** the module is flagged *experimental* (prints a
  warning to stderr on load). Stdout stays clean JSON, so the CLI contract is
  unaffected. If the API ever breaks, the escape hatch is `better-sqlite3`
  behind the same `SqliteGraph` API (documented fallback, not implemented).
- **Concurrency model:** single-writer, WAL journal mode. Multi-process writes
  are out of M2 scope.

## 3. Schema design: JSON blob + index columns

Open-world typing (M0 §1.1) means the column set can NOT be closed. So rows
store the **full object as JSON** plus a few indexed columns for queries:

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,          -- index
  state        TEXT NOT NULL,          -- index (fact-node state)
  dimension_id TEXT,                   -- index (statements only)
  data         TEXT NOT NULL           -- full node as JSON
);
CREATE TABLE IF NOT EXISTS edges (
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  data    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS constraints (
  id    TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,
  state TEXT NOT NULL,                 -- index (activation state)
  data  TEXT NOT NULL
);
```

Type evolution never requires a migration: new attributes ride inside `data`.
Upserts use `INSERT OR REPLACE` keyed by id.

## 4. `SqliteGraph` (`src/store/sqlite.ts`)

- **Extends `MemoryGraph`.** The in-memory store is the reference
  implementation of all model enforcement (provenance, ids, state machines,
  Q01). SqliteGraph reuses 100% of that logic and adds durability:
  - **On open:** create tables if missing; load every row into the inherited
    maps (JSON.parse).
  - **Write-through:** `addNode` / `addEdge` / `addConstraint` /
    `transitionNodeState` / `transitionConstraintState` call `super`, then
    upsert the resulting object.
- **Inherited for free:** all getters, `queryNodes`, `evaluateConstraint`
  (operates on the loaded maps).
- **Minimal refactor:** `MemoryGraph`'s three maps change `private` →
  `protected`. No other M0/M1 code touched.
- **Scope note:** this is a *durable write-through cache* — the whole graph is
  resident in memory. Lazy loading / paging for very large graphs is deferred.

## 5. Minimal CLI (`src/cli.ts`, bin: `edgelore`)

The agent bridge. Design rules: **JSON in, JSON out**; single-line results on
stdout; errors as `{"error": "..."}` on stderr with exit code 1; no
interactivity, no human formatting.

```
edgelore [--db path.db] <command>

  node add        --type t --created-by who [--key k] [--dimension-id id]
                  [--value JSON] [--unit u] [--state s] [--attributes JSON]
                  [--tags a,b]
  node list       [--type t] [--state s]
  edge add        --type t --from id --to id --created-by who
  edge list
  constraint add  --participants id1,id2 --bindings JSON [--expression JSON]
                  --created-by who [--name n]
  constraint activate <id> --approved-by human:x
  constraint list
  evaluate        <constraint-id>
  get             <id>                  # node / edge / constraint
```

- `--db` defaults to `./edgelore.db`.
- `--value` / `--attributes` / `--bindings` / `--expression` are parsed as
  JSON (`--value` falls back to a bare string if not valid JSON).
- Q01 is exercised through the real path: `constraint add` creates `proposed`;
  only `constraint activate ... --approved-by human:x` can flip to `active`.

## 6. Tests (`test/sqlite.test.ts`)

- **Behavior parity:** add/transition/Q01-gate/evaluate behave identically to
  the in-memory store.
- **Persistence:** write nodes + an active constraint, close, reopen a fresh
  `SqliteGraph` on the same file, assert the objects and `evaluateConstraint`
  results survive.
- Temp databases under the OS temp dir, cleaned up per test.

## 7. What M2 explicitly does NOT do

- MCP server (remains M3 — the "real protocol" integration).
- Multi-process / multi-tenant concurrency, auth.
- Lazy loading for large graphs; graph visualization.
- Backup/export tooling (`node:sqlite` exposes `backup`; deferred).

## 8. The M2 validation story (real agent, not a scripted demo)

After M2 ships, a real agent (claude code) drives the CLI end-to-end:
create a dimension → write statements → add + activate a constraint (Q01,
human approval) → evaluate → **kill the process** → reopen → evaluate again.
Memory and rules intact. That is the "比较好地验证记忆" milestone.
