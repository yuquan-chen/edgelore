// edgelore · subject/property Slot Resolver dry run.
//
// Reads a completed graph-ingestion database and asks a focused resolver to
// propose (subject, Property) coordinates for real Claims that already have
// core:about entity candidates. It never mutates the graph.
//
// Usage:
//   node benchmark/longmemeval/slot-resolver-dry-run.mjs --db <memory.db>
//   node benchmark/longmemeval/slot-resolver-dry-run.mjs --limit 30 --out <report.json>


import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  parseJsonReply,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const limit = Number(option("--limit", "30"));
if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");

const defaultRun = join(here, "data", "runs", "v7-slot-episode-onepass-20260923");
const dbPath = resolve(option("--db", join(defaultRun, "memory.db")));
const outputPath = resolve(option("--out", join(defaultRun, `slot-resolver-probe-${limit}.json`)));

const { cfg } = boot();
const driver = requireChat(cfg, {
  maxTokens: 8000,
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
  const episodes = graph.getAllEpisodes().map((episode) => episode.id).sort();
  return JSON.stringify({ nodes, edges, episodes });
}

function transcriptOf(episode) {
  return episode.turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
}

function tokenize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

function relevantProperties(catalog, text, max = 40) {
  const wanted = new Set(tokenize(text));
  return [...catalog.values()]
    .map((property) => {
      const tokens = tokenize(`${property.key} ${property.description} ${property.samples.join(" ")}`);
      const overlap = tokens.reduce((score, token) => score + (wanted.has(token) ? 1 : 0), 0);
      return { ...property, overlap };
    })
    .filter((property) => property.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.uses - a.uses || a.key.localeCompare(b.key))
    .slice(0, max)
    .map(({ overlap: _overlap, ...property }) => property);
}

function candidateSessions() {
  const statements = new Map(
    graph.queryNodes({ type: "core:statement" }).map((statement) => [statement.id, statement]),
  );
  const bySource = new Map();
  for (const edge of graph.queryEdges({ type: "core:about" })) {
    const statement = statements.get(edge.from);
    const entity = graph.getNode(edge.to);
    if (!statement || !entity || entity.type === "core:statement" || entity.type === "core:dimension") continue;
    const sourceId = statement.source_refs[0];
    if (!sourceId || !graph.getEpisode(sourceId)) continue;
    const session = bySource.get(sourceId) ?? new Map();
    const item = session.get(statement.id) ?? { statement, entities: new Map() };
    item.entities.set(entity.id, entity);
    session.set(statement.id, item);
    bySource.set(sourceId, session);
  }

  return [...bySource.entries()]
    .map(([sourceId, claims]) => {
      const items = [...claims.values()];
      const entityTypes = new Set(items.flatMap((item) => [...item.entities.values()].map((e) => e.type)));
      return {
        sourceId,
        claims: items,
        score: items.length * 10 + entityTypes.size,
        entityTypes: [...entityTypes].sort(),
      };
    })
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
}

function makePrompt(session, catalog) {
  const episode = graph.getEpisode(session.sourceId);
  const entityRefs = new Map();
  let nextEntity = 1;
  const claims = session.claims.map((item, index) => {
    const dimension = graph.getNode(item.statement.dimension_id);
    const candidates = [...item.entities.values()].map((entity) => {
      let ref = entityRefs.get(entity.id);
      if (!ref) {
        ref = `e${nextEntity++}`;
        entityRefs.set(entity.id, ref);
      }
      return { ref, type: entity.type, key: entity.key, value: entity.value };
    });
    return {
      ref: `c${index + 1}`,
      currentPropertyKey: dimension?.key ?? "unknown",
      value: item.statement.value,
      saidBy: item.statement.saidBy ?? null,
      candidateSubjects: candidates,
    };
  });
  const text = claims.map((claim) => `${claim.currentPropertyKey} ${JSON.stringify(claim.value)}`).join(" ");
  const known = relevantProperties(catalog, text);

  const prompt = [
    "You are a Slot Resolver for a personal memory graph. Facts are already extracted; never add, drop, merge, or rewrite a Claim.",
    "For every Claim, first classify its ownershipKind, then choose exactly two semantic coordinates: its subject and a reusable Property.",
    "A Slot is (subject, Property, scope). A Property is a reusable question/category, not an entity, event, brand, destination, date, or fact identity.",
    "ownershipKind must be exactly one of: ownerMemory, intrinsicProperty, eventAttribute, relational, comparison.",
    "intrinsicProperty means one entity's identity, specification, capacity, public offering, or current state that remains true if the memory owner changes. eventAttribute means one occurrence's own date, location, route, participants, or outcome. Only these two kinds may use an entity subject.",
    "ownerMemory covers the owner's actions, acquisitions, usage, experiences, preferences, plans, personal status, and recommendations addressed to the owner. relational covers ownership, membership, residence, employment, family, routes between places, and other truths requiring two endpoints. comparison covers a Claim whose truth compares peer entities. These three kinds MUST use $scopeOwner in the current unary Slot model; later Relation/Constraint processing preserves their other endpoints.",
    "Do not turn an owner verb such as bought, set up, lives in, plans, tried, reached, uses, or wants into an entity attribute merely because the Claim mentions an object. A personal status in a program belongs to the owner; the program's published qualification rule may belong to the program.",
    "If a Claim needs two people/entities to remain complete (including twins, a comparison, or a route from one place to another), it cannot be an intrinsic property of one endpoint. Use relational or comparison and $scopeOwner.",
    "For events, use the event as subject only for the event's own attributes; the owner's participation, experience, plan, or advice remains ownerMemory. General public documentation may be intrinsicProperty, but personalized recommendations stay ownerMemory.",
    "A non-owner subject must be the single complete semantic subject and one of that Claim's candidateSubjects. When uncertain, use $scopeOwner. core:about does not imply Slot ownership.",
    "Counterexamples: 'I reached Gold status in Program X' is ownerMemory with Property membershipStatus; 'Program X requires 50k points for Gold' is intrinsicProperty with Property qualificationRequirements. 'I plan to add a feature to Device X' is ownerMemory; 'Device X has 10-hour capacity' is intrinsicProperty. 'A and B differ in weight' is comparison, not a property of A alone.",
    "Property rule: output lowerCamelCase beginning with a letter. Remove entity identity and incidental details. Preserve the exact semantic question; do not create vague catch-alls.",
    "Property keys must survive substitution of another subject: use travelPlans rather than planningParisTrip, birthDate rather than aliceBirthDate, currentPromotions rather than targetPromotions, and careRequirements rather than peaceLilyCareRequirements.",
    "Reuse a Known Property only when it asks the same question. Otherwise create a precise reusable key. Different subjects may share the same Property without sharing a Slot.",
    "confidence is high only when both subject ownership and Property meaning are explicit in the Claim/evidence; otherwise medium or low.",
    `Known Properties created earlier in this dry run:\n${known.length ? JSON.stringify(known) : "(none)"}`,
    `Claims to resolve:\n${JSON.stringify(claims)}`,
    `Source Episode (evidence only):\n${transcriptOf(episode)}`,
    `Return ONLY one JSON object:
{
  "decisions": [
    {
      "claimRef": "c1",
      "ownershipKind": "ownerMemory or intrinsicProperty or eventAttribute or relational or comparison",
      "subjectRef": "$scopeOwner or one candidate eN",
      "propertyKey": "lowerCamelCase",
      "propertyDescription": "one short subject-free definition",
      "cardinality": "single or multi",
      "confidence": "high or medium or low",
      "reason": "short ownership explanation"
    }
  ]
}`,
  ].join("\n\n");
  return { prompt, claims, entityRefs };
}

function normalizeReply(raw, promptData, session) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.decisions)) {
    throw new Error("resolver reply must contain a decisions array");
  }
  const expected = new Map(promptData.claims.map((claim, index) => [claim.ref, { claim, item: session.claims[index] }]));
  const seen = new Set();
  const decisions = [];
  for (const value of raw.decisions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decision must be an object");
    const claimRef = typeof value.claimRef === "string" ? value.claimRef : "";
    const target = expected.get(claimRef);
    if (!target || seen.has(claimRef)) throw new Error(`unknown or duplicate claimRef: ${claimRef}`);
    seen.add(claimRef);
    const allowedSubjects = new Map(
      target.claim.candidateSubjects.map((entity) => [entity.ref, entity]),
    );
    const allowedKinds = new Set([
      "ownerMemory",
      "intrinsicProperty",
      "eventAttribute",
      "relational",
      "comparison",
    ]);
    const ownershipKind = typeof value.ownershipKind === "string" ? value.ownershipKind : "";
    if (!allowedKinds.has(ownershipKind)) {
      throw new Error(`invalid ownershipKind for ${claimRef}: ${ownershipKind}`);
    }
    const rawSubjectRef = typeof value.subjectRef === "string" ? value.subjectRef : "";
    if (rawSubjectRef !== "$scopeOwner" && !allowedSubjects.has(rawSubjectRef)) {
      throw new Error(`invalid subjectRef for ${claimRef}: ${rawSubjectRef}`);
    }
    const entityKind = ownershipKind === "intrinsicProperty" || ownershipKind === "eventAttribute";
    const subjectRef = entityKind ? rawSubjectRef : "$scopeOwner";
    if (entityKind && subjectRef === "$scopeOwner") {
      // Conservative is legal when the graph lacks the one complete subject.
    }
    let propertyKey = typeof value.propertyKey === "string" ? value.propertyKey.trim() : "";
    if (/^new:/i.test(propertyKey)) propertyKey = propertyKey.slice(propertyKey.indexOf(":") + 1);
    if (!/^[a-z][a-zA-Z0-9]*$/.test(propertyKey)) {
      throw new Error(`invalid propertyKey for ${claimRef}: ${propertyKey}`);
    }
    const confidence = ["high", "medium", "low"].includes(value.confidence)
      ? value.confidence
      : "low";
    const cardinality = value.cardinality === "single" ? "single" : "multi";
    const subjectEntity = allowedSubjects.get(subjectRef);
    const actualSubjectId = subjectEntity
      ? [...target.item.entities.values()].find((entity) => entity.type === subjectEntity.type && entity.key === subjectEntity.key)?.id
      : "$scopeOwner";
    decisions.push({
      claimRef,
      claimId: target.item.statement.id,
      sourceId: session.sourceId,
      currentDimensionId: target.item.statement.dimension_id,
      currentPropertyKey: target.claim.currentPropertyKey,
      value: target.item.statement.value,
      saidBy: target.item.statement.saidBy ?? null,
      ownershipKind,
      rawSubjectRef,
      subjectRef,
      policyFallback: rawSubjectRef !== subjectRef,
      actualSubjectId,
      ...(subjectEntity ? { subjectEntity } : {}),
      propertyKey,
      propertyDescription:
        typeof value.propertyDescription === "string" ? value.propertyDescription.trim() : propertyKey,
      cardinality,
      confidence,
      reason: typeof value.reason === "string" ? value.reason.trim() : "",
    });
  }
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].filter((ref) => !seen.has(ref));
    throw new Error(`resolver omitted Claims: ${missing.join(", ")}`);
  }
  return decisions;
}

