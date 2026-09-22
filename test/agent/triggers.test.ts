// edgelore · Agent Memory layer — event scan (trigger layer v0) tests.
//
// The scan is a guaranteed-attention pre-pass: user sentences pairing a
// first-person marker with a time expression become candidates the extractor
// must explicitly decide on. What the tests lock down: asides get flagged,
// assistant turns never do, the first-person and time halves are each
// required, CJK works, unmarked text over-includes, and the cap bounds the
// prompt. No topic or verb vocabularies anywhere — only closed classes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_CANDIDATE_CAP, scanEventCandidates } from "../../src/agent/triggers.js";

test("scan: an aside event in a user turn is flagged with its time expression", () => {
  const t = [
    "[assistant] Sure, I can help with route planning for your trip.",
    "[user] I'm planning a road trip and need some help. By the way, I drove for six hours to Washington D.C. recently, but I'm not sure about the best route.",
  ].join("\n");
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 1);
  assert.match(hits[0].sentence, /drove for six hours/);
  assert.match(hits[0].timeExpr, /recently/i);
});

test("scan: assistant turns are never scanned (their I is not the speaker's biography)", () => {
  const t = [
    "[assistant] I recently reviewed three options and just picked one to recommend.",
    "[user] Which database should I use for this project?",
  ].join("\n");
  assert.deepEqual(scanEventCandidates(t), []);
});

test("scan: first-person without a time expression is not flagged", () => {
  const t = "[user] I lent my spare monitor to my sister when she visited.";
  assert.deepEqual(scanEventCandidates(t), []);
});

test("scan: a time expression without first person is not flagged", () => {
  const t = "[assistant] The store closes early next Monday, and the sale started yesterday.";
  assert.deepEqual(scanEventCandidates(t), []);
});

test("scan: explicit dates fire (spelled day-month and ISO)", () => {
  const t = [
    "[user] I attended a backyard BBQ party at my colleague's house on the 3rd of June.",
    "[user] Also, on 2023-05-20 I finally replaced my old helmet.",
  ].join("\n");
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 2);
  assert.match(hits[0].timeExpr, /3rd of June/i);
  assert.match(hits[1].timeExpr, /2023-05-20/);
});

test("scan: Chinese first person + time expression is flagged", () => {
  const t = "[user] 我上周六参加了同事的后院烧烤，聊到了育儿经验。";
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 1);
  assert.match(hits[0].timeExpr, /上周六|上周/);
});

test("scan: unmarked lines are treated as user speech (over-inclusive default)", () => {
  const t = "I got a fine for parking downtown last Monday, can you tell me how to appeal?";
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 1);
  assert.match(hits[0].timeExpr, /last monday/i);
});

test("scan: only the sentences that satisfy both halves are returned from a long turn", () => {
  const t = [
    "[user] First sentence without any marker at all. Second sentence mentions yesterday but no speaker.",
    "[user] Third sentence is right: I picked up the keys from the agent this morning.",
  ].join("\n");
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 1);
  assert.match(hits[0].sentence, /picked up the keys/);
});

test("scan: the candidate cap bounds pathological transcripts", () => {
  const lines: string[] = [];
  for (let i = 0; i < EVENT_CANDIDATE_CAP + 10; i++) {
    lines.push(`[user] Number ${i}: I watered the tomatoes yesterday.`);
  }
  assert.equal(scanEventCandidates(lines.join("\n")).length, EVENT_CANDIDATE_CAP);
});

test("scan: candidates arrive in transcript order and verbatim", () => {
  const t = [
    "[user] I booked the venue on June 3rd. Then we discussed catering plans for the party.",
    "[user] Two months ago I started learning French.",
  ].join("\n");
  const hits = scanEventCandidates(t);
  assert.equal(hits.length, 2);
  assert.match(hits[0].sentence, /^I booked the venue/);
  assert.ok(hits[0].sentence.indexOf("Then we discussed") === -1);
  assert.match(hits[1].sentence, /learning French/);
});

test("prompt: flagged sentences render as a must-decide block in the batch prompt", async () => {
  const { buildBatchExtractionPrompt } = await import("../../src/agent/prompt.js");
  const withEvents = buildBatchExtractionPrompt({
    transcript: "[user] I attended a workshop on the 3rd of June.",
    knownDimensions: [],
    maxFacts: 12,
    mustConsiderEvents: ["I attended a workshop on the 3rd of June."],
  });
  assert.match(withEvents, /Reported experiences \(decide every one\)/);
  assert.match(withEvents, /Skipping a flagged\s+sentence without a decision is not allowed/);
  assert.match(withEvents, /- I attended a workshop on the 3rd of June\./);

  const withoutEvents = buildBatchExtractionPrompt({
    transcript: "[user] Hello!",
    knownDimensions: [],
    maxFacts: 12,
  });
  assert.doesNotMatch(withoutEvents, /Reported experiences/);
});
