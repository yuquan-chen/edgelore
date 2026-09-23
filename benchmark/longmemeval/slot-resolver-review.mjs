// edgelore · adversarial review for Slot Resolver entity-binding proposals.
//
// This is a second, independent read-only pass. It reviews only proposed
// non-owner bindings and rejects false unary ownership before any graph write.
//
// Usage:
//   node benchmark/longmemeval/slot-resolver-review.mjs --input <probe.json>


import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  SqliteGraph,
  parseJsonReply,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const inputArg = option("--input");
if (!inputArg) throw new Error("--input is required");
const inputPath = resolve(inputArg);
const outputPath = resolve(
  option("--out", inputPath.replace(/\.json$/i, "-reviewed.json")),
);
const proposalReport = JSON.parse(readFileSync(inputPath, "utf8"));
const graph = new SqliteGraph(proposalReport.database);
const { cfg } = boot();
const driver = requireChat(cfg, {
  maxTokens: 6000,
  maxRetries: 3,
  extraBody: { thinking: { type: "disabled" } },
});

function fingerprint() {
  return JSON.stringify({
    nodes: graph.queryNodes({}).map((node) => [node.id, node.state, node.updated_at]).sort(),
    edges: graph.queryEdges({}).map((edge) => [edge.id, edge.type, edge.from, edge.to]).sort(),
    episodes: graph.getAllEpisodes().map((episode) => episode.id).sort(),
  });
}

function transcriptOf(sourceId) {
  const episode = graph.getEpisode(sourceId);
  return episode?.turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n") ?? "";
}

function reviewPrompt(sourceId, proposals) {
  const items = proposals.map((proposal, index) => ({
    ref: `p${index + 1}`,
    claimValue: proposal.value,
    saidBy: proposal.saidBy,
    proposedOwnershipKind: proposal.ownershipKind,
    proposedSubject: proposal.subjectEntity,
    proposedProperty: proposal.propertyKey,
    proposerConfidence: proposal.confidence,
    proposerReason: proposal.reason,
  }));
  return {
    items,
    prompt: [
      "You are the adversarial reviewer for proposed entity-bound Slots in a personal memory graph. Reject aggressively: false entity ownership is more damaging than leaving a Claim on $scopeOwner.",
      "Review only whether ONE proposed entity is the complete truth-holder of the proposed Property. core:about and topical relevance are insufficient.",
      "ACCEPT intrinsicProperty only for that entity's own identity, specification, capacity, public offering, or current state that remains true if the memory owner changes.",
      "ACCEPT eventAttribute only for one occurrence's own date, location, participants, route, or outcome, and only when the Claim is not primarily the owner's act or experience.",
      "REJECT owner actions/acquisitions/usage/experience/plans/preferences/personal status, including bought, set up, lives in, reached membership status, tried, wants, or plans.",
      "REJECT recommendations or how-to advice addressed to the owner or tailored to the owner's object. Public specifications, prices, promotion rules, and documented requirements may be accepted; remembering that the assistant recommended something is owner-bound.",
      "REJECT claims requiring two or more entities, comparisons, relations, routes between places, group recommendations, or claims where the proposer arbitrarily selected one item from a list.",
      "REJECT a proposed subject that is merely a context, beneficiary, venue, product being worked on, or one mention among several—not the complete grammatical and semantic truth-holder.",
      "The proposal's reason and confidence are untrusted. Use the Claim and source evidence. When uncertain, reject.",
      `Proposals:\n${JSON.stringify(items)}`,
      `Source Episode:\n${transcriptOf(sourceId)}`,
      `Return ONLY one JSON object with exactly one review per proposal:
{
  "reviews": [
    {
      "proposalRef": "p1",
      "verdict": "accept or reject",
      "failureMode": "intrinsic or eventAttribute or ownerAction or personalStatus or recommendation or relational or comparison or multiEntity or wrongEntity or uncertain",
      "confidence": "high or medium or low",
      "reason": "short critical explanation"
    }
  ]
}`,
    ].join("\n\n"),
  };
}

