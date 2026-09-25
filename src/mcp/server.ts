// edgelore · M4 — MCP server: the standard-protocol mouth of the memory system.
//
// Exposes the full capability chain as nine MCP tools so any MCP host
// (Claude Code, Codex, Cursor, ...) can use persistent memory out of the box:
//
//   memory_remember     full pipeline: gate -> extract -> capture (+ embed)
//   memory_append_episode immutable cold-source append
//   memory_search       hybrid retrieval with graph expansion
//   memory_conflicts    the docket
//   memory_resolve      human adjudication (resolvedBy = server identity)
//   memory_autoresolve  constraint-guided auto resolution
//   memory_capture      raw storage write (for agents doing their own extraction)
//   memory_get          read one node/edge/constraint
//   memory_evaluate     the M1 engine's four-state verdict on a constraint
//
// Identity: the server runs with a single configured identity (--created-by
// human:<id>) — the Mem0-validated "server default user" pattern. Multi-user
// per-call overrides arrive with scope support (M3 deferred decision).
//
// Launch: edgelore mcp --db path.db --created-by human:you

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { SqliteGraph } from "../store/sqlite.js";
import type { LlmDriver } from "../agent/llm-driver.js";
import { processTurn, type RetrievalConfig } from "../agent/runtime.js";
import { recall } from "../agent/recall.js";
import { appendEpisode, type EvidenceTurn } from "../agent/evidence.js";
import { capture, type CaptureContent } from "../agent/capture.js";
import { autoResolveConstraintGuided, listConflicts, resolveConflict } from "../agent/conflicts.js";

/** Dependencies the server needs; injectable for tests. */
export interface McpServerOptions {
  /** Server identity for provenance on every write — MUST be human:<id>. */
  createdBy: string;
  /** Chat driver for the remember pipeline. Omit -> memory_remember reports
   * the missing env config instead of throwing at startup. */
  chatDriver?: LlmDriver;
  /** Embedding plumbing; omit -> context falls back to "latest 50". */
  retrieval?: RetrievalConfig;
}

/** Payload -> MCP tool result (text preview + structured JSON). */
function toolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: (err as Error).message }],
    isError: true,
  };
}

/**
 * Build the MCP server around an open graph.
 *
 * @param graph an open SqliteGraph (the server's backing store)
 * @param opts identity and optional LLM/embedding plumbing
 * @returns the McpServer (connect it to a transport to serve)
 */
