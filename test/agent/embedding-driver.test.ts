// edgelore · Agent Memory layer — embedding driver tests.
//
// No network: globalThis.fetch is stubbed per test and restored in finally.
// Covers the declared-dimensions contract (no silent probing), the
// OPENAI_EMBEDDING_* -> OPENAI_* fallback chain, reply validation
// (count + vector length), and transient retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "../../src/agent/errors.js";
import { MockEmbedder, OpenAiCompatEmbeddingDriver } from "../../src/agent/embedding-driver.js";

function embeddingsResponse(vectors: number[][], status = 200): Response {
  return new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("embedding driver: fromEnv throws without a key", () => {
  assert.throws(() => OpenAiCompatEmbeddingDriver.fromEnv({}), AgentError);
});

test("embedding driver: fromEnv throws without a model (chat models are not embedding models)", () => {
  assert.throws(() => OpenAiCompatEmbeddingDriver.fromEnv({ OPENAI_API_KEY: "sk-x" }), AgentError);
});

test("embedding driver: fromEnv throws without declared dimensions (no probing)", () => {
  assert.throws(
    () => OpenAiCompatEmbeddingDriver.fromEnv({ OPENAI_API_KEY: "sk-x", EDGELORE_EMBEDDING_MODEL: "m" }),
    AgentError,
  );
});

test("embedding driver: fromEnv falls back to OPENAI_* when EMBEDDING_* absent", async () => {
  const original = globalThis.fetch;
  let seenUrl = "";
  try {
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return embeddingsResponse([[0.1, 0.2]]);
    }) as typeof fetch;
    const driver = OpenAiCompatEmbeddingDriver.fromEnv({
      OPENAI_API_KEY: "sk-fallback",
      OPENAI_BASE_URL: "https://relay.example/v1",
      EDGELORE_EMBEDDING_MODEL: "m-1",
      EDGELORE_EMBEDDING_DIMENSIONS: "2",
    });
    const vectors = await driver.embed(["hello"]);
    assert.deepEqual(vectors, [[0.1, 0.2]]);
    assert.equal(seenUrl, "https://relay.example/v1/embeddings"); // base URL fallback used
  } finally {
    globalThis.fetch = original;
  }
});

test("embedding driver: embed batches input and validates shape", async () => {
  const original = globalThis.fetch;
  let seenBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return embeddingsResponse([
        [1, 0],
        [0, 1],
      ]);
    }) as typeof fetch;
    const driver = new OpenAiCompatEmbeddingDriver({
      baseUrl: "https://x/v1",
      apiKey: "sk",
      model: "m",
      dimensions: 2,
    });
    const vectors = await driver.embed(["a", "b"]);
    assert.equal(vectors.length, 2);
    assert.deepEqual(seenBody.input, ["a", "b"]); // batch-first, one call
    assert.equal(seenBody.model, "m");
  } finally {
    globalThis.fetch = original;
  }
});

test("embedding driver: wrong vector length or count fails loud", async () => {
  const original = globalThis.fetch;
  try {
    const driver = new OpenAiCompatEmbeddingDriver({
      baseUrl: "https://x/v1",
      apiKey: "sk",
      model: "m",
      dimensions: 2,
    });
    globalThis.fetch = (async () => embeddingsResponse([[1, 0, 3]])) as typeof fetch;
    await assert.rejects(driver.embed(["a"]), AgentError); // 3 values, expected 2
    globalThis.fetch = (async () => embeddingsResponse([[1, 0]])) as typeof fetch;
    await assert.rejects(driver.embed(["a", "b"]), AgentError); // 1 vector, expected 2
  } finally {
    globalThis.fetch = original;
  }
});

test("embedding driver: transient 5xx is retried once, then succeeds", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 500 })
        : embeddingsResponse([[0.5, 0.5]]);
    }) as typeof fetch;
    const driver = new OpenAiCompatEmbeddingDriver({
      baseUrl: "https://x/v1",
      apiKey: "sk",
      model: "m",
      dimensions: 2,
    });
    assert.deepEqual(await driver.embed(["a"]), [[0.5, 0.5]]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("mock embedder: deterministic, same text -> same vector", async () => {
  const embedder = new MockEmbedder(8);
  const [a] = await embedder.embed(["budget 5000"]);
  const [b] = await embedder.embed(["budget 5000"]);
  const [c] = await embedder.embed(["owner charles"]);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a?.length, 8);
});
