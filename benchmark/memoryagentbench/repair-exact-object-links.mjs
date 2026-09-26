// Backfill deterministic Claim -> Entity object links on a COPY of a run.
// No model calls are made and the source database is fingerprinted before and
// after the repair.

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
  canonicalEntityKey,
  scopesEqual,
  slotSubjectRef,
} from "../../dist/src/index.js";

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

function entitySurfaces(node) {
  return [node.key, typeof node.value === "string" ? node.value : undefined]
    .filter(Boolean)
    .map(canonicalEntityKey)
    .filter(Boolean);
}

const sourceHashBefore = sha256(sourceDb);
mkdirSync(runDir, { recursive: true });
copyFileSync(sourceDb, targetDb);
for (const name of ["run-meta.json", "source-run-meta.json"]) {
  const source = join(sourceRun, name);
  if (existsSync(source)) copyFileSync(source, join(runDir, "source-run-meta.json"));
}

const graph = new SqliteGraph(targetDb);
const nodes = graph.queryNodes({});
const dimensions = new Map(
  nodes.filter((node) => node.type === "core:dimension").map((node) => [node.id, node]),
);
const entities = nodes.filter(
  (node) =>
    node.type !== "core:dimension" &&
    node.type !== "core:statement" &&
    node.type !== "core:constraint" &&
    node.type !== "core:message" &&
    node.key,
);
const outcomes = [];
let ambiguous = 0;
for (const statement of nodes.filter((node) => node.type === "core:statement")) {
  if (statement.state === "superseded" || statement.state === "rejected") continue;
  if (typeof statement.value !== "string") continue;
  const wanted = canonicalEntityKey(statement.value);
  if (!wanted) continue;
  const dimension = dimensions.get(statement.dimension_id);
  const subjectId = dimension ? slotSubjectRef(dimension) : undefined;
  const matches = entities.filter(
    (entity) =>
      entity.id !== subjectId &&
      (scopesEqual(entity.scope, statement.scope) || scopesEqual(entity.scope, undefined)) &&
      entitySurfaces(entity).includes(wanted),
  );
  if (matches.length > 1) {
    ambiguous += 1;
    continue;
  }
  const target = matches[0];
  if (!target) continue;
  const existing = graph
    .queryEdges({ type: "core:about", from: statement.id, to: target.id })
    .find((edge) => scopesEqual(edge.scope, statement.scope));
  if (existing) continue;
  const edge = graph.addEdge({
    type: "core:about",
    from: statement.id,
    to: target.id,
    scope: statement.scope,
    attributes: { inferred_by: "exact_entity_value", backfill: true },
    created_by: "agent:edgelore:exact-link-repair",
    created_at: new Date().toISOString(),
    source_refs: statement.source_refs,
  });
  outcomes.push({
    statementId: statement.id,
    dimensionKey: dimension?.key,
    value: statement.value,
    entityId: target.id,
    entityType: target.type,
    edgeId: edge.id,
  });
}
graph.close();

const sourceHashAfter = sha256(sourceDb);
if (sourceHashAfter !== sourceHashBefore) {
  throw new Error("source database changed while repairing its copy");
}
const report = {
  sourceRun,
  runDir,
  sourceDatabaseSha256: sourceHashBefore,
  sourceUnchanged: true,
  added: outcomes.length,
  ambiguous,
  apiCalls: 0,
  outcomes,
};
writeFileSync(join(runDir, "exact-object-link-repair.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      added: report.added,
      ambiguous: report.ambiguous,
      sourceUnchanged: report.sourceUnchanged,
      apiCalls: report.apiCalls,
      report: join(runDir, "exact-object-link-repair.json"),
    },
    null,
    2,
  ),
);