function normalizeReviews(raw, items, proposals) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.reviews)) {
    throw new Error("review reply must contain a reviews array");
  }
  const expected = new Map(items.map((item, index) => [item.ref, proposals[index]]));
  const seen = new Set();
  const reviews = [];
  for (const value of raw.reviews) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review must be an object");
    const ref = typeof value.proposalRef === "string" ? value.proposalRef : "";
    const proposal = expected.get(ref);
    if (!proposal || seen.has(ref)) throw new Error(`unknown or duplicate proposalRef: ${ref}`);
    seen.add(ref);
    if (value.verdict !== "accept" && value.verdict !== "reject") {
      throw new Error(`invalid verdict for ${ref}: ${value.verdict}`);
    }
    const confidence = ["high", "medium", "low"].includes(value.confidence)
      ? value.confidence
      : "low";
    reviews.push({
      proposalRef: ref,
      claimId: proposal.claimId,
      value: proposal.value,
      proposedSubject: proposal.subjectEntity,
      proposedProperty: proposal.propertyKey,
      proposerConfidence: proposal.confidence,
      verdict: value.verdict,
      failureMode: typeof value.failureMode === "string" ? value.failureMode : "uncertain",
      confidence,
      reason: typeof value.reason === "string" ? value.reason.trim() : "",
      // Applying requires positive high-confidence consensus from both passes.
      consensusApply:
        value.verdict === "accept" &&
        value.confidence === "high" &&
        proposal.confidence === "high",
    });
  }
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].filter((ref) => !seen.has(ref));
    throw new Error(`reviewer omitted proposals: ${missing.join(", ")}`);
  }
  return reviews;
}

const grouped = proposalReport.results
  .map((result) => ({
    sourceId: result.sourceId,
    proposals: (result.decisions ?? []).filter((decision) => decision.subjectRef !== "$scopeOwner"),
  }))
  .filter((group) => group.proposals.length > 0);

const before = fingerprint();
const results = [];
console.log(`Slot Resolver review: ${grouped.length} sessions, ${grouped.reduce((n, g) => n + g.proposals.length, 0)} entity proposals`);
for (const [index, group] of grouped.entries()) {
  const promptData = reviewPrompt(group.sourceId, group.proposals);
  try {
    const raw = parseJsonReply(await driver.complete(promptData.prompt));
    const reviews = normalizeReviews(raw, promptData.items, group.proposals);
    results.push({ sourceId: group.sourceId, reviews });
    const accepted = reviews.filter((review) => review.consensusApply).length;
    console.log(`[${index + 1}/${grouped.length}] ${group.sourceId}: ${accepted}/${reviews.length} consensus`);
  } catch (error) {
    results.push({
      sourceId: group.sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`[${index + 1}/${grouped.length}] ${group.sourceId}: ERROR`);
  }
}

const after = fingerprint();
if (before !== after) {
  graph.close();
  throw new Error("review dry-run invariant violated: graph changed");
}

const reviews = results.flatMap((result) => result.reviews ?? []);
const failureModes = {};
for (const review of reviews.filter((review) => review.verdict === "reject")) {
  failureModes[review.failureMode] = (failureModes[review.failureMode] ?? 0) + 1;
}
const summary = {
  sessionsReviewed: grouped.length,
  sessionsSucceeded: results.filter((result) => !result.error).length,
  sessionsFailed: results.filter((result) => result.error).length,
  proposalsReviewed: reviews.length,
  acceptedByReviewer: reviews.filter((review) => review.verdict === "accept").length,
  rejectedByReviewer: reviews.filter((review) => review.verdict === "reject").length,
  consensusApply: reviews.filter((review) => review.consensusApply).length,
  failureModes,
};
const report = {
  generatedAt: new Date().toISOString(),
  database: proposalReport.database,
  proposalReport: inputPath,
  graphUnchanged: true,
  summary,
  usage: usageTotals(),
  results,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
graph.close();

console.log(JSON.stringify(summary, null, 2));
console.log("graph unchanged: yes");
console.log(
  `API usage: ${report.usage.calls} calls, ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens, ${report.usage.errors} errors`,
);
console.log(`report: ${outputPath}`);
