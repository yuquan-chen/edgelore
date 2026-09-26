// Local-only attribution for failed MemoryAgentBench multi-hop questions.
// No model calls and no writes to the graph.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SqliteGraph, slotSubjectRef } from "../../dist/src/index.js";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const evaluationPath = resolve(value("--evaluation") ?? "");
if (!evaluationPath) throw new Error("--evaluation is required");
const runDir = dirname(evaluationPath);
const databasePath = resolve(value("--db") ?? join(runDir, "memory.db"));
const outputPath = resolve(
  value("--out") ?? join(runDir, `${basename(evaluationPath, ".json")}-multihop-attribution.json`),
);

const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8"));
const graph = new SqliteGraph(databasePath);
const nodes = graph.queryNodes({});
const statements = nodes.filter((node) => node.type === "core:statement");
const dimensions = new Map(
  nodes.filter((node) => node.type === "core:dimension").map((node) => [node.id, node]),
);
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const adjacency = new Map();
const semanticAdjacency = new Map();
const connect = (a, b, label) => {
  if (!a || !b || a === b) return;
  const left = adjacency.get(a) ?? [];
  left.push({ id: b, label });
  adjacency.set(a, left);
  const right = adjacency.get(b) ?? [];
  right.push({ id: a, label });
  adjacency.set(b, right);
};
const connectDirected = (from, to, label) => {
  if (!from || !to || from === to) return;
  const rows = semanticAdjacency.get(from) ?? [];
  rows.push({ id: to, label });
  semanticAdjacency.set(from, rows);
};
const allEdges = graph.queryEdges({});
for (const edge of allEdges) connect(edge.from, edge.to, edge.type);
const aboutByStatement = new Map();
for (const edge of allEdges.filter((edge) => edge.type === "core:about")) {
  const targets = aboutByStatement.get(edge.from) ?? [];
  targets.push(edge.to);
  aboutByStatement.set(edge.from, targets);
}
for (const statement of statements) {
  const dimension = dimensions.get(statement.dimension_id);
  if (!dimension) continue;
  const subjectRef = slotSubjectRef(dimension);
  if (subjectRef !== "$scopeOwner" && nodeById.has(subjectRef)) {
    connect(statement.id, subjectRef, "slot:subject");
    if (statement.state !== "superseded" && statement.state !== "rejected") {
      connectDirected(subjectRef, statement.id, `slot:${dimension.key}`);
      for (const target of aboutByStatement.get(statement.id) ?? []) {
        if (target !== subjectRef) connectDirected(statement.id, target, "core:about");
      }
    }
  }
}