export function buildMcpServer(graph: SqliteGraph, opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: "edgelore", version: "0.1.0" });
  const ctx = { created_by: opts.createdBy, source_refs: [] as string[] };

  server.registerTool(
    "memory_remember",
    {
      title: "Remember (full pipeline)",
      description:
        "Store a lasting memory from natural language. Runs the gate (worth storing?) " +
        "and extract (map to dimensions) pipeline, then persists. Use for decisions, " +
        "preferences, constraints, facts, lessons. Do NOT use for small talk.",
      inputSchema: {
        text: z.string().min(1),
        sourceRef: z.string().min(1).optional(),
        scope: z.object({
          owner_id: z.string().min(1).optional(),
          project_id: z.string().min(1).optional(),
          phase_id: z.string().min(1).optional(),
        }).optional(),
      },
    },
    async ({ text, sourceRef, scope }) => {
      try {
        if (!opts.chatDriver) {
          return errorResult(
            new Error(
              "chat model not configured: set OPENAI_API_KEY / OPENAI_BASE_URL / EDGELORE_MODEL",
            ),
          );
        }
        const payload = await processTurn(
          graph,
          text,
          opts.chatDriver,
          { ...ctx, ...(sourceRef ? { source_refs: [sourceRef] } : {}), ...(scope ? { scope } : {}) },
          opts.retrieval
            ? {
                retrieval: {
                  ...opts.retrieval,
                  ...(scope ? { scope } : {}),
                  ...(sourceRef ? { scopeSessionIds: [sourceRef] } : {}),
                },
              }
            : undefined,
        );
        return toolResult(payload);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "Recall a bounded Memory Capsule using the full graph and Episode evidence path. " +
        "Returns Claims, Slot state/conflicts, provenance, and relevant verbatim evidence. " +
        "Does not generate an answer; use this context in your own reasoning.",
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().positive().optional(),
        mode: z.enum(["hybrid", "vector", "lexical"]).optional(),
        scope: z.object({
          owner_id: z.string().min(1).optional(),
          project_id: z.string().min(1).optional(),
          phase_id: z.string().min(1).optional(),
          sessionIds: z.array(z.string().min(1)).optional(),
        }).optional(),
      },
    },
    async ({ query, k, mode, scope }) => {
      try {
        const capsule = await recall(graph, query, {
          ...(scope ? { scope } : {}),
          retrieval: {
            ...opts.retrieval,
            ...(k ? { k } : {}),
            ...(mode ? { mode } : {}),
          },
        });
        return toolResult(capsule);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_append_episode",
    {
      title: "Append source Episode",
      description:
        "Persist an immutable conversation/source Episode as cold evidence, without creating " +
        "message nodes or extracting claims. Repeating the same id and turns is idempotent; " +
        "the same id with different turns is rejected. Always provide owner/project/phase scope " +
        "when the source belongs to a scoped memory space.",
      inputSchema: {
        id: z.string().min(1),
        turns: z.array(z.object({ role: z.string().min(1), content: z.string() })).min(1),
        createdAt: z.string().datetime().optional(),
        scope: z.object({
          owner_id: z.string().min(1).optional(),
          project_id: z.string().min(1).optional(),
          phase_id: z.string().min(1).optional(),
        }).optional(),
      },
    },
    async ({ id, turns, createdAt, scope }) => {
      try {
        return toolResult(appendEpisode(graph, {
          id,
          turns: turns as EvidenceTurn[],
          createdBy: opts.createdBy,
          ...(createdAt ? { createdAt } : {}),
          ...(scope ? { scope } : {}),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_conflicts",
    {
      title: "List conflict docket",
      description:
        "List every conflicted dimension: the accepted incumbent vs tentative challengers, " +
        "with authorship and timestamps. Check this before relying on a fact.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({ cases: listConflicts(graph) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_resolve",
    {
      title: "Resolve a conflict",
      description:
        "Human adjudication: the winning statement becomes accepted, others are superseded " +
        "(history preserved). Resolved as the server identity (must be human:<id>).",
      inputSchema: {
        dimensionId: z.string().min(1),
        winnerStatementId: z.string().min(1),
        note: z.string().optional(),
      },
    },
    async ({ dimensionId, winnerStatementId, note }) => {
      try {
        return toolResult(
          resolveConflict(graph, dimensionId, winnerStatementId, {
            resolvedBy: opts.createdBy,
            note,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_autoresolve",
    {
      title: "Constraint-guided auto resolution",
      description:
        "Let active rules referee a conflicted dimension. Resolves only when a rule " +
        "unambiguously separates the candidates; otherwise escalates.",
      inputSchema: { dimensionId: z.string().min(1) },
    },
    async ({ dimensionId }) => {
      try {
        return toolResult(autoResolveConstraintGuided(graph, dimensionId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_capture",
    {
      title: "Capture structured content",
      description:
        "Raw storage write for agents that did their own extraction: provide dimensionKey " +
        "(NEW:camelCase creates a dimension) and value; dedup and conflict flagging are automatic.",
      inputSchema: {
        content: z.object({
          dimensionKey: z.string().min(1),
          value: z.unknown(),
          cardinality: z.enum(["single", "multi"]).optional(),
          unit: z.string().optional(),
          description: z.string().optional(),
        }),
        sourceRef: z.string().min(1).optional(),
        scope: z.object({
          owner_id: z.string().min(1).optional(),
          project_id: z.string().min(1).optional(),
          phase_id: z.string().min(1).optional(),
        }).optional(),
      },
    },
    async ({ content, sourceRef, scope }) => {
      try {
        return toolResult(capture(graph, content as CaptureContent, {
          ...ctx,
          ...(sourceRef ? { source_refs: [sourceRef] } : {}),
          ...(scope ? { scope } : {}),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get an object",
      description: "Read one node / edge / constraint by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const found = graph.getNode(id) ?? graph.getEdge(id) ?? graph.getConstraint(id);
        if (!found) return errorResult(new Error(`not found: ${id}`));
        return toolResult(found);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "memory_evaluate",
    {
      title: "Evaluate a constraint",
      description:
        "Run the rule engine on a constraint: satisfied / violated / indeterminate (missing " +
        "data) / error (malformed rule).",
      inputSchema: { constraintId: z.string().min(1) },
    },
    async ({ constraintId }) => {
      try {
        return toolResult({ id: constraintId, result: graph.evaluateConstraint(constraintId) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Serve over stdio (the standard local MCP transport) until the host closes.
 *
 * @param graph an open SqliteGraph
 * @param opts identity and optional LLM/embedding plumbing
 * @throws Error if createdBy is not human:<id>
 */
export async function startMcpServer(graph: SqliteGraph, opts: McpServerOptions): Promise<void> {
  if (!opts.createdBy.startsWith("human:")) {
    throw new Error("MCP server identity must be human:<id> (pass --created-by human:you)");
  }
  const server = buildMcpServer(graph, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resolve when the host closes the connection so the process can exit
  // cleanly (and the caller can close the database).
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
