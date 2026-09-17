# edgelore

> A **shared memory graph** for AI agents — a long-term memory system built around a *graph + constraint self-checking* core.

edgelore stores an agent's memory as a **knowledge graph** (nodes / edges / constraints) and ships a built-in **declarative constraint engine**: you write rules as expressions (e.g. `budget ≤ 5000`, `SLA < 200ms`) and the system automatically checks whether the memory violates them. That is our biggest differentiator versus mainstream solutions like Mem0 / Zep — they all focus on "storing facts + retrieval" and almost none offer a "rule self-check" layer.

- **Local-first, zero-cloud**: persists with Node's built-in `node:sqlite`. One `.db` file is the entire memory store.
- **Structured storage primitive `capture`**: feed a structured JSON (dimension + value); the system auto-creates the dimension, de-duplicates, persists, and flags conflicts.
- **Phased roadmap**: M0 shape → M1 self-check → M2 persistence → M3 self-growth (capture). See [docs/HANDOFF.md](docs/HANDOFF.md) for the plan.

---

## Quick Start

> Requires **Node.js ≥ 22** (uses the built-in `node:sqlite`; no external database needed).

```bash
# 1. Get the code
git clone <your-repo-url> edgelore
cd edgelore

# 2. Install dependencies (dev-only: TypeScript etc.; runtime uses Node's built-in sqlite)
npm install

# 3. Compile TypeScript
npm run build

# 4. Run tests (46 cases; all green = pass)
npm test
```

Once built, store a memory from the command line:

```bash
# Store a memory: dimension "author" has value "charles"
# (auto-creates the dimension + stores as accepted)
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"author","value":"charles"}' \
  --created-by agent:demo:1

# Single-value dimension "owner": store alice, then bob → the 2nd is flagged as conflict
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"owner","value":"alice","cardinality":"single"}' \
  --created-by agent:demo:1
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"owner","value":"bob","cardinality":"single"}' \
  --created-by agent:demo:1

# See what's in the store
node dist/src/cli.js --db ./edgelore.db node list
```

`capture` returns a single-line JSON, e.g.:

```json
{"dimensionId":"node:core:dimension:...","statementId":"node:core:statement:...","created":true,"deduplicated":false,"conflict":false}
```

The third (single-value conflict) call returns `"conflict":true`, and automatically sets the dimension to `conflict` and the new statement to `tentative`.

---

## CLI

The CLI is **JSON in / JSON out**, designed for agent invocation (still human-readable). Default DB is `./edgelore.db`; override with `--db <path>`.

| Command | Description |
|---|---|
| `capture --content '<json>' --created-by <who>` | **Core**: store a memory (dimension + value); handles dedupe / conflict |
| `node add --type <t> --created-by <who> [--key ..] [--value ..]` | Manually add a node |
| `node list [--type <t>] [--state <s>]` | List nodes |
| `edge add --type <t> --from <id> --to <id> --created-by <who>` | Add an edge |
| `edge list` | List all edges |
| `constraint add --participants a,b --bindings '<json>' --created-by <who>` | Add a constraint rule |
| `constraint activate <id> --approved-by human:x` | Human-approve a constraint (Q01 gate) |
| `constraint list` | List constraints |
| `evaluate <constraint-id>` | Run constraint self-check, returns 4-state result |
| `get <id>` | Look up a node / edge / constraint by ID |

Full specs: [docs/shared-memory-m2-spec.md](docs/shared-memory-m2-spec.md) and [docs/shared-memory-m3-spec.md](docs/shared-memory-m3-spec.md).

---

## Project Structure

```
src/
  model/        # Type definitions + graph store (MemoryGraph, backend-agnostic)
  store/        # SqliteGraph: persistence via node:sqlite
  engine/       # Constraint expression evaluator (4 states: satisfied/violated/indeterminate/error)
  agent/        # capture storage primitive (M3) + future Agent Memory layer
  cli.ts        # Command-line bridge (agent entry point)
test/           # Tests (in-memory + SQLite backends)
docs/           # Milestone specs, notes, competitor analysis, design, handoff
```

---

## Development

```bash
npm run build      # Compile (tsc)
npm run typecheck  # Type-check only
npm test           # Compile + run tests
npm run lint       # ESLint
npm run format     # Prettier
```

---

## Docs

- [docs/HANDOFF.md](docs/HANDOFF.md) — read this first when taking over (goals, frozen boundaries, file map, git state)
- [docs/agent-memory-design.md](docs/agent-memory-design.md) — Agent Memory layer design (sentence → structured JSON)
- [docs/competitor-analysis.md](docs/competitor-analysis.md) — competitor survey (Mem0 / Zep / Letta / OMEGA)
- [docs/notes/agent-memory-write-policy.md](docs/notes/agent-memory-write-policy.md) — what is worth storing
- [docs/notes/agent-memory-paradigms.md](docs/notes/agent-memory-paradigms.md) — extraction insights from Claude Code / Codex

---

## License

MIT
