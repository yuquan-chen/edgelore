import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGraph } from "../../src/model/store.js";
import {
  archiveConversationEvidence,
  conversationEvidenceText,
} from "../../src/agent/evidence.js";

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
