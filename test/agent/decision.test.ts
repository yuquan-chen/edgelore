// edgelore · Agent Memory layer — System One decision driver tests (Jev).
//
// Covers typed answer parsing (noul/choice), fan-out mapping, and the
// missing-key guard. HTTP transport is faked — no network in tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeDecisionDriver } from "../../src/agent/decision.js";
import { AgentError } from "../../src/agent/errors.js";

/** Fake transport: captures the request body, replays a canned payload. */
function makeFakePost(payload: unknown) {
  const bodies: unknown[] = [];
  const post = (async (req: { body: unknown }) => {
    bodies.push(req.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  }) as never;
  return { post, bodies };
}

function driver(post: never) {
  return new TypeSafeDecisionDriver({ baseUrl: "https://x", apiKey: "k", post });
}

test("decision: noul parses P(yes) from the typed answer", async () => {
  const { post } = makeFakePost({
    answers: { decision: { type: "noul", noul: 0.94 } },
  });
  const d = driver(post);
  const v = await d.noul("state", "relevant?");
  assert.equal(v, 0.94);
});

test("decision: choice parses the selected option key", async () => {
  const { post } = makeFakePost({
    answers: { decision: { type: "choice", choice: "event", confidence: 0.99 } },
  });
  const d = driver(post);
  const v = await d.choice("state", "what kind?", { event: "did it", advice: "suggested it" });
  assert.equal(v, "event");
});

test("decision: fan-out maps one call to many named yes/no answers", async () => {
  const { post } = makeFakePost({
    answers: { a: { noul: 1 }, b: { noul: 0 } },
  });
  const d = driver(post);
  const out = await d.noulFanOut("state", { a: "first?", b: "second?" });
  assert.deepEqual(out, { a: 1, b: 0 });
});

test("decision: choice fan-out preserves confidence and probabilities", async () => {
  const { post, bodies } = makeFakePost({
    answers: {
      first: {
        choice: "supersedes",
        confidence: 0.96,
        probabilities: { supersedes: 0.92, contradicts: 0.08 },
      },
      second: {
        choice: "independent",
        probabilities: { independent: 0.88, refines: 0.12 },
      },
    },
  });
  const d = driver(post);
  const out = await d.choiceFanOut("state", {
    first: { instructions: "one", criteria: { supersedes: "newer", contradicts: "clash" } },
    second: { instructions: "two", criteria: { independent: "separate", refines: "detail" } },
  });

  assert.equal(out.first?.choice, "supersedes");
  assert.equal(out.first?.confidence, 0.96);
  assert.equal(out.second?.confidence, 0.88);
  assert.deepEqual(
    (bodies[0] as { questions: { first: { type: string } } }).questions.first.type,
    "choice",
  );
});

test("decision: fromEnv throws without TYPESAFE_API_KEY", () => {
  assert.throws(() => TypeSafeDecisionDriver.fromEnv({}), AgentError);
});
