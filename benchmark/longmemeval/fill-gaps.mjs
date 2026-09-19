// edgelore · 精准补漏 — 只处理 memory.db 里缺失的会话。
// 从 missing-sessions.json 读取缺失列表，逐个抽取+入库。
// Usage: node benchmark/longmemeval/fill-gaps.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  embeddingDriver,
  parseJsonReply,
  capture,
  buildBatchExtractionPrompt,
  normalizeBatchContents,
  relevantDimensionsOf,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { cfg } = boot();
if (!cfg.llm) {
  console.error("missing OPENAI_API_KEY / EDGELORE_MODEL (check .env.local at repo root)");
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(join(here, "data", "longmemeval_oracle.json"), "utf8"));
const missingIds = new Set(JSON.parse(readFileSync(join(here, "data", "missing-sessions.json"), "utf8")));

const graph = new SqliteGraph(join(here, "data", "memory.db"));
const driver = requireChat(cfg, { maxTokens: 16000, timeoutMs: 180_000, extraBody: { thinking: { type: "disabled" } } }); // 缺失会话常是超长转写：60s 不够，放宽到 3 分钟
const vectors = new SqliteVectorStore(graph);
const embedder = cfg.embedding ? embeddingDriver(cfg) : undefined;

// 收集缺失会话的数据
const targets = [];
for (const q of dataset) {
  q.haystack_session_ids.forEach((sid, i) => {
    if (missingIds.has(sid) && !targets.some(t => t.sid === sid)) {
      targets.push({
        sid,
        date: (q.haystack_dates[i] ?? "").slice(0, 10),
        turns: q.haystack_sessions[i] ?? [],
      });
    }
  });
}

console.log(`需要补录: ${targets.length} 个会话\n`);

const ctx = { created_by: "human:longmemeval_user", source_refs: [] };

let stored = 0, errors = 0;
const t0 = Date.now();

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const transcript = t.turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  if (!transcript.trim()) { console.log(`${i + 1}/${targets.length} ${t.sid}: 空会话，跳过`); continue; }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`[${i + 1}/${targets.length}] ${t.sid} (${elapsed}s)...`);

  try {
    ctx.source_refs = [t.sid];
    const reply = await driver.complete(
      buildBatchExtractionPrompt({
        transcript,
        knownDimensions: relevantDimensionsOf(graph, transcript, 30),
        maxFacts: cfg.extraction.maxFactsPerSession,
      }),
    );
    const parsed = parseJsonReply(reply);
    const { contents, skipped } = normalizeBatchContents(parsed.contents ?? []);
    if (skipped > 0) console.log(`[warn] ${t.sid}: skipped ${skipped} malformed entries`);

    for (const c of contents) {
      capture(graph, c, { ...ctx, createdAt: t.date || undefined });
      stored++;
    }
    // embed new statements
    if (embedder) {
      const stmts = graph.queryNodes({ type: "core:statement" }).filter((s) => s.source_refs.includes(t.sid));
      if (stmts.length > 0) {
        const texts = stmts.map((s) => {
          const dim = graph.getNode(s.dimension_id);
          return `${dim?.key ?? ""} ${JSON.stringify(s.value)}${s.unit ? ` ${s.unit}` : ""}`;
        });
        const vecs = await embedder.embed(texts);
        stmts.forEach((s, j) => vectors.put(s.id, vecs[j]));
      }
    }
    console.log(` ✓ ${contents.length} 条记忆`);
  } catch (err) {
    errors++;
    console.log(` ✗ ${err.message.slice(0, 80)}`);
  }
}

console.log(`\n完成: ${stored} 条记忆入库, ${errors} 个错误`);