function normalize(text) {
  return String(text)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sameScope(left, right) {
  return (
    left?.owner_id === right?.owner_id &&
    left?.project_id === right?.project_id &&
    left?.phase_id === right?.phase_id
  );
}

function containsPhrase(text, phrase) {
  return text === phrase || ` ${text} `.includes(` ${phrase} `);
}

function nodeLabels(node) {
  const labels = [];
  if (typeof node.value === "string") labels.push(node.value);
  if (typeof node.key === "string") labels.push(node.key);
  for (const key of ["label", "name", "canonicalName"]) {
    if (typeof node.attributes?.[key] === "string") labels.push(node.attributes[key]);
  }
  if (Array.isArray(node.attributes?.aliases)) {
    labels.push(...node.attributes.aliases.filter((item) => typeof item === "string"));
  }
  return [...new Set(labels.map(normalize).filter((label) => label.length >= 3))];
}

const labelsById = new Map(nodes.map((node) => [node.id, nodeLabels(node)]));
const entityNodes = nodes.filter(
  (node) =>
    node.type !== "core:statement" &&
    node.type !== "core:dimension" &&
    node.type !== "core:constraint",
);
const episodeText = graph
  .getAllEpisodes()
  .flatMap((episode) => episode.turns.map((turn) => turn.content))
  .join("\n");
const normalizedEpisodes = normalize(episodeText);

// Audit an invariant the graph writer can verify without another model call:
// when a live Claim value names one unique in-scope Entity, core:about should
// include that Entity. Whole-token matching avoids substring accidents such as
// the alias "USA" matching "Jerusalem".
const missingObjectLinks = [];
let linkableObjectClaims = 0;
let linkedObjectClaims = 0;
for (const statement of statements) {
  if (statement.state === "superseded" || statement.state === "rejected") continue;
  if (typeof statement.value !== "string") continue;
  const valueText = normalize(statement.value);
  const dimension = dimensions.get(statement.dimension_id);
  const subjectRef = dimension ? slotSubjectRef(dimension) : undefined;
  const matches = entityNodes
    .filter((node) => node.id !== subjectRef && sameScope(node.scope, statement.scope))
    .map((node) => {
      const label = (labelsById.get(node.id) ?? [])
        .filter((candidate) => containsPhrase(valueText, candidate))
        .sort((a, b) => b.length - a.length)[0];
      return { node, label };
    })
    .filter((candidate) => candidate.label);
  if (matches.length === 0) continue;
  const longest = Math.max(...matches.map((candidate) => candidate.label.length));
  const best = matches.filter((candidate) => candidate.label.length === longest);
  if (best.length !== 1) continue;
  linkableObjectClaims += 1;
  const target = best[0].node;
  if ((aboutByStatement.get(statement.id) ?? []).includes(target.id)) {
    linkedObjectClaims += 1;
    continue;
  }
  missingObjectLinks.push({
    statementId: statement.id,
    dimensionKey: dimension?.key,
    value: statement.value,
    targetEntityId: target.id,
    targetEntityType: target.type,
    targetEntityLabel: best[0].label,
    matchKind: valueText === best[0].label ? "exact" : "phrase",
  });
}

function cloneAdjacency(source) {
  return new Map([...source].map(([id, rows]) => [id, [...rows]]));
}

const exactRepairAdjacency = cloneAdjacency(semanticAdjacency);
const phraseRepairAdjacency = cloneAdjacency(semanticAdjacency);
for (const link of missingObjectLinks) {
  connectInto(phraseRepairAdjacency, link.statementId, link.targetEntityId, "inferred:about");
  if (link.matchKind === "exact") {
    connectInto(exactRepairAdjacency, link.statementId, link.targetEntityId, "inferred:about");
  }
}

function connectInto(target, from, to, label) {
  const rows = target.get(from) ?? [];
  rows.push({ id: to, label });
  target.set(from, rows);
}

function matchingQuestionEntities(question) {
  const normalizedQuestion = normalize(question);
  return entityNodes
    .map((node) => ({
      node,
      label: (labelsById.get(node.id) ?? [])
        .filter((candidate) => normalizedQuestion.includes(candidate))
        .sort((a, b) => b.length - a.length)[0],
    }))
    .filter((item) => item.label)
    .sort((a, b) => b.label.length - a.label.length);
}

function answerTargets(answers) {
  const normalizedAnswers = answers.map(normalize);
  const liveStatements = statements.filter(
    (statement) => statement.state !== "superseded" && statement.state !== "rejected",
  );
  const statementTargets = liveStatements.filter((statement) => {
    const text = normalize(statement.value);
    return normalizedAnswers.some((answer) => text === answer || text.includes(answer));
  });
  const entityTargets = entityNodes.filter((node) =>
    (labelsById.get(node.id) ?? []).some((label) => normalizedAnswers.includes(label)),
  );
  return { statementTargets, entityTargets };
}

function shortestPathIn(graphAdjacency, startIds, targetIds, maxDepth = 8) {
  const targets = new Set(targetIds);
  const queue = startIds.map((id) => ({ id, path: [{ id, via: "question" }] }));
  const seen = new Set(startIds);
  while (queue.length > 0) {
    const current = queue.shift();
    if (targets.has(current.id)) return current.path;
    if (current.path.length - 1 >= maxDepth) continue;
    for (const next of graphAdjacency.get(current.id) ?? []) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      queue.push({
        id: next.id,
        path: [...current.path, { id: next.id, via: next.label }],
      });
    }
  }
  return null;
}

function describePath(path) {
  return path?.map((step) => {
    const node = nodeById.get(step.id);
    return {
      id: step.id,
      type: node?.type ?? "missing",
      label: (labelsById.get(step.id) ?? [node?.key ?? step.id])[0],
      via: step.via,
    };
  });
}

