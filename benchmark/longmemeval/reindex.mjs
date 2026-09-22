// edgelore · LongMemEval — backfill missing statement vectors.
//
// Embeds every statement in the merged store that has no vector yet (e.g.
// sessions ingested while the embedding key was misconfigured). Batched,
// resumable (skips ids already present in the embeddings table).
//
// Usage: node benchmark/longmemeval/reindex.mjs [--db PATH] [--batch 16]

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  conversationEvidenceText,
} from "../../dist/src/index.js";
import { boot, requireEmbedding } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argVal(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const { cfg } = boot();
const dbPath = argVal("--db")
  ? resolve(argVal("--db"))
  : join(here, "data", "memory.db");
const graph = new SqliteGraph(dbPath);
const vectors = new SqliteVectorStore(graph);
const embedder = requireEmbedding(cfg);

const have = new Set(vectors.all().map((e) => e.id));
const retrievable = [
  ...(graph.queryNodes({ type: "core:statement" }) ?? []),
  ...(graph.queryNodes({ type: "core:message" }) ?? []),
];
const all = retrievable.filter((node) => !have.has(node.id));
console.log(`database: ${dbPath}`);
console.log(`retrievable nodes: ${retrievable.length}, missing vectors: ${all.length}`);

const batch = Number(argVal("--batch") ?? 16); // qwen 单批上限 20
let done = 0;
for (let i = 0; i < all.length; i += batch) {
  const chunk = all.slice(i, i + batch);
  const texts = chunk.map((node) => {
    if (node.type === "core:message") return conversationEvidenceText(node);
    const dim = graph.getNode(node.dimension_id);
    return `${dim?.key ?? ""} ${JSON.stringify(node.value)}${node.unit ? ` ${node.unit}` : ""}`;
  });
  const vecs = await embedder.embed(texts);
  chunk.forEach((s, j) => vectors.put(s.id, vecs[j]));
  done += chunk.length;
  console.log(`indexed: ${done}/${all.length}`);
}
console.log(`reindex complete: ${done} vectors written`);
graph.close();
