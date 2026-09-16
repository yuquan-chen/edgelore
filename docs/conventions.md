# edgelore — Coding Conventions

> Status: **adopted (M0)**. This document is the development constitution for
> edgelore. Every module MUST follow it. A deviation requires explicit
> discussion and sign-off before it lands.

## 1. Scope & Philosophy

- Code is a contract between agents. Readability, explicit types, and
  stability of core semantics matter more than cleverness.
- Core semantic fields (e.g. `state`) stay **small** and **stable**;
  extension goes into open `attributes` / `tags`
  (*narrow state + wide metadata* — M0 spec §1.3). Never add a new `state`
  value to express a business detail.
- No code is committed without review (project rule). The assistant never
  commits or pushes on its own.

## 2. Language of Comments & Docs

- All code comments, JSDoc blocks, and `docs/` files are written in
  **English**.
- (Code identifiers are English by convention regardless of this rule.)

## 3. Naming

| What | Style | Example |
|------|-------|---------|
| Files & directories | `kebab-case` | `state-machine.ts`, `memory-graph.ts` |
| Types / Interfaces / Classes / Enums | `PascalCase` | `GraphNode`, `MemoryGraph`, `FactNodeState` |
| Functions / variables / constants | `camelCase` | `addNode`, `createdBy` |
| Generic type parameters | `T` / `K` / `V` or `TNode` | `class Repo<TNode>` |
| Module-level constant maps | `UPPER_SNAKE_CASE` | `FACT_STATE_TRANSITIONS` |

Multi-word file names MUST use hyphens — never `statemachine.ts`.

## 4. Type Annotations (the `->` equivalent)

- Every **exported** function MUST declare explicit parameter types AND a
  return type. This is the direct TS equivalent of Python's
  `def f(x: int) -> str`.

  ```ts
  /**
   * Move a constraint from `proposed` to `active`; requires a human approver.
   * @param id constraint node id
   * @param approver must be a `human:<id>` principal (Q01 gate)
   * @returns the updated constraint
   * @throws ModelError if approver is not human, or the transition is illegal
   */
  transitionConstraintState(id: string, approver: string): Constraint
  ```

- **No `any`.** Use `unknown` + narrowing, or concrete types.
  (ESLint: `@typescript-eslint/no-explicit-any` = error.)
- Prefer `interface` for data shapes (extensible); use `type` for unions
  and literal sets.
- Internal / private helpers MAY rely on inference, but prefer explicit
  return types for non-trivial logic.

## 5. Documentation (JSDoc on every export)

Every exported function, class, interface, and enum gets a JSDoc block:

- one-line purpose;
- `@param` for each parameter (name + meaning);
- `@returns` for the return value;
- `@throws` for every typed error it can raise and the condition.

See the example in §4. Comments explain *why*, not *what* the code already says.

## 6. Imports (NodeNext rule — critical)

The project compiles with `"module": "NodeNext"`. Relative imports MUST
carry the `.js` extension even though the source file is `.ts`:

```ts
import { MemoryGraph } from "./memory-graph.js"; // correct
import { MemoryGraph } from "./memory-graph";      // WRONG — breaks at runtime
```

- Group imports: Node builtins → external packages → internal (`./`),
  each group separated by a blank line.
- No circular imports. If two modules need each other, extract the shared
  type / logic into a third module.

## 7. Error Handling

- Throw **typed errors** (`ModelError` and its subclasses), never raw
  strings.
- Do not use `console.error` as control flow.
- Each public method documents via `@throws` which typed error and under
  what condition.

## 8. Directory Structure

```
src/
  model/     # M0 data model: types, identifiers, state machine, store
  engine/    # M1 constraint expression engine (planned)
  store/     # persistence adapters — SQLite default, graph DB later (planned)
  mcp/       # MCP server exposing the graph to agents (planned)
test/
  unit/      # per-module logic tests (node:test)
  contract/  # schema.json <-> types.ts consistency tests (Ajv)
docs/        # specs, conventions, design notes
```

New modules go under the matching `src/` subdir; their tests go under the
matching `test/` subdir.

## 9. Testing (dual-track)

- **Unit tests** (`test/unit/`): exercise each module's own logic in
  isolation.
- **Contract tests** (`test/contract/`): assert that objects produced by
  the store pass `schema.json` validation (Ajv) AND that `SCHEMA_VERSION`
  matches the schema's declared version. This keeps the open contract in
  lock-step with the TS types — the whole point of the contract layer.
- Every new module MUST ship a unit test, and (if it emits persisted-shaped
  objects) a contract test.
- Runner: Node 22 built-in `node:test` + `tsc`. Zero runtime test deps.

## 10. Commits

- Conventional Commits with a scope tag:
  `feat(M0):`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- The assistant does NOT `commit` / `push` without explicit user approval.

## 11. Tooling (mechanical enforcement)

- **ESLint** + **typescript-eslint** for static analysis.
- **Prettier** for formatting; **eslint-config-prettier** disables the
  style rules that would otherwise fight Prettier.
- Recommended (tunable) ESLint rules:
  - `@typescript-eslint/no-explicit-any`: `error`
  - `@typescript-eslint/explicit-function-return-type` (or
    `explicit-module-boundary-types` scoped to exports): `error`
  - `@typescript-eslint/no-floating-promises`: `error`
  - `no-unused-vars`: `error`
- Config files (`eslint.config.mjs`, `.prettierrc`) are added when the
  tooling is installed. Until then, this document is the manual standard.

## 12. Locked Decisions (this session)

1. **Comments / docs language:** English.
2. **File naming:** `kebab-case` (includes renaming
   `statemachine.ts` → `state-machine.ts`).
3. **Enforcement tooling:** ESLint + Prettier.
