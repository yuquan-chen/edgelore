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

**M0–M4 are implemented and tested (178 tests, all green)** — plus the Agent
Memory layer (gate → extract → capture), hybrid retrieval, conflict
adjudication, and an MCP server.

**Benchmark**: LongMemEval-ORACLE (fixed 100-question subset,
deepseek-v4-flash as both extractor and judge) — **71.0%**, up from 38.0%
across three forensics-verified iterations. Full state:
[`HANDOFF-v2.md`](HANDOFF-v2.md) · forensics & roadmap:
[`docs/notes/`](docs/notes/).

See [`docs/`](docs/) for the specs:

- [`docs/shared-memory-m0-spec.md`](docs/shared-memory-m0-spec.md) — data model & state machine (frozen, M0)
- [`schema.json`](schema.json) — JSON Schema contract (kept in sync with `src/model/types.ts`)

### Implemented

- **Data model & storage** — open-world typed graph (nodes/edges/constraints),
  5 fact-node states + 4 constraint states, mandatory provenance, in-memory +
  SQLite (zero-dependency `node:sqlite`) backends.
- **Constraint engine** — whitelisted AST → `satisfied / violated /
  indeterminate / error`; hyperedge (N-ary) rules with Q01 human-approval
  governance.
- **Agent memory pipeline** — gate (worth storing?) → extract (structured
  entries with content-axis `saidBy` attribution: user facts are accepted,
  assistant conclusions enter `tentative` pending confirmation) → capture
  (dedup + conflict flagging, never silent overwrite).
- **Hybrid retrieval** — vector + lexical (F1-balanced, anti-attractor) + RRF
  + graph expansion; dimension-grouped context where the graph itself supplies
  entry counts; scope/date/state filters; bounded, cached for speed.
- **Conflict adjudication** — `resolve` (human), `autoresolve`
  (constraint-guided referee), `confirm` (promote assistant statements).
- **Surfaces** — CLI + MCP server (8 tools, works with Claude Code / Codex).
- **Evaluation harness** — seeded/reproducible LongMemEval runs, ingestion
  quality gate, shard merge with per-key reconciliation.

### Up next

- Extraction preservation (quantities/time anchors), `event_time` field,
  dimension alias merge — see
  [`docs/notes/optimization-roadmap.md`](docs/notes/optimization-roadmap.md)
- Full 500-question benchmark run

### Tests

- 178 unit + contract tests (`npm test`) — model, state machines, SQLite
  parity, pipeline, retrieval, ask layer, conflicts, MCP, config hub.

## Develop

```bash
npm install
npm test      # tsc + node --test (unit + contract tests)
npm run build # emit dist/
```

## License

[MIT](LICENSE) — Copyright (c) 2026 charles chen
