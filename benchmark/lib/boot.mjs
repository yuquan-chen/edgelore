// edgelore · benchmark shared boot — ONE place for env loading + driver wiring.
//
// Every harness imports boot() instead of hand-rolling loadEnv + driver
// construction, so endpoint/model identity lives in .env.local + src/config
// only (W5), and per-call knobs (maxTokens, thinking-off, retries) stay at
// the call site. This also kills the old split defaults where half the
// scripts fell back to api.dogrouter.ai and half to api.openai.com.
//
// Scripts import from dist (compiled output) — run `npm run build` first.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDotEnv,
  configFromEnv,
  chatDriver,
  embeddingDriver,
} from "../../dist/src/index.js";

const libDir = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the repo root and load `.env.local` into process.env (without
 * overriding real env vars). Returns the resolved {@link EdgeloreConfig}.
 */
export function boot() {
  const root = join(libDir, "..", "..");
  loadDotEnv(join(root, ".env.local"));
  return { root, cfg: configFromEnv(process.env) };
}

/**
 * Chat driver or exit(1) with a readable message — harnesses are CLI tools,
 * a missing config should fail fast, not deep inside a question loop.
 */
export function requireChat(cfg, opts = {}) {
  if (!cfg.llm) {
    console.error("missing OPENAI_API_KEY / EDGELORE_MODEL (check .env.local at repo root)");
    process.exit(1);
  }
  return chatDriver(cfg, opts);
}

/** Embedding driver or exit(1) — for harnesses where vectors are mandatory. */
export function requireEmbedding(cfg) {
  if (!cfg.embedding) {
    console.error(
      "missing EDGELORE_EMBEDDING_MODEL / EDGELORE_EMBEDDING_DIMENSIONS (check .env.local at repo root)",
    );
    process.exit(1);
  }
  return embeddingDriver(cfg);
}
