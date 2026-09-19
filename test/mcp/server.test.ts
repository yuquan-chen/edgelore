// edgelore · M4 — MCP server tests.
//
// Real protocol round-trips over the SDK's InMemoryTransport (no stdio, no
// network): tool discovery, the remember pipeline through MCP, search with
// expansion, capture/get, the conflict docket + resolution, and constraint
// evaluation errors. MockDriver/MockEmbedder keep it offline and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraph } from "../../src/store/sqlite.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { MockDriver } from "../../src/agent/llm-driver.js";
import { MockEmbedder } from "../../src/agent/embedding-driver.js";
import { InMemoryVectorStore } from "../../src/agent/retrieval.js";
import type { RetrievalConfig } from "../../src/agent/runtime.js";

/** Harness: open a temp SQLite graph, build the server, connect an MCP client. */
async function harness(chatReplies?: string[]): Promise<{
  client: Client;
  graph: SqliteGraph;
  vectors: InMemoryVectorStore;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "edgelore-mcp-"));
  const graph = new SqliteGraph(join(dir, "t.db"));
  const vectors = new InMemoryVectorStore();
  const opts = {
    createdBy: "human:test",
    chatDriver: new MockDriver(chatReplies ?? []),
    retrieval: { embedder: new MockEmbedder(8), vectors } as RetrievalConfig,
  };
  const server = buildMcpServer(graph, opts);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    graph,
    vectors,
    cleanup: () => {
      client.close();
      graph.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("mcp: all eight tools are discoverable", async () => {
  const h = await harness();
  try {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memory_autoresolve",
      "memory_capture",
      "memory_conflicts",
      "memory_evaluate",
      "memory_get",
      "memory_remember",
      "memory_resolve",
      "memory_search",
    ]);
  } finally {
    h.cleanup();
  }
});

test("mcp: memory_remember runs the pipeline and indexes vectors", async () => {
  const h = await harness([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({
      contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }],
    }),
  ]);
  try {
    const r = await h.client.callTool({
      name: "memory_remember",
      arguments: { text: "项目预算 5000 元" },
    });
    assert.equal(r.isError, undefined);
    const payload = r.structuredContent as { captures: Array<{ created: boolean }>; indexed: number };
    assert.equal(payload.captures.length, 1);
    assert.equal(payload.indexed, 1); // embedded through the injected plumbing
    assert.equal(h.vectors.all().length, 2); // statement + dimension
  } finally {
    h.cleanup();
  }
});

test("mcp: memory_search returns hits with graph expansion", async () => {
  const h = await harness([
    JSON.stringify({ store: true, candidates: ["预算 5000"] }),
    JSON.stringify({
      contents: [{ dimensionKey: "NEW:budget", value: 5000, cardinality: "single", unit: "CNY" }],
    }),
  ]);
  try {
    await h.client.callTool({ name: "memory_remember", arguments: { text: "项目预算 5000 元" } });
    const r = await h.client.callTool({ name: "memory_search", arguments: { query: "预算 5000" } });
    const payload = r.structuredContent as { hits: Array<{ dimensionKey: string; expansion: unknown }> };
    assert.equal(payload.hits[0]?.dimensionKey, "budget");
    assert.ok(payload.hits[0]?.expansion);
  } finally {
    h.cleanup();
  }
});

test("mcp: capture then get roundtrips through the protocol", async () => {
  const h = await harness();
  try {
    const r = await h.client.callTool({
      name: "memory_capture",
      arguments: {
        content: { dimensionKey: "NEW:author", value: "charles", description: "项目负责人" },
      },
    });
    const captured = r.structuredContent as { statementId: string };
    const got = await h.client.callTool({ name: "memory_get", arguments: { id: captured.statementId } });
    const node = got.structuredContent as { value: unknown };
    assert.equal(node.value, "charles");
  } finally {
    h.cleanup();
  }
});

test("mcp: conflict docket and resolution work end to end", async () => {
  const h = await harness();
  try {
    // 5000 accepted, then 8000 clashes -> tentative + dimension conflict.
    await h.client.callTool({
      name: "memory_capture",
      arguments: { content: { dimensionKey: "NEW:budget", value: 5000, cardinality: "single" } },
    });
    await h.client.callTool({
      name: "memory_capture",
      arguments: { content: { dimensionKey: "NEW:budget", value: 8000 } },
    });
    const docket = await h.client.callTool({ name: "memory_conflicts", arguments: {} });
    const cases = (docket.structuredContent as { cases: Array<{ dimensionId: string; challengers: unknown[] }> })
      .cases;
    assert.equal(cases.length, 1);
    const dimensionId = cases[0]!.dimensionId;
    const winnerId = (cases[0]!.challengers[0] as { statementId: string }).statementId;

    const resolved = await h.client.callTool({
      name: "memory_resolve",
      arguments: { dimensionId, winnerStatementId: winnerId, note: "以最新为准" },
    });
    const result = resolved.structuredContent as { winnerId: string; supersededIds: string[] };
    assert.equal(result.winnerId, winnerId);
    assert.equal(result.supersededIds.length, 1);
    const dim = h.graph.getNode(dimensionId) as { state: string };
    assert.equal(dim.state, "accepted");
  } finally {
    h.cleanup();
  }
});

test("mcp: memory_evaluate reports unknown constraints as tool errors", async () => {
  const h = await harness();
  try {
    const r = await h.client.callTool({
      name: "memory_evaluate",
      arguments: { constraintId: "constraint:missing" },
    });
    assert.equal(r.isError, true); // unknown id -> loud tool error, not a crash
  } finally {
    h.cleanup();
  }
});
