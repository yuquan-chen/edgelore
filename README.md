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

**M0–M4 are implemented and tested** — plus the Agent
Memory layer (gate → extract → capture), hybrid retrieval, conflict
adjudication, and an MCP server.

**Best recorded benchmark**: LongMemEval-ORACLE v7 — **476/500 (95.2%)**.
The run uses a lossless Episode source log, Claim/Slot semantic indexing,
bounded graph expansion, and evidence recovery under a fixed context budget.
Its remaining failures are attributed in
[`docs/notes/failure-attribution-v7-episode-recovery-500-20260925.md`](docs/notes/failure-attribution-v7-episode-recovery-500-20260925.md).

See [`docs/`](docs/) for the specs:

- [`docs/shared-memory-m0-spec.md`](docs/shared-memory-m0-spec.md) — data model & state machine (frozen, M0)
- [`docs/shared-memory-m1-spec.md`](docs/shared-memory-m1-spec.md) — constraint expression engine
- [`docs/shared-memory-m2-spec.md`](docs/shared-memory-m2-spec.md) — SQLite persistence and CLI
- [`docs/shared-memory-m3-spec.md`](docs/shared-memory-m3-spec.md) — capture primitive
- [`docs/agent-memory-design.md`](docs/agent-memory-design.md) — Agent memory pipeline
- [`docs/notes/retrieval.md`](docs/notes/retrieval.md) — retrieval mechanics
- [`docs/notes/conflicts.md`](docs/notes/conflicts.md) — conflict lifecycle and adjudication
- [`docs/notes/host-runtime-collaboration.md`](docs/notes/host-runtime-collaboration.md) — host Agent integration boundary
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
- **Surfaces** — CLI + stdio MCP server (9 tools; usable from MCP clients such as
  Claude Code, Codex, Hermes, and OpenClaw).
- **Memory Explorer** — local, read-only browser UI for Slots, Entities,
  bounded neighborhoods, Claim provenance / Episode evidence, and conflicts.
- **Evaluation harness** — seeded/reproducible LongMemEval runs, ingestion
  quality gate, shard merge with per-key reconciliation.

### Up next

- Add host lifecycle adapters for automatic task-start recall and asynchronous
  task-end ingestion. MCP tools are currently called explicitly by the host
  Agent; configuring the server does not install lifecycle hooks.
- Continue bounded, evidence-backed improvements to ingestion, recall,
  conflict handling, and storage cost without benchmark-specific logic.

### Tests

- Unit + contract tests (`npm test`) — model, state machines, SQLite parity,
  pipeline, retrieval, ask layer, conflicts, MCP, config hub.

## Quick Start: Connect an Agent

EdgeLore exposes its memory operations as a local stdio MCP server. The host
starts the process and communicates with it over stdin/stdout; the SQLite file
is the shared, durable memory store. Node.js 22 or newer is required.

From a clone of this repository, build the MCP server:

```bash
npm install
npm run build
```

The MCP host launches the server as a child process using Node:

```bash
node /absolute/path/to/edgelore/dist/src/mcp/main.js \
  --db /absolute/path/to/edgelore-data/edgelore.db \
  --created-by human:your-name
```

Use absolute paths in the host configuration, and make sure the database's
parent directory already exists. Keep the database outside the source checkout
if you do not want memory data mixed with project files. EdgeLore creates the
SQLite file on startup if it does not exist. The stdio server stays running
until its MCP host closes the connection; it is not a one-shot terminal
command. `--created-by` is the required provenance identity for writes and
must use the `human:<id>` form.

### Configure model providers

Use [`.env.example`](.env.example) as the variable reference. For local CLI use,
copy it to `.env.local` in the process working directory and fill in the values;
`.env.local` is gitignored and must not be committed. For MCP, pass provider
variables through the host's per-server `env` configuration below: the host
may launch EdgeLore with a different working directory.

- Chat extraction (`memory_remember`) needs `OPENAI_API_KEY` and
  `EDGELORE_MODEL`. `OPENAI_BASE_URL` is optional and defaults to
  `https://api.openai.com/v1`. For another OpenAI-compatible provider, set its
  API base URL and the exact chat model ID accepted by that provider.
- Embeddings are optional. Set `EDGELORE_EMBEDDING_MODEL` and
  `EDGELORE_EMBEDDING_DIMENSIONS` to enable vector retrieval. The dimension
  must match the model output. `OPENAI_EMBEDDING_API_KEY` and
  `OPENAI_EMBEDDING_BASE_URL` can configure a separate provider; otherwise,
  embeddings fall back to the chat API key and base URL. Without embedding
  configuration, retrieval uses lexical search.
