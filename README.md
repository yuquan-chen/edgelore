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

Early design stage. See [`docs/`](docs/) for the spec:

- [`docs/shared-memory-m0-spec.md`](docs/shared-memory-m0-spec.md) — data model & state machine (frozen, M0)
- [`docs/shared-memory-schema-draft.md`](docs/shared-memory-schema-draft.md) — earlier type draft

## License

[MIT](LICENSE) — Copyright (c) 2026 charles chen
