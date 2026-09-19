#!/usr/bin/env node
// edgelore · M4 — MCP server launcher (bin: edgelore-mcp).
//
// Usage: edgelore-mcp --db path.db --created-by human:you
// Reads .env.local (never overriding real env vars) via the shared config
// hub; serves over stdio until the host closes the connection.

import { SqliteGraph } from "../store/sqlite.js";
import { startMcpServer } from "./server.js";
import { SqliteVectorStore } from "../agent/retrieval.js";
import { chatDriver, configFromEnv, embeddingDriver, loadDotEnv } from "../config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

loadDotEnv(".env.local");
const cfg = configFromEnv();
const dbPath = flag("db") ?? "./edgelore.db";
const createdBy = flag("created-by") ?? "human:local";

const graph = new SqliteGraph(dbPath);
const chat = cfg.llm ? chatDriver(cfg) : undefined; // memory_remember reports the missing config when called
const retrieval = cfg.embedding
  ? { embedder: embeddingDriver(cfg), vectors: new SqliteVectorStore(graph) }
  : undefined;

await startMcpServer(graph, { createdBy, chatDriver: chat, retrieval });
