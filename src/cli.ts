#!/usr/bin/env node
// edgelore · M2 — Minimal CLI: the agent bridge.
//
// Design rules (docs/shared-memory-m2-spec.md §5):
//   JSON in, JSON out. Single-line results on stdout. Errors as
//   {"error": "..."} on stderr with exit code 1. No interactivity, no human
//   formatting — this surface is for agents, not people.
//
// Usage: edgelore [--db path.db] <command>  (see docs/shared-memory-m2-spec.md)

import { SqliteGraph } from "./store/sqlite.js";
import { capture, type CaptureContent, type CaptureContext } from "./agent/capture.js";
import { processTurn, type RetrievalConfig } from "./agent/runtime.js";
import { expandHit, retrieveRelevant, SqliteVectorStore, type RetrievalMode } from "./agent/retrieval.js";
import { autoResolveConstraintGuided, confirmStatement, listConflicts, resolveConflict } from "./agent/conflicts.js";
import { startMcpServer } from "./mcp/server.js";
import { answerQuestion } from "./agent/ask.js";
import { chatDriver, configFromEnv, decisionDriver, embeddingDriver, loadDotEnv, type EdgeloreConfig } from "./config.js";
import type { AddConstraintInput, AddEdgeInput, AddNodeInput } from "./model/store.js";
import type { DimensionNode, ExpressionNode, StatementNode } from "./model/types.js";

/** Parse `--key value` pairs (value-less flags become "true"). */
function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
    } else {
      flags.set(key, next);
      i++;
    }
  }
  return flags;
}

/** Non-flag tokens, in order. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Build retrieval plumbing from the resolved config when an embedding model
 * is configured; undefined otherwise (processTurn then degrades to "latest
 * 50"). CLI flags win over config for per-invocation tuning.
 */
function retrievalFromConfig(
  g: SqliteGraph,
  cfg: EdgeloreConfig,
  flags: Map<string, string>,
): RetrievalConfig | undefined {
  if (!cfg.embedding) return undefined;
  return {
    embedder: embeddingDriver(cfg),
    vectors: new SqliteVectorStore(g),
    mode: flags.has("mode") ? (flags.get("mode") as RetrievalMode) : cfg.retrieval.mode,
    rrfSmoothing: cfg.retrieval.rrfSmoothing,
    maxEntriesPerDimension: cfg.retrieval.maxEntriesPerDimension,
    maxContextLines: cfg.retrieval.maxContextLines,
  };
}

/** Require a flag, or throw with a usage-style message. */
function req(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (v === undefined) throw new Error(`missing required flag --${name}`);
  return v;
}

