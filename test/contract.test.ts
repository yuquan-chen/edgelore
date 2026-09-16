// edgelore · M0 — Contract tests.
//
// These tests prove that `schema.json` (the open contract) and the TypeScript
// implementation (src/model) agree:
//   1. canonical valid objects produced by the real store MUST validate against
//      the schema (implementation -> contract).
//   2. hand-written invalid objects MUST be rejected by the schema (contract is
//      not vacuous).
//   3. the schema's declared version matches SCHEMA_VERSION in types.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AjvDefault from "ajv";
import addFormatsDefault from "ajv-formats";

import {
  MemoryGraph,
  SCHEMA_VERSION,
  type GraphNode,
  type Constraint,
  type GraphEdge,
} from "../src/model/index.js";

// ajv is a CJS package; under `module: NodeNext` the default import resolves to
// the module namespace, so we cast it to the constructor we actually need.
type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: object) => ValidateFn;
  errorsText: (errors: unknown) => string;
  errors: unknown;
};
const Ajv = AjvDefault as unknown as AjvCtor;
const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;

// Runs from dist/test/ after tsc, so the repo-root schema.json is two levels up.
const schemaPath = fileURLToPath(new URL("../../schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
  definitions: Record<string, object>;
  version: string;
};

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// Compile each definition on its own by wrapping it in a schema that re-exposes
// the shared `definitions` block and points `$ref` at the desired definition.
// `$id` is dropped so three independent compiles don't collide on the same id.
const base: Record<string, unknown> = { ...schema };
delete base.$id;
delete base.version; // non-standard keyword; not needed for validation
const wrap = (def: string): ValidateFn =>
  ajv.compile({ ...base, $ref: `#/definitions/${def}` } as object);
const validateNode = wrap("node");
const validateEdge = wrap("edge");
const validateConstraint = wrap("constraint");

const HUMAN = "human:owner";
const AGENT = "agent:claude:abc";

test("contract: schema version matches SCHEMA_VERSION", () => {
  assert.equal(schema.version, SCHEMA_VERSION);
});

test("contract: objects produced by the real store validate against schema", () => {
  const g = new MemoryGraph();

  const dim = g.addNode({
    type: "core:dimension",
    created_by: HUMAN,
    key: "design_cost",
    project_id: "P1",
  });
  const stmt = g.addNode({
    type: "core:statement",
    created_by: HUMAN,
    dimension_id: dim.id,
    value: 5000,
    unit: "CNY",
  });
  const proj = g.addNode({ type: "core:project", created_by: AGENT });
  const edge = g.addEdge({ type: "core:belongs_to", from: dim.id, to: proj.id, created_by: AGENT });
  const c = g.addConstraint({
    participants: [dim.id],
    bindings: { x1: dim.id },
    created_by: AGENT,
  });

  assert.ok(validateNode(dim), `dimension should validate: ${ajv.errorsText(validateNode.errors)}`);
  assert.ok(
    validateNode(stmt),
    `statement should validate: ${ajv.errorsText(validateNode.errors)}`,
  );
  assert.ok(validateEdge(edge), `edge should validate: ${ajv.errorsText(validateEdge.errors)}`);
  assert.ok(
    validateConstraint(c),
    `constraint should validate: ${ajv.errorsText(validateConstraint.errors)}`,
  );
});

test("contract: a constraint activated by a human still validates", () => {
  const g = new MemoryGraph();
  const c = g.addConstraint({
    participants: ["node:core:dimension:x"],
    bindings: { x1: "node:core:dimension:x" },
    created_by: AGENT,
  });
  g.transitionConstraintState(c.id, "active", { approved_by: HUMAN });
  const active = g.getConstraint(c.id)!;
  assert.ok(
    validateConstraint(active),
    `active constraint should validate: ${ajv.errorsText(validateConstraint.errors)}`,
  );
});

test("contract: invalid objects are rejected by the schema", () => {
  // missing provenance (created_by)
  const missingProv: Record<string, unknown> = {
    id: "node:core:actor:abc",
    type: "core:actor",
    updated_at: "2026-09-16T10:00:00Z",
    schema_version: "m0.1",
    state: "tentative",
    attributes: {},
    tags: [],
  };
  assert.equal(validateNode(missingProv), false);

  // type not namespaced
  const badType: Record<string, unknown> = {
    id: "node:core:actor:abc",
    type: "actor",
    created_by: HUMAN,
    created_at: "2026-09-16T10:00:00Z",
    updated_at: "2026-09-16T10:00:00Z",
    schema_version: "m0.1",
    source_refs: [],
    state: "tentative",
    attributes: {},
    tags: [],
  };
  assert.equal(validateNode(badType), false);

  // constraint with empty participants (violates minItems:1)
  const emptyParticipants: Record<string, unknown> = {
    id: "constraint:abc",
    kind: "core:constraint",
    revision_id: "constraint-revision:1",
    participants: [],
    bindings: {},
    activation_state: "proposed",
    approved_by: null,
    approved_at: null,
    created_by: AGENT,
    created_at: "2026-09-16T10:00:00Z",
    schema_version: "m0.1",
    source_refs: [],
    attributes: {},
    tags: [],
  };
  assert.equal(validateConstraint(emptyParticipants), false);
});

test("contract: an open-world (agent-namespaced) node validates", () => {
  const g = new MemoryGraph();
  const t = g.addNode({ type: "codex:task", created_by: AGENT, attributes: { priority: "high" } });
  assert.ok(validateNode(t), `codex:task should validate: ${ajv.errorsText(validateNode.errors)}`);
});

// Re-exported for clarity in the test output (no-op guard).
export type _Guard = GraphNode | Constraint | GraphEdge;
