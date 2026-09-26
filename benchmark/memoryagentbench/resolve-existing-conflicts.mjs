// Apply the production conflict-resolution path to a COPY of an existing run.
// The source database is fingerprinted before/after and is never opened for
// writes. Jev is used when configured; uncertain cases fall back to chat.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  SqliteGraph,
  applyAgentFactRelationProposal,
  decisionDriver,
  listConflicts,
  reconcileStatement,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sourceRunArg = value("--source-run");
const runDirArg = value("--run-dir");
if (!sourceRunArg || !runDirArg) {
  throw new Error("usage: --source-run <completed run> --run-dir <new empty run>");
}
const sourceRun = resolve(sourceRunArg);
const runDir = resolve(runDirArg);
const sourceDb = join(sourceRun, "memory.db");
const targetDb = join(runDir, "memory.db");
if (!existsSync(sourceDb)) throw new Error(`source database not found: ${sourceDb}`);
if (existsSync(runDir) && readdirSync(runDir).length > 0) {
  throw new Error(`refusing to overwrite non-empty run directory: ${runDir}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sourceHashBefore = sha256(sourceDb);
mkdirSync(runDir, { recursive: true });
copyFileSync(sourceDb, targetDb);
const sourceMeta = join(sourceRun, "run-meta.json");
if (existsSync(sourceMeta)) copyFileSync(sourceMeta, join(runDir, "source-run-meta.json"));

const { cfg } = boot();
const forcedThinking = /glm-5\.3/i.test(cfg.llm?.model ?? "");
const chat = requireChat(cfg, {
  maxTokens: 5_000,
  timeoutMs: 120_000,
  maxRetries: 3,
  extraBody: forcedThinking
    ? { reasoning_effort: "low" }
    : { thinking: { type: "disabled" } },
});
const decision = cfg.decision ? decisionDriver(cfg) : undefined;
const graph = new SqliteGraph(targetDb);
const initial = listConflicts(graph);
const outcomes = [];

console.log(
  `resolving ${initial.length} conflicts on copy ${targetDb}` +
    (decision ? ` with ${cfg.decision.model} fast path` : " with chat only"),
);

for (const [index, conflict] of initial.entries()) {
  for (const challenger of conflict.challengers) {
    try {
      const result = await reconcileStatement(graph, challenger.statementId, {
        driver: chat,
        ...(decision ? { decision } : {}),
        sameDimensionOnly: true,
        maxCandidates: 12,
      });
      const incumbentIds = new Set(conflict.incumbents.map((item) => item.statementId));
      const candidates = result.proposals
        .filter(
          (proposal) =>
            proposal.relation === "supersedes" && incumbentIds.has(proposal.objectId),
        )
        .sort((a, b) => b.confidence - a.confidence);
      let applied;
      let failure = "no safe supersession proposal";
      for (const proposal of candidates) {
        try {
          applied = applyAgentFactRelationProposal(graph, proposal, {
            resolvedBy: "agent:edgelore:reconciler",
          });
          outcomes.push({
            dimensionId: conflict.dimensionId,
            dimensionKey: conflict.dimensionKey,
            statementId: challenger.statementId,
            status: "resolved",
            relation: proposal.relation,
            confidence: proposal.confidence,
            route: proposal.reason.startsWith("Jev classified") ? "jev" : "chat",
            reason: proposal.reason,
            edgeId: applied.edgeId,
          });
          break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      if (!applied) {
        outcomes.push({
          dimensionId: conflict.dimensionId,
          dimensionKey: conflict.dimensionKey,
          statementId: challenger.statementId,
          status: "escalated",
          reason:
            result.unresolvedIds.length > 0
              ? `${failure}; ${result.unresolvedIds.length} candidate(s) unresolved`
              : failure,
          readRequests: result.readRequests,
        });
      }
    } catch (error) {
      outcomes.push({
        dimensionId: conflict.dimensionId,
        dimensionKey: conflict.dimensionKey,
        statementId: challenger.statementId,
        status: "escalated",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log(`[${index + 1}/${initial.length}] ${conflict.dimensionKey}`);
}

const remaining = listConflicts(graph);
graph.close();
const sourceHashAfter = sha256(sourceDb);
if (sourceHashAfter !== sourceHashBefore) {
  throw new Error("source database changed while resolving its copy");
}
const report = {
  sourceRun,
  runDir,
  sourceDatabaseSha256: sourceHashBefore,
  sourceUnchanged: true,
  chatModel: cfg.llm?.model ?? null,
  decisionModel: cfg.decision?.model ?? null,
  before: initial.length,
  after: remaining.length,
  resolved: outcomes.filter((item) => item.status === "resolved").length,
  resolvedByRoute: {
    jev: outcomes.filter((item) => item.status === "resolved" && item.route === "jev").length,
    chat: outcomes.filter((item) => item.status === "resolved" && item.route === "chat").length,
  },
  escalated: outcomes.filter((item) => item.status === "escalated").length,
  usage: usageTotals(),
  outcomes,
};
writeFileSync(join(runDir, "conflict-resolution.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`summary ${JSON.stringify({
  before: report.before,
  after: report.after,
  resolved: report.resolved,
  resolvedByRoute: report.resolvedByRoute,
  escalated: report.escalated,
  sourceUnchanged: report.sourceUnchanged,
  usage: report.usage,
})}`);