/** Parse a flag as JSON; when `fallbackToString`, a non-JSON value is kept as-is. */
function parseJson(raw: string, fallbackToString: boolean): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (fallbackToString) return raw;
    throw new Error(`invalid JSON: ${raw} (${(err as Error).message})`);
  }
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const pos = positionals(argv);
  const dbPath = flags.get("db") ?? "./edgelore.db";

  // One env load + config resolution for the whole process; local-only
  // commands never touch cfg.llm/cfg.embedding, so they work with no .env.
  loadDotEnv(".env.local");
  const cfg = configFromEnv();

  const [entity, action, target] = pos;
  if (!entity) {
    throw new Error(
      "missing command (node|edge|constraint|evaluate|get|capture|remember|search|ask|conflicts|resolve|autoresolve|confirm|digest|mcp)",
    );
  }

  const g = new SqliteGraph(dbPath);
  try {
    switch (entity) {
      case "node": {
        if (action === "add") {
          const input: AddNodeInput = {
            type: req(flags, "type"),
            created_by: req(flags, "created-by"),
          };
          if (flags.has("key")) input.key = flags.get("key");
          if (flags.has("dimension-id")) input.dimension_id = flags.get("dimension-id");
          if (flags.has("value")) input.value = parseJson(req(flags, "value"), true);
          if (flags.has("unit")) input.unit = flags.get("unit");
          if (flags.has("state")) input.state = flags.get("state") as AddNodeInput["state"];
          if (flags.has("attributes"))
            input.attributes = parseJson(req(flags, "attributes"), false) as Record<
              string,
              unknown
            >;
          if (flags.has("tags")) input.tags = req(flags, "tags").split(",");
          emit(g.addNode(input));
        } else if (action === "list") {
          emit(
            g.queryNodes({
              type: flags.get("type"),
              state: flags.get("state") as AddNodeInput["state"],
            }),
          );
        } else {
          throw new Error(`unknown node action: ${action ?? "(none)"} (add|list)`);
        }
        break;
      }

      case "edge": {
        if (action === "add") {
          const input: AddEdgeInput = {
            type: req(flags, "type"),
            from: req(flags, "from"),
            to: req(flags, "to"),
            created_by: req(flags, "created-by"),
          };
          emit(g.addEdge(input));
        } else if (action === "list") {
          emit(g.getAllEdges());
        } else {
          throw new Error(`unknown edge action: ${action ?? "(none)"} (add|list)`);
        }
        break;
      }

      case "constraint": {
        if (action === "add") {
          const input: AddConstraintInput = {
            participants: req(flags, "participants").split(","),
            bindings: parseJson(req(flags, "bindings"), false) as Record<string, string>,
            created_by: req(flags, "created-by"),
          };
          if (flags.has("name")) input.name = flags.get("name");
          if (flags.has("expression"))
            input.expression = parseJson(req(flags, "expression"), false) as ExpressionNode;
          emit(g.addConstraint(input));
        } else if (action === "activate") {
          if (!target) throw new Error("usage: constraint activate <id> --approved-by human:x");
          emit(
            g.transitionConstraintState(target, "active", {
              approved_by: req(flags, "approved-by"),
            }),
          );
        } else if (action === "list") {
          emit(g.getAllConstraints());
        } else {
          throw new Error(`unknown constraint action: ${action ?? "(none)"} (add|activate|list)`);
        }
        break;
      }

      case "evaluate": {
        if (!action) throw new Error("usage: evaluate <constraint-id>");
        emit({ id: action, result: g.evaluateConstraint(action) });
        break;
      }

      case "get": {
        if (!action) throw new Error("usage: get <id>");
        const found = g.getNode(action) ?? g.getEdge(action) ?? g.getConstraint(action);
        if (!found) throw new Error(`not found: ${action}`);
        emit(found);
        break;
      }

      case "capture": {
        // The storage-layer entry point: Agent Memory already produced the
        // structured JSON (CaptureContent); the runtime supplies provenance.
        const content = parseJson(req(flags, "content"), false) as CaptureContent;
        if (typeof content?.dimensionKey !== "string" || !("value" in content)) {
          throw new Error("capture requires --content with {dimensionKey, value}");
        }
        const context: CaptureContext = {
          created_by: req(flags, "created-by"),
          source_refs: flags.has("source-refs")
            ? (parseJson(req(flags, "source-refs"), false) as string[])
            : [],
        };
        emit(capture(g, content, context));
        break;
      }

      case "remember": {
        // The full memory pipeline entry point: human language in, graph
        // mutations out. provenance comes from --created-by (runtime-read,
        // never LLM-authored); the LLM key/model come from env / .env.local.
        const text = pos
          .slice(1)
          .join(" ")
          .trim();
        if (!text) {
          throw new Error(
            'usage: remember "text" --created-by human:x [--model m] [--base-url u] [--api-key k]',
          );
        }
        const driver = chatDriver(cfg, {
          ...(flags.has("api-key") ? { apiKey: flags.get("api-key") } : {}),
          ...(flags.has("base-url") ? { baseUrl: flags.get("base-url") } : {}),
          ...(flags.has("model") ? { model: flags.get("model") } : {}),
        });
        const context: CaptureContext = {
          created_by: req(flags, "created-by"),
          source_refs: flags.has("source-refs")
            ? (parseJson(req(flags, "source-refs"), false) as string[])
            : [],
        };
        const retrieval = retrievalFromConfig(g, cfg, flags);
        emit(await processTurn(g, text, driver, context, retrieval ? { retrieval } : undefined));
        break;
      }

      case "search": {
        // Retrieval debugger: shows what the extractor would see as context,
        // with graph expansion (conflict counterparts + constraint verdicts).
        const query = pos
          .slice(1)
          .join(" ")
          .trim();
        if (!query) {
          throw new Error('usage: search "query" [--k n] [--mode hybrid|vector|lexical]');
        }
        const embedder = embeddingDriver(cfg);
        const mode = flags.has("mode") ? (flags.get("mode") as RetrievalMode) : undefined;
        const k = flags.has("k") ? Number(flags.get("k")) : undefined;
        const hits = await retrieveRelevant(g, {
          query,
          embedder,
          vectors: new SqliteVectorStore(g),
          mode,
          k,
        });
        emit({ hits: hits.map((h) => ({ ...h, expansion: expandHit(g, h) })) });
        break;
      }

      case "conflicts": {
        // The docket: every conflicted dimension with its facing statements.
        emit(listConflicts(g));
        break;
      }

      case "resolve": {
        // Human adjudication: winner accepted, losers superseded (audit via
        // core:supersedes edges attributed to the human resolver).
        if (!action || !target) {
          throw new Error("usage: resolve <dimension-id> <winner-statement-id> --by human:x [--note t]");
        }
        emit(
          resolveConflict(g, action, target, {
            resolvedBy: req(flags, "by"),
            note: flags.get("note"),
          }),
        );
        break;
      }

      case "autoresolve": {
        // Constraint-guided auto resolution: the M1 engine referees. Only
        // fires when a rule unambiguously separates the candidates; else it
        // escalates (status: "escalated") and the conflict stays pending.
        if (!action) throw new Error("usage: autoresolve <dimension-id>");
        emit(autoResolveConstraintGuided(g, action));
        break;
      }

      case "confirm": {
        // Human confirmation of a tentative statement (typically an
        // assistant-authored fact awaiting the user's nod — W2 trust
        // policy). Distinct from resolve: no conflict, nothing superseded.
        if (!action) {
          throw new Error("usage: confirm <statement-id> --by human:x [--note t]");
        }
        emit(
          confirmStatement(g, action, {
            confirmedBy: req(flags, "by"),
            note: flags.get("note"),
          }),
        );
        break;
      }

      case "ask": {
        // The answering layer: grounded in retrieved memories, abstains when
        // they are insufficient (never invents from outside knowledge).
        const question = pos
          .slice(1)
          .join(" ")
          .trim();
        if (!question) throw new Error('usage: ask "question" [--db path] [--k n] [--today YYYY-MM-DD]');
        const driver = chatDriver(cfg);
        const retrieval = retrievalFromConfig(g, cfg, flags);
        emit(
          await answerQuestion(g, question, driver, {
            retrieval,
            k: flags.has("k") ? Number(flags.get("k")) : undefined,
            now: flags.get("today"),
            decision: cfg.decision ? decisionDriver(cfg) : undefined,
          }),
        );
        break;
      }

      case "digest": {
        // Channel B (progressive disclosure): a compact markdown summary of
        // accepted memories, active rules, and pending conflicts — meant to
        // be imported from CLAUDE.md / AGENTS.md via `@file`. Raw markdown
        // output (documented exception to the JSON-only convention).
        const lines: string[] = ["# edgelore memory digest", ""];
        const dims = g.queryNodes({ type: "core:dimension" }) as DimensionNode[];
        const stmts = g.queryNodes({ type: "core:statement" }) as StatementNode[];
        for (const d of dims) {
          const mine = stmts.filter((s) => s.dimension_id === d.id);
          const accepted = mine.filter((s) => s.state === "accepted");
          const flagged = mine.filter((s) => s.state !== "accepted");
          const desc = typeof d.attributes?.description === "string" ? d.attributes.description : d.key;
          if (accepted.length > 0) {
            const vals = accepted
              .map((s) => `${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""}`)
              .join("; ");
            lines.push(`- **${d.key}**（${desc}）: ${vals}`);
          }
          const pendingJ = flagged.filter((s) => s.state === "tentative" || s.state === "conflict");
          const retired = flagged.filter((s) => s.state === "superseded" || s.state === "rejected");
          if (pendingJ.length > 0) {
            lines.push(
              `  - ⚠ 待裁决: ${pendingJ
                .map((s) => `${JSON.stringify(s.value)}[${s.state}]${s.saidBy === "assistant" ? "(assistant，待确认)" : ""}`)
                .join(", ")}`,
            );
          }
          if (retired.length > 0) {
            lines.push(
              `  - 📜 历史: ${retired.map((s) => `${JSON.stringify(s.value)}[${s.state}]`).join(", ")}`,
            );
          }
        }
        for (const c of g.getAllConstraints()) {
          if (c.activation_state === "active") {
            lines.push(`- 规则 **${c.name ?? c.id}**: ${g.evaluateConstraint(c.id)}`);
          }
        }
        const pending = listConflicts(g);
        if (pending.length > 0) {
          lines.push(`- ⚠ ${pending.length} 个维度存在待裁决冲突（edgelore conflicts 查看）`);
        }
        process.stdout.write(lines.join("\n") + "\n");
        break;
      }

      case "mcp": {
        // Channel A infra: stdio MCP server (Claude Code / Codex / any MCP host).
        await startMcpServer(g, {
          createdBy: flags.get("created-by") ?? "human:local",
          chatDriver: cfg.llm ? chatDriver(cfg) : undefined, // memory_remember reports the missing config when called
          retrieval: retrievalFromConfig(g, cfg, flags),
        });
        break;
      }

      default:
        throw new Error(
          `unknown command: ${entity} (node|edge|constraint|evaluate|get|capture|remember|search|ask|conflicts|resolve|autoresolve|confirm|digest|mcp)`,
        );
    }
  } finally {
    g.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify({ error: (err as Error).message }) + "\n");
  process.exit(1);
});