const failed = evaluation.results.filter(
  (item) => item.type === "multi_hop" && item.correct === false,
);
const rows = [];
for (const item of failed) {
  const starts = matchingQuestionEntities(item.question);
  const targets = answerTargets(item.expected_answers);
  const targetIds = [
    ...targets.statementTargets.map((node) => node.id),
    ...targets.entityTargets.map((node) => node.id),
  ];
  const semanticPath = shortestPathIn(
    semanticAdjacency,
    starts.map((item) => item.node.id),
    targetIds,
  );
  const loosePath = shortestPathIn(
    adjacency,
    starts.map((item) => item.node.id),
    targetIds,
  );
  const exactRepairPath = shortestPathIn(
    exactRepairAdjacency,
    starts.map((item) => item.node.id),
    targetIds,
  );
  const phraseRepairPath = shortestPathIn(
    phraseRepairAdjacency,
    starts.map((item) => item.node.id),
    targetIds,
  );
  const capsuleClaimIds = new Set(item.capsule.claims.map((claim) => claim.id));
  const targetClaimInCapsule = targets.statementTargets.some((statement) =>
    capsuleClaimIds.has(statement.id),
  );
  const expectedInEpisode = item.expected_answers.some((answer) =>
    normalizedEpisodes.includes(normalize(answer)),
  );
  let category;
  if (targetIds.length === 0 && expectedInEpisode) category = "claim_missing";
  else if (targetIds.length === 0) category = "answer_not_in_memory";
  else if (starts.length === 0) category = "question_entity_unlinked";
  else if (!semanticPath) category = "graph_path_missing";
  else if (targetClaimInCapsule) category = "answer_failure";
  else category = "retrieval_path_missed";
  rows.push({
    id: item.id,
    question: item.question,
    expectedAnswers: item.expected_answers,
    modelAnswer: item.answer,
    category,
    questionEntities: starts.slice(0, 8).map((start) => ({
      id: start.node.id,
      type: start.node.type,
      label: start.label,
    })),
    targetStatementIds: targets.statementTargets.map((node) => node.id),
    targetEntityIds: targets.entityTargets.map((node) => node.id),
    targetClaimInCapsule,
    expectedInEpisode,
    shortestSemanticPath: describePath(semanticPath),
    shortestPathAfterExactRepair: describePath(exactRepairPath),
    shortestPathAfterPhraseRepair: describePath(phraseRepairPath),
    shortestLoosePath: describePath(loosePath),
  });
}

const counts = Object.fromEntries(
  [...new Set(rows.map((row) => row.category))]
    .sort()
    .map((category) => [category, rows.filter((row) => row.category === category).length]),
);
const report = {
  evaluation: evaluationPath,
  database: databasePath,
  failed: rows.length,
  counts,
  objectLinkAudit: {
    linkableClaims: linkableObjectClaims,
    linkedClaims: linkedObjectClaims,
    missingLinks: missingObjectLinks.length,
    exactMissingLinks: missingObjectLinks.filter((item) => item.matchKind === "exact").length,
    phraseMissingLinks: missingObjectLinks.filter((item) => item.matchKind === "phrase").length,
    missingRate:
      linkableObjectClaims === 0 ? 0 : missingObjectLinks.length / linkableObjectClaims,
    byProperty: Object.fromEntries(
      [...new Set(missingObjectLinks.map((item) => item.dimensionKey ?? "unknown"))]
        .map((key) => [key, missingObjectLinks.filter((item) => item.dimensionKey === key).length])
        .sort((left, right) => right[1] - left[1]),
    ),
    examples: missingObjectLinks.slice(0, 30),
  },
  simulatedRepair: {
    graphMissingRecoveredByExactLinks: rows.filter(
      (row) => row.category === "graph_path_missing" && row.shortestPathAfterExactRepair,
    ).length,
    graphMissingRecoveredByPhraseLinks: rows.filter(
      (row) => row.category === "graph_path_missing" && row.shortestPathAfterPhraseRepair,
    ).length,
  },
  rows,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
graph.close();
console.log(
  JSON.stringify(
    {
      failed: rows.length,
      counts,
      objectLinkAudit: report.objectLinkAudit,
      simulatedRepair: report.simulatedRepair,
      output: outputPath,
    },
    null,
    2,
  ),
);
