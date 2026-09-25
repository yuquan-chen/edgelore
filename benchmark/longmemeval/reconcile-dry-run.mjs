// edgelore · LongMemEval FactReconciler dry run.
//
// Reads an existing graph-ingestion smoke database, selects relation-dense
// Statements, and asks the FactReconciler for proposals. It NEVER applies a
// proposal. A before/after graph fingerprint makes the no-write contract
// observable instead of relying on convention.
//
// Usage:
//   node benchmark/longmemeval/reconcile-dry-run.mjs
//   node benchmark/longmemeval/reconcile-dry-run.mjs --limit 10 --db <path>

// Output:
//   data/reconcile-dry-run.json (ignored benchmark artifact)


import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  reconcileStatement,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const limit = Number(option("--limit", "10"));
if (!Number.isInteger(limit) || limit <= 0) {
  throw new Error("--limit must be a positive integer");
}
const dbPath = resolve(option("--db", join(dataDir, "memory-graph-smoke.db")));
const outputPath = resolve(option("--out", join(dataDir, "reconcile-dry-run.json")));
const { cfg } = boot();
const driver = requireChat(cfg, {
  maxTokens: 5000,
  maxRetries: 3,
  extraBody: { thinking: { type: "disabled" } },
});
const graph = new SqliteGraph(dbPath);

function graphFingerprint() {
  const nodes = graph
    .queryNodes({})
    .map((node) => [node.id, node.state, node.updated_at])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edges = graph
    .queryEdges({})
    .map((edge) => [edge.id, edge.type, edge.from, edge.to])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({ nodes, edges });
}

function statementLabel(statement) {
  const dimension = graph.getNode(statement.dimension_id);
  return {
    statementId: statement.id,
    dimensionId: statement.dimension_id,
    dimensionKey: dimension?.key ?? "unknown",
    cardinality: dimension?.cardinality ?? "multi",
    value: statement.value,
    saidBy: statement.saidBy ?? null,
    state: statement.state,
    createdAt: statement.created_at,
    sourceRefs: statement.source_refs,
  };
}

function relationDenseSubjects() {
  const statements = graph
    .queryNodes({ type: "core:statement" })
    .filter((statement) => statement.state !== "rejected" && statement.state !== "superseded");
  const byDimension = new Map();
  for (const statement of statements) {
    const group = byDimension.get(statement.dimension_id) ?? [];
    group.push(statement);
    byDimension.set(statement.dimension_id, group);
  }

  const aboutByStatement = new Map();
  const statementsByTarget = new Map();
  for (const edge of graph.queryEdges({ type: "core:about" })) {
    const targets = aboutByStatement.get(edge.from) ?? [];
    targets.push(edge.to);
    aboutByStatement.set(edge.from, targets);
    const members = statementsByTarget.get(edge.to) ?? [];
    members.push(edge.from);
    statementsByTarget.set(edge.to, members);
  }
  const contradictionDegree = new Map();
  for (const edge of graph.queryEdges({ type: "core:contradicts" })) {
    contradictionDegree.set(edge.from, (contradictionDegree.get(edge.from) ?? 0) + 1);
    contradictionDegree.set(edge.to, (contradictionDegree.get(edge.to) ?? 0) + 1);
  }

  const scored = statements.map((statement) => {
    const sameDimension = (byDimension.get(statement.dimension_id) ?? []).filter(
      (other) => other.id !== statement.id,
    );
    const sharedAbout = new Set();
    for (const target of aboutByStatement.get(statement.id) ?? []) {
      for (const id of statementsByTarget.get(target) ?? []) {
        if (id !== statement.id) sharedAbout.add(id);
      }
    }
    const contradictions = contradictionDegree.get(statement.id) ?? 0;
    return {
      statement,
      sameDimension: sameDimension.length,
      sharedAbout: sharedAbout.size,
      contradictions,
      score: contradictions * 100 + sameDimension.length * 10 + sharedAbout.size,
    };
  });

  // Direction matters: subject -> older candidate. Prefer the latest Statement
  // in each Dimension, then avoid spending calls on the same Dimension twice.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.statement.created_at.localeCompare(a.statement.created_at) ||
      b.statement.id.localeCompare(a.statement.id),
  );
  const picked = [];
  const seenDimensions = new Set();
  for (const candidate of scored) {
    if (candidate.score <= 0 || seenDimensions.has(candidate.statement.dimension_id)) continue;
    const latestInDimension = (byDimension.get(candidate.statement.dimension_id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      )[0];
    if (latestInDimension?.id !== candidate.statement.id) continue;
    picked.push(candidate);
    seenDimensions.add(candidate.statement.dimension_id);
    if (picked.length >= limit) break;
  }
  return picked;
}

const before = graphFingerprint();
const selected = relationDenseSubjects();
const results = [];
console.log(`FactReconciler dry run: ${selected.length} real Statement groups from ${dbPath}`);

for (const [index, selectedSubject] of selected.entries()) {
  const subject = selectedSubject.statement;
  try {
    const result = await reconcileStatement(graph, subject.id, {
      driver,
      maxCandidates: 12,
    });
    const proposals = result.proposals.map((proposal) => {
      const object = graph.getNode(proposal.objectId);
      return {
        ...proposal,
        object: object?.type === "core:statement" ? statementLabel(object) : null,
      };
    });
    results.push({
      subject: statementLabel(subject),
      selection: {
        score: selectedSubject.score,
        sameDimensionNeighbors: selectedSubject.sameDimension,
        sharedAboutNeighbors: selectedSubject.sharedAbout,
        contradictionDegree: selectedSubject.contradictions,
      },
      proposals,
      unresolvedIds: result.unresolvedIds,
    });
    const summary = proposals.map((proposal) => proposal.relation).join(", ") || "no proposals";
    console.log(
      `[${index + 1}/${selected.length}] ${statementLabel(subject).dimensionKey}: ${summary}`,
    );
  } catch (error) {
    results.push({
      subject: statementLabel(subject),
      selection: {
        score: selectedSubject.score,
        sameDimensionNeighbors: selectedSubject.sameDimension,
        sharedAboutNeighbors: selectedSubject.sharedAbout,
        contradictionDegree: selectedSubject.contradictions,
      },
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(
      `[${index + 1}/${selected.length}] ${statementLabel(subject).dimensionKey}: ERROR`,
    );
  }
}

const after = graphFingerprint();
if (after !== before) {
  graph.close();
  throw new Error("dry-run invariant violated: graph changed while generating proposals");
}

const relationCounts = {};
for (const result of results) {
  for (const proposal of result.proposals ?? []) {
    relationCounts[proposal.relation] = (relationCounts[proposal.relation] ?? 0) + 1;
  }
}
const report = {
  generatedAt: new Date().toISOString(),
  database: dbPath,
  selectedGroups: selected.length,
  graphUnchanged: true,
  relationCounts,
  usage: usageTotals(),
  results,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
graph.close();

console.log(`relations: ${JSON.stringify(relationCounts)}`);
console.log(`graph unchanged: yes`);
console.log(
  `API usage: ${report.usage.calls} calls, ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens, ${report.usage.errors} errors`,
);
console.log(`report: ${outputPath}`);
