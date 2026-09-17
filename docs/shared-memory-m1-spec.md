# edgelore · M1 — Constraint Expression Engine (FROZEN)

> M0 froze the data model and reserved `Constraint.expression` as an opaque
> `ExpressionNode`. **M1 gives that field semantics**: a whitelisted AST
> evaluator that turns a constraint body into one of four decision states.
>
> Companion technical note: [`docs/notes/m1.md`](./notes/m1.md).

## 1. Goal

Make `Constraint.expression` evaluable against the live graph so an agent can ask
*"is rule R currently satisfied, violated, or not-yet-decidable?"* without
writing ad-hoc logic. M1 is the **calculator**; the store is the **clerk** that
hands it real data.

## 2. The four decision states (narrow state, wide metadata)

| State | Meaning | Cause |
|-------|---------|-------|
| `satisfied` | rule body evaluates to **true** | comparison/logic holds |
| `violated` | rule body evaluates to **false** | comparison/logic fails |
| `indeterminate` | **data needed to decide is missing** | an aggregation over an empty dimension, or any missing ref feeding a comparison |
| `error` | **the expression itself is malformed** | operator outside the whitelist, type mismatch, division by zero, top-level non-boolean, undeclared binding |

**Propagation rules (critical):**

- **Missing data dominates downward as `indeterminate`.** If `avg(x1)` is
  indeterminate (no statements yet), then `avg(x1) <= 5000` is also
  `indeterminate` — **never** misjudged as `violated`. A rule is only ever
  called "violated" when we actually have the data to prove it fails.
- **Error dominates everything.** A malformed sub-tree fails the whole
  expression. Error means *the author wrote a bad rule*; it is unrecoverable and
  must be surfaced, not silently swallowed.

The distinction `indeterminate` (environment: data not here yet, recoverable) vs
`error` (authoring bug, unrecoverable) is the core design commitment of M1.

## 3. The D09 operator whitelist (closed contract)

This is the **complete** set of operators M1 understands. Anything outside this
table is rejected with `error`. Adding an operator is a schema-versioned change,
never a silent extension.

| Category | Operator | Arity | Operand type | Notes |
|----------|----------|-------|--------------|-------|
| Arithmetic | `+ - * /` | 2 | number | `/` by zero → `error` |
| Comparison | `< <= > >= == !=` | 2 | number | yields boolean |
| Logical | `and or` | 2 | boolean | short-circuit not required |
| Logical | `not` | 1 | boolean | |
| Aggregation | `sum avg min max count` | 1 (exactly one `{ref}`) | number[] | over a bound dimension's statements |

### 3.1 Expression grammar (enforced)

```
ruleBody(boolExpr) := comparison(numExpr, numExpr)
                    | boolExpr and/or boolExpr
                    | not(boolExpr)

numExpr  := numberLiteral
          | aggregation(ref)
          | numExpr arithmetic numExpr

aggregation := { op: sum|avg|min|max|count, args: [ {ref: name} ] }
ref        := { ref: bindingName }   // name MUST exist in constraint.bindings
```

- The **top level MUST be a boolean expression** (comparison / logical / not).
  A rule body that resolves to a bare number (e.g. `avg(x1)` instead of
  `avg(x1) <= 5000`) is an `error` — the author forgot the predicate.
- **Aggregation takes exactly one `{ref}`**, never a literal or nested node.
- A bare `{ref}` used **outside** an aggregation is `error` (it is not a value
  on its own).

## 4. Engine API (`src/engine/evaluate.ts`)

```ts
export type EvaluationResult = "satisfied" | "violated" | "indeterminate" | "error";

export interface EvalContext {
  // Map a binding name (e.g. "x1") to the numeric values that dimension
  // currently holds. Returns null = undeclared binding (error);
  // [] = no data yet (indeterminate).
  resolveRef: (name: string) => number[] | null;
}

export function evaluate(expr: ExpressionNode, ctx: EvalContext): EvaluationResult;
```

The engine is **graph-agnostic** — it never imports the store. This keeps it a
pure, trivially testable function and is why `indeterminate`/`error` are decided
here rather than in the data layer.

## 5. Store wiring (`MemoryGraph.evaluateConstraint`, `src/model/store.ts`)

```ts
evaluateConstraint(id: string): EvaluationResult
```

Behavior:

1. Look up the constraint; throw `ModelError` if absent.
2. If `expression` is absent → `error` (nothing to evaluate).
3. Build an `EvalContext` whose `resolveRef(name)`:
   - maps `name` → the dimension id via `constraint.bindings[name]`;
   - returns `null` if `name` is **not** a declared binding (→ `error`);
   - collects the `value` of every `core:statement` node whose
     `dimension_id` equals that dimension id, keeping only `number` values;
   - returns `[]` when there are no numeric statements (→ `indeterminate`).
4. Delegate to `evaluate(expression, ctx)`.

**Deliberate M1 scope boundary:** aggregation reads **all** statements of a
dimension regardless of their `state` (accepted/tentative/conflict/rejected).
State-aware aggregation (e.g. "only count `accepted` statements") is a documented
future refinement, flagged here so it is not silently assumed.

## 6. What M1 explicitly does NOT do (deferred)

- **Persistence (SQLite).** In-memory store only; the pluggable storage
  interface stays as-designed for a later milestone.
- **MCP server.** No agent-facing protocol yet.
- **Hyperedge visualization.** Out of scope; the data model already carries the
  N-ary `participants`.
- **State-aware aggregation**, **more operators** (`abs`, `mod`, `median`,
  `stddev`), **unit-aware comparison** — deferred; the whitelist is the gate.

## 7. Test contract

`test/engine.test.ts` (dual-track: pure-engine + store-wired) covers:

- all four states, including missing-data propagation through `and`/`or`;
- whitelist rejection of an unknown operator;
- division-by-zero → `error`;
- top-level numeric body → `error`;
- bare ref outside aggregation → `error`;
- undeclared binding → `error`;
- `sum` / `count` / `avg` aggregation correctness;
- full `evaluateConstraint` flow (satisfied / violated / indeterminate / no-
  expression / unknown-id).

`schema.json` already permits `expression` (object), so the contract test
(`test/contract.test.ts`) needs no change and still passes.
