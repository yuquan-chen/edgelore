#!/usr/bin/env node
// edgelore · M4 — MCP server launcher (bin: edgelore-mcp).
//
// Usage: edgelore-mcp --db path.db --created-by human:you
// Reads .env.local (never overriding real env vars) for the LLM/embedding
// configuration; serves over stdio until the host closes the connection.

import { readFileSync } from "node:fs";
import { SqliteGraph } from "../store/sqlite.js";
import { startMcpServer } from "./server.js";
import { OpenAiCompatDriver } from "../agent/openai-compat-driver.js";
import { OpenAiCompatEmbeddingDriver } from "../agent/embedding-driver.js";
import { SqliteVectorStore } from "../agent/retrieval.js";

function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

loadDotEnv(".env.local");
const dbPath = flag("db") ?? "./edgelore.db";
const createdBy = flag("created-by") ?? "human:local";

const graph = new SqliteGraph(dbPath);
const chatDriver = process.env.EDGELORE_MODEL
  ? new OpenAiCompatDriver({
      baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL
        ? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
        : process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY as string,
      model: process.env.EDGELORE_MODEL,
    })
  : undefined;
const retrieval = process.env.EDGELORE_EMBEDDING_MODEL
  ? {
      embedder: OpenAiCompatEmbeddingDriver.fromEnv(process.env),
      vectors: new SqliteVectorStore(graph),
    }
  : undefined;

await startMcpServer(graph, { createdBy, chatDriver, retrieval });
