# edgelore · Retrieval — hybrid context selection (technical note)

> Companion note for the retrieval overhaul ("取"层 v1). Written after build.
> Design basis: the provider-abstraction + graph-retrieval research (Zep/Graphiti
> hybrid search confirmed as the industry pattern; see conversation research
> fleets, 2026-09-18) and local capability probes (relay embedding channel,
> SQLite FTS5 tokenizer behavior).

## 1. The problem

`contextMemoriesOf` fed the extractor the **latest 50 statements** — "report the
whole inventory". Fine at hundreds of memories; at thousands it bloats prompts
and drowns the extractor in irrelevant context (the relevant fact may not be in
the newest 50 at all). Root cause: context selection by recency, not relevance.

## 2. What shipped

| File | Role |
|------|------|
| `src/agent/embedding-driver.ts` | `EmbeddingDriver` interface (`dimensions` declared, batch-first `embed(texts[])`), `OpenAiCompatEmbeddingDriver` (real), `MockEmbedder` (deterministic, offline) |
| `src/agent/http.ts` | shared transport: `postJsonWithRetry` (network/429/5xx retry, per-attempt timeout) — both real drivers use it |
| `src/agent/retrieval.ts` | `retrieveRelevant` (3 routes + RRF), `expandHit` (1-hop graph expansion), `VectorStore` + `InMemoryVectorStore` + `SqliteVectorStore`, `statementText` |
| `src/store/sqlite.ts` | additive `embeddings` table + `putVector` / `allVectors` (Float32 BLOB, 4 bytes/dim) |
| `src/agent/runtime.ts` | `RetrievalConfig`; `contextMemoriesViaRetrieval`; `processTurn` embeds new statements after capture (`indexed` / `indexError` in the outcome) |
| `src/cli.ts` | `edgelore search "query"` debugger; `remember` auto-wires retrieval when `EDGELORE_EMBEDDING_MODEL` is set |

## 3. The pipeline

```
query ──embed──▶ ① vector route   cosine over stored statement vectors ──▶ rank list A
   └─(no LLM)──▶ ② lexical route  char-bigram containment over "key value" ─▶ rank list B
                  ③ RRF fusion    score = Σ 1/(60 + rank) per route        ─▶ fused top-k
                  ④ expandHit     1 hop: sibling statements (conflict
                                  counterparts) + active constraints with
                                  the M1 engine's current verdict
```

- **Hits are graph addresses** (`statementId`, `dimensionId`, `key`, `value`,
  `state`, `via[]`) — position is native to the graph, not inferred from text
  chunks. Context lines carry the posture: `budget = 5000 [accepted] |
  competing: 8000[tentative] | constraint "预算上限" -> violated`.
- **Ablation switch** `mode: "hybrid" | "vector" | "lexical"` — the industry
  has never published a hybrid-vs-single-signal ablation; we measure on our
  own eval sets. `mode:"vector"` without plumbing fails loud; `hybrid`
  degrades gracefully to lexical when no vectors exist yet.
- **Expansion is capped** (siblings ≤ 5, hits ≤ k=8): StructRAG-style
  counter-evidence shows structured context is not uniformly better when
  flooded.

## 4. Provider abstraction (research-confirmed)

Chat and embedding are **separate configured concerns** — they are often
different vendors (Anthropic ships no embeddings). Per the verified research
(LangChain `Embeddings` as a standalone interface; LlamaIndex
`Settings.embed_model`; Vercel AI SDK provider spec):

- `dimensions` is **declared**, never probed (`EDGELORE_EMBEDDING_DIMENSIONS`).
- `embed(texts[])` is **batch-first**; the documents/query split is deferred
  until a model needs it.
- Zero-dependency providers via global `fetch` + shared retry/timeout in
  `http.ts` (transport concerns live at the transport layer).
- Env: `OPENAI_EMBEDDING_API_KEY` / `OPENAI_EMBEDDING_BASE_URL` fall back to
  `OPENAI_*`; `EDGELORE_EMBEDDING_MODEL` and `EDGELORE_EMBEDDING_DIMENSIONS`
  are required (a chat model is not an embedding model; no silent defaults).

## 5. Design decisions & deviations from the draft spec

1. **JS-side lexical scoring instead of FTS5.** Local probes: the FTS5 default
   tokenizer gives 0 hits on 2-char Chinese queries, and `trigram` cannot match
   them either (trigrams need ≥3 chars). The graph is memory-resident anyway
   (M2 write-through cache), so a 20-line char-bigram containment scorer in JS
   matches CJK reliably, works on BOTH backends (MemoryGraph + SqliteGraph),
   and avoids FTS5 sync machinery. Same ranking role, less complexity.
2. **Brute-force cosine, no sqlite-vec.** Thousands of rows × 1024 dims is
   milliseconds in JS; `loadExtension` exists if we ever need it.
3. **Vectors in a separate `embeddings` table**, not a column on `nodes` —
   additive (existing DBs upgrade with no migration) and rebuildable derived
   data.
4. **Embedding failures never fail a capture.** The memory is stored;
   `outcome.indexError` reports the stale index (vectors are rebuildable).
5. **`processTurn` now takes `MemoryGraph`** (not the narrower `GraphStore`)
   — constraint access for expansion needs the full store surface. `capture`
   still accepts `GraphStore`.

## 6. Validation (real model: deepseek-v4-flash + qwen3.7-text-embedding)

- Seeded a fresh DB via `remember` (2 turns, multi-fact); `outcome.indexed: 1`
  and `2` — vectors written through the real embedding channel.
- `search "预算还剩多少钱"` → `budget = 5000` **first**.
- `search "project budget limit"` (English) → finds the Chinese-stored budget
  via **lexical+vector** — cross-language retrieval through the embedding route.
- `search "PostgreSQL"` → `database = PostgreSQL` first via **lexical+vector** —
  proper nouns are the lexical route's home turf.
- Suite: 109 tests green (20 new), build + lint clean.

## 7. Open items carried forward

- **Dimension key canonicalization**: the LLM produced `manager` vs `owner`
  across runs — cross-run key drift needs an alias/merge mechanism (ties into
  the `project_id` scope work).
- **Backfill**: statements stored before this change have no vectors; the
  lexical route covers them, but a `reindex` command is a natural follow-up.
- **documents/query embed split** (LangChain-style) if a model demands it.
- **Ablation runs** on the eval set (`mode` switch exists; results pending).
- sqlite-vec / ANN index if the corpus ever outgrows brute force.
