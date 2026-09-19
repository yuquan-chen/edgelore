// edgelore · LongMemEval — backfill missing statement vectors.
//
// Embeds every statement in the merged store that has no vector yet (e.g.
// sessions ingested while the embedding key was misconfigured). Batched,
// resumable (skips ids already present in the embeddings table).
//
// Usage: node benchmark/longmemeval/reindex.mjs [--batch 32]

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
} from "../../dist/src/index.js";
import { boot, requireEmbedding } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { cfg } = boot();
const graph = new SqliteGraph(join(here, "data", "memory.db"));
const vectors = new SqliteVectorStore(graph);
const embedder = requireEmbedding(cfg);

const have = new Set(vectors.all().map((e) => e.id));
const all = (graph.queryNodes({ type: "core:statement" }) ?? []).filter((s) => !have.has(s.id));
console.log(`statements: ${all.length} total, missing vectors: ${all.length - have.size === 0 ? 0 : all.filter((s) => !have.has(s.id)).length}`);

const batch = Number(process.argv[process.argv.indexOf("--batch") + 1] ?? 16); // qwen 单批上限 20
let done = 0;
for (let i = 0; i < all.length; i += batch) {
  const chunk = all.slice(i, i + batch);
  const texts = chunk.map((s) => {
    const dim = graph.getNode(s.dimension_id);
    return `${dim?.key ?? ""} ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""}`;
  });
  const vecs = await embedder.embed(texts);
  chunk.forEach((s, j) => vectors.put(s.id, vecs[j]));
  done += chunk.length;
  console.log(`indexed: ${done}/${all.length}`);
}
console.log(`reindex complete: ${done} vectors written`);
