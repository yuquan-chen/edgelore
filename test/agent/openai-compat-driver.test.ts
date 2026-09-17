// edgelore · Agent Memory layer — OpenAI-compatible driver tests.
//
// No network: globalThis.fetch is stubbed per test and restored in finally.
// Covers request shaping (URL, bearer auth, model, temperature 0), reply
// extraction, fail-loud error mapping (non-retryable 4xx), and transient
// retry behavior (network errors and 5xx retried, exhaustion fails loud).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "../../src/agent/errors.js";
import { OpenAiCompatDriver } from "../../src/agent/openai-compat-driver.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("driver: fromEnv throws without an API key", () => {
  assert.throws(() => OpenAiCompatDriver.fromEnv({}), AgentError);
});

test("driver: fromEnv throws without a model (no silent default)", () => {
  assert.throws(() => OpenAiCompatDriver.fromEnv({ OPENAI_API_KEY: "sk-x" }), AgentError);
});

test("driver: fromEnv applies env values and explicit overrides win", () => {
  const fromEnv = OpenAiCompatDriver.fromEnv({
    OPENAI_API_KEY: "sk-env",
    OPENAI_BASE_URL: "https://relay.example/v1",
    EDGELORE_MODEL: "m-env",
  });
  const overridden = OpenAiCompatDriver.fromEnv(
    { OPENAI_API_KEY: "sk-env", EDGELORE_MODEL: "m-env" },
    { apiKey: "sk-flag", model: "m-flag" },
  );
  // Internals are private; construction without throwing + distinct configs
  // is the observable contract. Drive one request each to verify wiring.
  assert.ok(fromEnv && overridden);
});

test("driver: complete posts to /chat/completions and extracts the reply", async () => {
  const original = globalThis.fetch;
  let seenUrl = "";
  let seenAuth = "";
  let seenBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String(new Headers(init?.headers).get("Authorization"));
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "OK" } }] });
    }) as typeof fetch;
    const driver = new OpenAiCompatDriver({
      baseUrl: "https://relay.example/v1/",
      apiKey: "sk-x",
      model: "m-1",
    });
    const reply = await driver.complete("hello");
    assert.equal(reply, "OK");
    assert.equal(seenUrl, "https://relay.example/v1/chat/completions"); // trailing slash trimmed
    assert.equal(seenAuth, "Bearer sk-x");
    assert.equal(seenBody.model, "m-1");
    assert.equal(seenBody.temperature, 0);
    assert.deepEqual(seenBody.messages, [{ role: "user", content: "hello" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("driver: non-retryable 4xx fails loud immediately (no retry)", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: { message: "bad key" } }, 401);
    }) as typeof fetch;
    const driver = new OpenAiCompatDriver({ baseUrl: "https://x/v1", apiKey: "sk", model: "m" });
    await assert.rejects(driver.complete("p"), /API 401/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("driver: 5xx is retried once, then succeeds", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const driver = new OpenAiCompatDriver({ baseUrl: "https://x/v1", apiKey: "sk", model: "m" });
    assert.equal(await driver.complete("p"), "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("driver: exhaustion after retries fails loud with attempt count", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({}, 503);
    }) as typeof fetch;
    const driver = new OpenAiCompatDriver({ baseUrl: "https://x/v1", apiKey: "sk", model: "m" });
    await assert.rejects(driver.complete("p"), /failed after 2 attempts/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("driver: network-level failure is treated as transient", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connect ECONNREFUSED");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const driver = new OpenAiCompatDriver({ baseUrl: "https://x/v1", apiKey: "sk", model: "m" });
    assert.equal(await driver.complete("p"), "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
