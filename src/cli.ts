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
import type { AddConstraintInput, AddEdgeInput, AddNodeInput } from "./model/store.js";
import type { ExpressionNode } from "./model/types.js";

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

function main(): void {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const pos = positionals(argv);
  const dbPath = flags.get("db") ?? "./edgelore.db";

  const [entity, action, target] = pos;
  if (!entity) throw new Error("missing command (node|edge|constraint|evaluate|get)");

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

      default:
        throw new Error(`unknown command: ${entity} (node|edge|constraint|evaluate|get)`);
    }
  } finally {
    g.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(JSON.stringify({ error: (err as Error).message }) + "\n");
  process.exit(1);
}
