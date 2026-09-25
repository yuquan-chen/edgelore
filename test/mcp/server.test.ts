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
import { capture } from "../../src/agent/capture.js";
import { archiveConversationEpisode } from "../../src/agent/evidence.js";
import type { RetrievalConfig } from "../../src/agent/runtime.js";

/** Harness: open a temp SQLite graph, build the server, connect an MCP client. */
async function harness(chatReplies?: string[]): Promise<{
  client: Client;
  graph: SqliteGraph;
  vectors: InMemoryVectorStore;
  chat: MockDriver;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "edgelore-mcp-"));
  const graph = new SqliteGraph(join(dir, "t.db"));
  const vectors = new InMemoryVectorStore();
  const chat = new MockDriver(chatReplies ?? []);
  const opts = {
    createdBy: "human:test",
    chatDriver: chat,
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
    chat,
    cleanup: () => {
      client.close();
      graph.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("mcp: all nine tools are discoverable", async () => {
  const h = await harness();
  try {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memory_append_episode",
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

test("mcp: memory_append_episode stores an immutable scoped source", async () => {
  const h = await harness();
  try {
    const response = await h.client.callTool({
      name: "memory_append_episode",
      arguments: {
        id: "conversation:scoped",
        turns: [{ role: "user", content: "We decided to use the local SQLite store." }],
        scope: { owner_id: "charles", project_id: "edgelore", phase_id: "adapter" },
      },
    });
    assert.equal(response.isError, undefined);
    const episode = h.graph.getEpisode("conversation:scoped");
    assert.deepEqual(episode?.scope, {
      owner_id: "charles",
      project_id: "edgelore",
      phase_id: "adapter",
    });
    assert.equal(h.graph.queryNodes({ type: "core:message" }).length, 0);
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

test("mcp: memory_search returns a Memory Capsule with evidence and makes no chat LLM call", async () => {
  const h = await harness(["unused sentinel reply"]);
  try {
    archiveConversationEpisode(
      h.graph,
      [{ role: "user", content: "My vehicle is a Ford F-150 pickup truck." }],
      {
        created_by: "human:test",
        source_ref: "session:vehicle",
        createdAt: "2026-09-24T10:00:00.000Z",
        scope: { owner_id: "charles", project_id: "edgelore", phase_id: "host-integration" },
      },
    );
    capture(
      h.graph,
      { dimensionKey: "vehicle", value: "Ford F-150 pickup truck", saidBy: "user" },
      {
        created_by: "human:test",
        source_refs: ["session:vehicle"],
        scope: { owner_id: "charles", project_id: "edgelore", phase_id: "host-integration" },
      },
    );
    const r = await h.client.callTool({
      name: "memory_search",
      arguments: {
        query: "what is my vehicle",
        mode: "lexical",
        scope: {
          owner_id: "charles",
          project_id: "edgelore",
          phase_id: "host-integration",
          sessionIds: ["session:vehicle"],
        },
      },
    });
    const payload = r.structuredContent as {
      query: string;
      scope: { owner_id: string; project_id: string; phase_id: string; sessionIds: string[] };
      claims: Array<{ value: unknown; saidBy: string; state: string; sourceRefs: string[] }>;
      slots: Array<{ label: string; state: string; conflict: boolean; visibleClaimIds: string[] }>;
      evidence: Array<{ sourceId: string; role: string; text: string; outOfScope: boolean }>;
      context: string[];
    };
    assert.equal(r.isError, undefined);
    assert.equal(payload.query, "what is my vehicle");
    assert.deepEqual(payload.scope.sessionIds, ["session:vehicle"]);
    assert.equal(payload.scope.owner_id, "charles");
    assert.equal(payload.claims[0]?.value, "Ford F-150 pickup truck");
    assert.equal(payload.claims[0]?.saidBy, "user");
    assert.equal(payload.claims[0]?.state, "accepted");
    assert.deepEqual(payload.claims[0]?.sourceRefs, ["session:vehicle"]);
    assert.equal(payload.slots[0]?.label, "vehicle");
    assert.equal(payload.slots[0]?.state, "tentative");
    assert.equal(payload.slots[0]?.conflict, false);
    assert.ok(payload.slots[0]?.visibleClaimIds.length);
    assert.equal(payload.evidence[0]?.sourceId, "session:vehicle");
    assert.equal(payload.evidence[0]?.role, "user");
    assert.match(payload.evidence[0]?.text ?? "", /Ford F-150/);
    assert.equal(payload.evidence[0]?.outOfScope, false);
    assert.ok(payload.context.some((line) => line.includes("Ford F-150")));
    assert.equal(h.chat.remaining, 1, "recall/search must not consume a chat-model reply");
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
