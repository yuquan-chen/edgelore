# Graph ingestion smoke — 2026-09-23

This note records the first real LongMemEval runs of the graph-enrichment path.
The experiment used isolated SQLite databases and checkpoints; the v5 baseline
database was read only.

## 20-session smoke

Command shape:

```text
node benchmark/longmemeval/ingest.mjs --graph --limit 20 --shard graph-smoke --db <isolated.db>
```

Result:

- 157 capture requests, 155 persisted Statements (two exact deduplications)
- 117 Dimensions
- 114 entity/event nodes
- 196 edges
- zero language drops and zero API errors
- three graph-enrichment plans rejected (15%); all facts survived through the
  plain-capture fallback
- 60 API calls, 209,808 input tokens, 34,936 output tokens

The three rejected plans exposed general protocol defects: an undeclared
relation endpoint, a non-namespaced relation type, and an entity-to-entity
claim that bypassed Statement trust. The parser now skips malformed individual
relations and projects an entity-originating claim onto its unique supporting
Statement when that support is unambiguous.

The graph itself was real rather than decorative. For example, service events,
fuel economy claims, accessory purchases, and assistant recommendations all
connected through shared vehicle/product/event entities. Assistant-authored
Statements and their solely supported entities stayed tentative.

## Dimension-resolution iterations

The same first five sessions were used for the focused iterations below. Model
extraction is stochastic, so raw counts are not paired measurements; the
Dimension/Statement ratio and manual group inspection are the useful signals.

| Run | Statements | Dimensions | Ratio | Finding |
| --- | ---: | ---: | ---: | --- |
| existing v5 rows | 36 | 25 | 0.694 | clean non-graph reference |
| graph v1 | 43 | 26 | 0.605 | some reuse, but sparse key-only hints |
| graph v2 | 33 | 15 | 0.455 | strong consolidation, unacceptable topical over-merging |
| graph v3 | 37 | 19 | 0.514 | safer, but newly invented catch-all Dimensions remained |
| graph v4 | 31 | 21 | 0.677 | conservative grouping; inspected multi-value groups were coherent |

The useful v2 change was giving the organizer up to two real values for each
candidate Dimension, not only its key and description. The dangerous effect
was treating a Dimension as a topic bucket. Examples included purchases,
moving a friend, and GPS features under one car-related key.

The final guard treats a Dimension as a reusable predicate/question. Any key
remap—whether reusing an existing Dimension or proposing a new shared one—must
have compatible key roots. Compatible event-specific drift such as
`familyTripHawaii -> familyTrips` is allowed; unrelated topical collapse such
as `dataVizCommunicationTips -> productivityStrategies` is rejected. The
original extraction key is kept on uncertainty, because a later evidence-based
merge is recoverable while a false merge immediately damages retrieval.

## Epistemic-edge finding

One real run produced six false `core:contradicts` edges between compatible or
refining statements (for example two equivalent 32-mpg claims). Therefore graph
organization is now forbidden from writing `core:contradicts`, `core:refines`,
or `core:supersedes`. Those relations require a separate governed FactReconciler
with deterministic checks first and Agent judgment only for ambiguous cases.

## FactReconciler proposal-only dry run

The first governed reconciler pass used ten relation-dense groups from the
20-session graph database. It generated proposals without applying any of
them, then compared every node state/update timestamp and every edge before
and after the run. The graph fingerprint was unchanged.

- 10 successful model calls, zero endpoint errors
- 25 proposals: 15 independent, 4 duplicate, 2 refines, 1 supersedes, and
  4 contradicts
- a direction ambiguity (`new refines old` when only the old candidate carried
  the extra date) was reproduced and fixed by explicitly defining every
  relation as New Statement -> Candidate
- shared generic entities were too broad as reconciliation evidence: a car
  insurance Statement was compared with mileage, waxing, and interior-care
  Statements merely because they all referred to the same car
- repeatable events need stricter temporal identity: two trips to different
  destinations were not stable between `independent` and `contradicts`

The run therefore validated the proposal-only governance boundary while also
showing that typed structural relations are needed before widening candidate
generation beyond the same Dimension.

## Next capability work

1. Add the FactReconciler (`duplicate | refines | supersedes | contradicts |
   independent`) without coupling it to entity extraction.
2. Add graph-aware retrieval around shared event/entity nodes; the current
   answering path remains Dimension-first, so the new edges cannot yet improve
   the benchmark materially.
3. Run a larger isolated ingest only after those readers exist. Measuring score
   before graph-aware retrieval would mostly measure storage overhead, not the
   graph capability.
