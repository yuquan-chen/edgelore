# edgelore

A shared memory graph for AI agents — with multi-constraint (hypergraph) checking, provenance, and human-in-the-loop.

## What it is

edgelore is an open-source memory backend that multiple coding agents
(codex, claude code, openclaw, …) can share. Memory is modeled as a graph:

- **Nodes** carry facts (dimensions, statements, actors, projects…) with a small,
  closed state machine (`tentative / accepted / conflict / superseded / rejected`).
- **Edges** capture relationships and provenance — who wrote what, when, and from
  what source.
- **Constraints** are hyperedges: N-ary rules over dimensions (e.g.
  `design_cost + production_cost <= approved_budget`) that are checked
  automatically.

The core design separates *computing* a value, *checking* a constraint, and
*accepting* a fact — so the system never silently turns "the formula holds" into
"the source is trustworthy".

## Status

**M0 (data model & state machine) is implemented and tested.** See [`docs/`](docs/) for the spec:

- [`docs/shared-memory-m0-spec.md`](docs/shared-memory-m0-spec.md) — data model & state machine (frozen, M0)
- [`docs/shared-memory-schema-draft.md`](docs/shared-memory-schema-draft.md) — earlier type draft
- [`schema.json`](schema.json) — JSON Schema contract (kept in sync with `src/model/types.ts`)

### Implemented

- `src/model/types.ts` — core types: `GraphNode` / `GraphEdge` / `Constraint`, open-world `NamespacedType`, `Provenance`, the 5 fact-node states + 4 constraint states.
- `src/model/identifiers.ts` — id generators (`node:` / `constraint:` / `edge:`) + namespace / provenance / id validators.
- `src/model/state-machine.ts` — allowed state transitions (with terminal `superseded` / `rejected`).
- `src/model/store.ts` — in-memory `MemoryGraph` enforcing mandatory provenance, type well-formedness, state-machine guards, and **Q01**: a constraint may only go `active` with a human approver.
- `schema.json` — JSON Schema (draft-07) contract, mirrored 1:1 by `types.ts`.

### Tests

- `test/model.test.ts` — **unit tests** for the model (provenance, open-world types, state machine, Q01, N-ary participants, edge endpoints).
- `test/contract.test.ts` — **contract tests** proving `schema.json` and the TS implementation agree (store output validates; invalid objects are rejected; schema version matches `SCHEMA_VERSION`).

### Up next

- **M1** — constraint expression engine (whitelisted AST → `satisfied / violated / indeterminate / error`).

## Develop

```bash
npm install
npm test      # tsc + node --test (unit + contract tests)
npm run build # emit dist/
```

## License

[MIT](LICENSE) — Copyright (c) 2026 charles chen