- The optional TypeSafe decision provider uses `TYPESAFE_API_KEY`;
  `TYPESAFE_BASE_URL` and `TYPESAFE_MODEL` default to
  `https://api.typesafe.ai` and `jev-latest`.

Use the host's local secret/environment store for real keys where possible;
never commit credentials.

### Hermes Agent

Merge this server entry into `~/.hermes/config.yaml` under `mcp_servers` (keep
any other existing configuration):

```yaml
mcp_servers:
  edgelore:
    command: "node"
    args:
      - "/absolute/path/to/edgelore/dist/src/mcp/main.js"
      - "--db"
      - "/absolute/path/to/edgelore-data/edgelore.db"
      - "--created-by"
      - "human:your-name"
    timeout: 60
    connect_timeout: 10
    # Optional: include only the providers you want to enable.
    env:
      OPENAI_API_KEY: "your-provider-api-key"
      OPENAI_BASE_URL: "https://api.openai.com/v1"
      EDGELORE_MODEL: "your-chat-model-id"
      # Optional vector retrieval; match dimensions to the model output.
      EDGELORE_EMBEDDING_MODEL: "your-embedding-model-id"
      EDGELORE_EMBEDDING_DIMENSIONS: "1024"
    tools:
      include: [memory_append_episode, memory_search, memory_remember]
```

Restart Hermes after saving the config. Check the connection with
`hermes mcp list` and `hermes mcp test edgelore`. In a chat, the tools appear
with names such as `mcp_edgelore_memory_append_episode` and
`mcp_edgelore_memory_search`.

### OpenClaw

Merge this entry into OpenClaw's active config under `mcp.servers` (the config
uses JSON5; preserve any existing entries):

```js
{
  mcp: {
    servers: {
      edgelore: {
        command: "node",
        args: [
          "/absolute/path/to/edgelore/dist/src/mcp/main.js",
          "--db",
          "/absolute/path/to/edgelore-data/edgelore.db",
          "--created-by",
          "human:your-name",
        ],
        requestTimeoutMs: 60000,
        connectionTimeoutMs: 10000,
        // Optional: include only the providers you want to enable.
        env: {
          OPENAI_API_KEY: "your-provider-api-key",
          OPENAI_BASE_URL: "https://api.openai.com/v1",
          EDGELORE_MODEL: "your-chat-model-id",
          // Optional vector retrieval; match dimensions to the model output.
          EDGELORE_EMBEDDING_MODEL: "your-embedding-model-id",
          EDGELORE_EMBEDDING_DIMENSIONS: "1024",
        },
        toolFilter: {
          include: ["memory_append_episode", "memory_search", "memory_remember"],
        },
      },
    },
  },
}
```

Check the saved server with `openclaw mcp status --verbose`, then actively
connect and list its tools with `openclaw mcp probe edgelore`. OpenClaw's MCP
registry makes the server available to configured OpenClaw runtimes; it does
not by itself enable automatic recall/capture at task boundaries.

### Verify the connection end to end

In either host, ask the Agent to:

1. Call `memory_append_episode` with this payload (replace the ID with a unique
   value if reusing the database):

   ```json
   {
     "id": "smoke-test-001",
     "turns": [{"role": "user", "content": "EdgeLore MCP smoke token: amber-kite-731."}],
     "scope": {"owner_id": "demo", "project_id": "smoke-test", "phase_id": "setup"}
   }
   ```

2. Call `memory_search` with query `amber-kite-731`, `mode: "lexical"`, and the
   same owner, project, and phase scope. Confirm that the returned evidence
   contains the token.

This verifies host discovery, tool invocation, SQLite persistence, and evidence
retrieval without calling a chat LLM; lexical mode also avoids the embedding
API. `memory_append_episode` stores an immutable source Episode only; it does
not extract Claims or start the ingestion pipeline. `memory_remember` runs
synchronous extraction and requires EdgeLore's LLM configuration. Automatic
session-start recall and background session-end ingestion require host
lifecycle adapters, which are not included yet.

Official host references: [Hermes MCP](https://github.com/hermes-agent-org/hermes/blob/main/website/docs/user-guide/features/mcp.md),
[OpenClaw MCP](https://docs.openclaw.ai/cli/mcp), and
[OpenClaw MCP config](https://docs.openclaw.ai/gateway/config-extensions).

## Develop

```bash
npm install
npm test      # tsc + node --test (unit + contract tests)
npm run build # emit dist/
```

Start the local read-only Memory Explorer against an existing database:

```bash
edgelore ui --db ./edgelore.db
# optional port override (default 4173)
edgelore ui --db ./edgelore.db --port 4180
```

The UI binds only to `127.0.0.1`, opens SQLite in read-only mode, and serves
bounded JSON endpoints and the page from the same process.

## License

[MIT](LICENSE) — Copyright (c) 2026 charles chen
