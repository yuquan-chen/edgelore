// edgelore — configuration hub tests.
//
// Covers the W5 contract: env -> config mapping with materialized defaults,
// absent credentials leaving llm/embedding undefined (never throwing),
// driver factories failing loud on missing sections, and loadDotEnv
// semantics (no override of real env, comments, missing file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatDriver,
  configFromEnv,
  embeddingDriver,
  loadDotEnv,
  type EdgeloreConfig,
} from "../src/config.js";
import { AgentError } from "../src/agent/errors.js";
import { OpenAiCompatDriver } from "../src/agent/openai-compat-driver.js";
import { OpenAiCompatEmbeddingDriver } from "../src/agent/embedding-driver.js";

const FULL_ENV = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: "https://relay.example/v1",
  EDGELORE_MODEL: "test-model",
  OPENAI_EMBEDDING_API_KEY: "sk-embed",
  OPENAI_EMBEDDING_BASE_URL: "https://embed.example/v1",
  EDGELORE_EMBEDDING_MODEL: "test-embed",
  EDGELORE_EMBEDDING_DIMENSIONS: "1024",
  EDGELORE_RETRIEVAL_K: "12",
  EDGELORE_RETRIEVAL_MODE: "lexical",
  EDGELORE_EXTRACTION_MAX_FACTS: "16",
  EDGELORE_JUDGE_MODEL: "judge-model",
};

// 1. Full env -> every section resolved, env values win over defaults.
test("config: full env maps every section", () => {
  const cfg = configFromEnv(FULL_ENV);
  assert.deepEqual(cfg.llm, {
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-test",
    model: "test-model",
  });
  assert.deepEqual(cfg.embedding, {
    baseUrl: "https://embed.example/v1",
    apiKey: "sk-embed",
    model: "test-embed",
    dimensions: 1024,
  });
  assert.equal(cfg.retrieval.k, 12);
  assert.equal(cfg.retrieval.mode, "lexical");
  assert.equal(cfg.extraction.maxFactsPerSession, 16);
  assert.equal(cfg.judgeModel, "judge-model");
});

// 2. Empty env -> never throws; llm/embedding absent; tuning materialized.
test("config: empty env yields defaults without throwing", () => {
  const cfg = configFromEnv({});
  assert.equal(cfg.llm, undefined);
  assert.equal(cfg.embedding, undefined);
  assert.deepEqual(cfg.retrieval, {
    mode: "hybrid",
    k: 8,
    rrfSmoothing: 60,
    maxEntriesPerDimension: 8,
    maxContextLines: 48,
  });
  assert.equal(cfg.extraction.maxFactsPerSession, 12);
  assert.equal(cfg.judgeModel, undefined);
});

// 3. Embedding falls back to chat credentials when dedicated vars are absent.
test("config: embedding falls back to chat key/base-url", () => {
  const cfg = configFromEnv({
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://relay.example/v1",
    EDGELORE_EMBEDDING_MODEL: "test-embed",
    EDGELORE_EMBEDDING_DIMENSIONS: "8",
  });
  assert.deepEqual(cfg.embedding, {
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-test",
    model: "test-embed",
    dimensions: 8,
  });
});

// 4. Half-configured sections stay undefined (key without model, bad dims).
test("config: partial credential pairs leave sections undefined", () => {
  const onlyKey = configFromEnv({ OPENAI_API_KEY: "sk-test" });
  assert.equal(onlyKey.llm, undefined);
  const onlyModel = configFromEnv({ EDGELORE_MODEL: "m" });
  assert.equal(onlyModel.llm, undefined);
  const badDims = configFromEnv({ EDGELORE_EMBEDDING_MODEL: "e", EDGELORE_EMBEDDING_DIMENSIONS: "abc" });
  assert.equal(badDims.embedding, undefined);
});

// 5. chatDriver throws on missing llm, builds from config otherwise.
test("config: chatDriver fails loud without llm, resolves overrides", () => {
  const empty: EdgeloreConfig = configFromEnv({});
  assert.throws(() => chatDriver(empty), AgentError);
  const driver = chatDriver(configFromEnv(FULL_ENV), { model: "override-model", maxTokens: 100 });
  assert.ok(driver instanceof OpenAiCompatDriver);
});

// 6. embeddingDriver throws on missing embedding, exposes declared dimensions.
test("config: embeddingDriver fails loud without embedding", () => {
  const empty: EdgeloreConfig = configFromEnv({});
  assert.throws(() => embeddingDriver(empty), AgentError);
  const driver = embeddingDriver(configFromEnv(FULL_ENV));
  assert.ok(driver instanceof OpenAiCompatEmbeddingDriver);
  assert.equal(driver.dimensions, 1024);
});

// 7. loadDotEnv: fills missing vars, never overrides real env, skips comments,
//    silently ignores a missing file.
test("config: loadDotEnv semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "edgelore-config-"));
  try {
    const path = join(dir, ".env.local");
    writeFileSync(path, "# comment\nTEST_CFG_A=from-file\nTEST_CFG_B=from-file\n", "utf8");
    process.env.TEST_CFG_B = "from-real-env";
    loadDotEnv(path);
    assert.equal(process.env.TEST_CFG_A, "from-file");
    assert.equal(process.env.TEST_CFG_B, "from-real-env");
    delete process.env.TEST_CFG_A;
    delete process.env.TEST_CFG_B;
    // Missing file is a no-op, not a crash.
    loadDotEnv(join(dir, "does-not-exist.env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