function updateCatalog(catalog, decisions) {
  for (const decision of decisions) {
    const existing = catalog.get(decision.propertyKey) ?? {
      key: decision.propertyKey,
      description: decision.propertyDescription,
      cardinality: decision.cardinality,
      samples: [],
      uses: 0,
    };
    existing.uses += 1;
    if (existing.samples.length < 3) existing.samples.push(String(decision.value));
    catalog.set(existing.key, existing);
  }
}

const before = graphFingerprint();
const selected = candidateSessions().slice(0, limit);
const catalog = new Map();
const results = [];
console.log(`Slot Resolver dry run: ${selected.length} real sessions from ${dbPath}`);

for (const [index, session] of selected.entries()) {
  const promptData = makePrompt(session, catalog);
  try {
    const reply = parseJsonReply(await driver.complete(promptData.prompt));
    const decisions = normalizeReply(reply, promptData, session);
    updateCatalog(catalog, decisions);
    results.push({ sourceId: session.sourceId, entityTypes: session.entityTypes, decisions });
    const entityBound = decisions.filter((decision) => decision.subjectRef !== "$scopeOwner").length;
    console.log(`[${index + 1}/${selected.length}] ${session.sourceId}: ${entityBound}/${decisions.length} entity-bound`);
  } catch (error) {
    results.push({
      sourceId: session.sourceId,
      entityTypes: session.entityTypes,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`[${index + 1}/${selected.length}] ${session.sourceId}: ERROR`);
  }
}

const after = graphFingerprint();
if (after !== before) {
  graph.close();
  throw new Error("dry-run invariant violated: graph changed while generating proposals");
}

const decisions = results.flatMap((result) => result.decisions ?? []);
const propertyUses = {};
for (const decision of decisions) {
  propertyUses[decision.propertyKey] = (propertyUses[decision.propertyKey] ?? 0) + 1;
}
const summary = {
  sessionsRequested: selected.length,
  sessionsSucceeded: results.filter((result) => !result.error).length,
  sessionsFailed: results.filter((result) => result.error).length,
  claimsResolved: decisions.length,
  ownerBound: decisions.filter((decision) => decision.subjectRef === "$scopeOwner").length,
  entityBound: decisions.filter((decision) => decision.subjectRef !== "$scopeOwner").length,
  rawEntityBound: decisions.filter((decision) => decision.rawSubjectRef !== "$scopeOwner").length,
  policyFallbacks: decisions.filter((decision) => decision.policyFallback).length,
  highConfidenceEntityBound: decisions.filter(
    (decision) => decision.subjectRef !== "$scopeOwner" && decision.confidence === "high",
  ).length,
  changedPropertyKey: decisions.filter(
    (decision) => decision.propertyKey !== decision.currentPropertyKey,
  ).length,
  uniqueProposedProperties: Object.keys(propertyUses).length,
  reusedProposedProperties: Object.values(propertyUses).filter((uses) => uses > 1).length,
};
const report = {
  generatedAt: new Date().toISOString(),
  database: dbPath,
  graphUnchanged: true,
  summary,
  propertyUses,
  usage: usageTotals(),
  results,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
graph.close();

console.log(JSON.stringify(summary, null, 2));
console.log(`graph unchanged: yes`);
console.log(
  `API usage: ${report.usage.calls} calls, ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens, ${report.usage.errors} errors`,
);
console.log(`report: ${outputPath}`);
