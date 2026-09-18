# edgelore · Conflicts — listing & adjudication (technical note)

> Companion note for the conflict resolution layer. Written after build.
> Closes the core loop: capture flags conflicts (M3) → retrieval surfaces
> their posture → this module lets humans (or rules) settle them.

## 1. What shipped

| File | Role |
|------|------|
| `src/agent/conflicts.ts` | `listConflicts` (the docket), `resolveConflict` (human adjudication), `autoResolveConstraintGuided` (constraint-engine-as-referee) |
| `src/cli.ts` | `conflicts` / `resolve <dim> <stmt> --by human:x [--note t]` / `autoresolve <dim>` |

## 2. The contract

```ts
interface ConflictCase {
  dimensionId: string; dimensionKey: string;
  incumbents:  ConflictStatement[]; // accepted — what the graph believes
  challengers: ConflictStatement[]; // tentative — awaiting adjudication
}
resolveConflict(graph, dimensionId, winnerStatementId, { resolvedBy, note })
  → { dimensionId, dimensionKey, winnerId, supersededIds }
autoResolveConstraintGuided(graph, dimensionId)
  → { status: "resolved" | "escalated", reason, result? }
```

Mechanics of `resolveConflict`:
- winner → `accepted`; every other live statement → `superseded` (terminal,
  history preserved); dimension → `accepted`.
- **Audit = M0-native**: one `core:supersedes` edge (winner → loser) per
  superseded statement; the edge's mandatory provenance records WHO resolved
  (`created_by`) and WHEN (`created_at`); the rationale rides in edge
  attributes. Zero new state values, zero schema change.
- Governance: `resolvedBy` MUST be `human:<id>` — the resolution primitive
  never lets an agent self-adjudicate.

## 3. Constraint-guided auto resolution (the moat, assembled)

`autoResolveConstraintGuided` lets the M1 engine referee a conflict:

1. Collect active constraints bound to exactly this dimension (single-
   dimension rules only — per-candidate hypotheticals are unsound otherwise).
2. Evaluate each candidate in isolation against each rule, using a
   **throwaway scratch graph** (the original human approval carries over to
   the rebuilt constraint, keeping Q01 intact).
3. If exactly one candidate SATISFIES while the others are violated → the
   rule decides. If no rule separates the candidates → **escalate**, the
   conflict stays pending. The referee only blows the whistle when the rules
   are unambiguous.

**Governance attribution**: the resolution is attributed to the human who
approved the arbitrating constraint — their Q01 activation of the rule IS
the standing pre-authorization to reject rule-violating values. (First
implementation attempt attributed it to `agent:edgelore:*` and the
resolution primitive's human-check correctly rejected it — the test caught
the design contradiction before it shipped.)

## 4. Validation (live, real data)

- Human resolution on the drift-db case (`owner`: charles accepted vs alice
  tentative): docket shows both sides with authorship + timestamps; resolve
  with `--by human:charles --note "价格以最新为准"` → alice accepted,
  charles superseded, dimension restored.
- Constraint-guided demo: budget 5000 vs 8000 clash under active
  `avg(预算) <= 6000` → `status: resolved`, reason: `"预算不超 6000" decides
  — 5000 satisfied; others: 8000=violated`; final state 5000 accepted /
  8000 superseded.
- Suite: 126 tests green (11 new), build + lint clean.

## 5. Open items carried forward

- **M1 state-aware aggregation** (long-deferred): `evaluate` still counts
  superseded statements, so the demo's constraint reads `violated` even
  after the violating value was superseded. Filtering by statement state is
  the fix and would make post-resolution verdicts clean.
- **Runtime policy hook**: the `resolutionPolicy` switch (human default /
  auto) becomes meaningful once the trigger layer invokes the pipeline
  automatically; today the host chooses which command to call.
- **后台整理 / Dream sweep**: merging drifted dimension keys and periodic
  consolidation shares machinery with this module.
- Escalation queue UX: `listConflicts` is the query; notification/reporting
  is host-side.
