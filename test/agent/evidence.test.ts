import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph } from "../../src/model/store.js";
import {
  archiveConversationEpisode,
  archiveConversationEvidence,
  conversationEvidenceText,
} from "../../src/agent/evidence.js";
import { SqliteGraph } from "../../src/store/sqlite.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("evidence: archives one cold Episode without creating graph nodes", () => {
  const graph = new MemoryGraph();
  const turns = [
    { role: "user", content: "My Honda is black." },
    { role: "assistant", content: "Noted." },
  ];
  const episode = archiveConversationEpisode(graph, turns, {
    created_by: "human:test",
    source_ref: "session:cold",
    createdAt: "2023-05-21",
  });
  assert.equal(episode.id, "session:cold");
  assert.deepEqual(episode.turns, turns);
  assert.equal(graph.queryNodes({}).length, 0);
  assert.equal(graph.getAllEpisodes().length, 1);
});

test("evidence: cold Episodes survive SQLite reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "edgelore-episode-")), "memory.db");
  const first = new SqliteGraph(path);
  archiveConversationEpisode(first, [{ role: "user", content: "Exact source" }], {
    created_by: "human:test",
    source_ref: "session:sqlite",
  });
  first.close();
  const reopened = new SqliteGraph(path);
  assert.equal(reopened.getEpisode("session:sqlite")?.turns[0]?.content, "Exact source");
  reopened.close();
});

test("evidence: archives exact turns in bounded overlapping message chunks", () => {
  const graph = new MemoryGraph();
  const payload = `The Plesiosaur has a blue scaly body. ${"detail ".repeat(180)}`;
  const nodes = archiveConversationEvidence(
    graph,
    [
      { role: "user", content: "Write a dinosaur book." },
      { role: "assistant", content: payload },
    ],
    {
      created_by: "human:test",
      source_ref: "session:1",
      createdAt: "2023-05-21",
    },
  );
  assert.ok(nodes.length >= 3);
  assert.equal(nodes[0]?.type, "core:message");
  assert.equal(nodes[0]?.state, "accepted");
  assert.deepEqual(nodes[0]?.source_refs, ["session:1"]);
  assert.match(nodes.map((node) => String(node.value)).join(" "), /blue scaly body/);
  assert.match(conversationEvidenceText(nodes[1]!), /assistant verbatim conversation evidence/);
});

test("evidence: replay is idempotent for one source and turn layout", () => {
  const graph = new MemoryGraph();
  const turns = [{ role: "assistant", content: "Use Mod Podge as the sealant." }];
  const ctx = { created_by: "human:test", source_ref: "session:2" };
  assert.equal(archiveConversationEvidence(graph, turns, ctx).length, 1);
  assert.equal(archiveConversationEvidence(graph, turns, ctx).length, 0);
  assert.equal(graph.queryNodes({ type: "core:message" }).length, 1);
});
