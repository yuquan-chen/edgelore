// edgelore · Real-session smoke for governed RelationAssertions.
//
// Reuses already extracted facts from the isolated graph smoke database, then
// reruns only graph enrichment with the original LongMemEval transcript. The
// destination is an in-memory graph, so benchmark databases are never changed.
//
// Usage:
//   node benchmark/longmemeval/relation-assertion-smoke.mjs [--sid session-id]


import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryGraph,
  SqliteGraph,
  commitGraphWritePlan,
  runGraphEnrichment,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const args = process.argv.slice(2);
const sidIndex = args.indexOf("--sid");
const sessionId = sidIndex === -1 ? "answer_4be1b6b4_3" : args[sidIndex + 1];
if (!sessionId) throw new Error("--sid requires a session id");

const dataset = JSON.parse(
  readFileSync(join(dataDir, "longmemeval_oracle.json"), "utf8"),
);
let session;
for (const question of dataset) {
  const index = question.haystack_session_ids.indexOf(sessionId);
  if (index === -1) continue;
  session = {
    date: (question.haystack_dates[index] ?? "").slice(0, 10).replace(/\//g, "-"),
    turns: question.haystack_sessions[index] ?? [],
  };
  break;
}
if (!session) throw new Error(`LongMemEval session not found: ${sessionId}`);

const source = new SqliteGraph(join(dataDir, "memory-graph-smoke.db"));
const sourceStatements = source
  .queryNodes({ type: "core:statement" })
  .filter((statement) => statement.source_refs.includes(sessionId));
const contents = sourceStatements.map((statement) => {
  const dimension = source.getNode(statement.dimension_id);
  return {
    dimensionKey: dimension?.key ?? "unknownMemory",
    value: statement.value,
    ...(statement.unit ? { unit: statement.unit } : {}),
    ...(statement.saidBy ? { saidBy: statement.saidBy } : {}),
    ...(dimension?.cardinality ? { cardinality: dimension.cardinality } : {}),
    ...(typeof dimension?.attributes?.description === "string"
      ? { description: dimension.attributes.description }
      : {}),
  };
});
source.close();
if (contents.length === 0) {
  throw new Error(`no extracted facts found in graph smoke database for ${sessionId}`);
}

const transcript = session.turns
  .map((turn) => `[${turn.role}] ${turn.content}`)
  .join("\n");
const graph = new MemoryGraph();
const { cfg } = boot();
const driver = requireChat(cfg, {
  maxTokens: 8000,
  maxRetries: 3,
  extraBody: { thinking: { type: "disabled" } },
});
const scope = { owner_id: "actor:longmemeval_user" };
const plan = await runGraphEnrichment({
  text: transcript,
  contents,
  knownDimensions: contents.map((content) => ({
    key: content.dimensionKey,
    description: content.description ?? content.dimensionKey,
    cardinality: content.cardinality ?? "multi",
  })),
  graph,
  driver,
  scope,
});
const result = commitGraphWritePlan(graph, plan, {
  created_by: "human:longmemeval_user",
  source_refs: [sessionId],
  createdAt: session.date || undefined,
  scope,
});

const assertions = graph.queryNodes({ type: "core:relation" }).map((relation) => ({
  id: relation.id,
  predicate: relation.predicate,
  state: relation.state,
  bindings: Object.fromEntries(
    Object.entries(relation.bindings).map(([role, id]) => {
      const participant = graph.getNode(id);
      return [
        role,
        {
          id,
          type: participant?.type,
          key: participant?.key,
          value: participant?.value,
        },
      ];
    }),
  ),
  supportedBy: graph
    .queryEdges({ type: "core:supports", to: relation.id })
    .map((edge) => graph.getNode(edge.from)?.value),
}));

console.log(
  JSON.stringify(
    {
      sessionId,
      date: session.date,
      facts: contents,
      warnings: plan.warnings,
      entities: result.createdEntityIds.map((id) => graph.getNode(id)),
      assertions,
      usage: usageTotals(),
    },
    null,
    2,
  ),
);
