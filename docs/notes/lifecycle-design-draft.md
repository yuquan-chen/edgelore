# edgelore · M5 lifecycle design draft (DEFERRED — design frozen, implementation queued)

> Status: **design agreed 2026-09-18, implementation deferred** in favor of
> the evaluation sprint ("prove remembering works before adding more
> capabilities"). This note preserves the decisions so nothing is re-litigated.

## Core insight: memory has TWO orthogonal axes

- **Truth axis** (governed by conflict resolution): tentative / accepted /
  conflict / superseded / rejected — "what counts as true right now".
  Persistent memories can still be UPDATED by adjudication — retention does
  not mean immutability.
- **Lifecycle axis** (governed by forgetting): `persistent` vs `expiring` —
  "how long this slot/value lives". The user's classification: some memories
  never expire, some naturally do ("deliverable due Friday").

## Agreed decisions

1. **6th fact-node state `forgotten`** (user approved option A): content wiped
   to a tombstone (id / timestamps / who-forgot / reason preserved), terminal,
   never revivable. Distinct from `rejected` (judged false) and `superseded`
   (replaced) — forgetting is neither. Requires schema version bump +
   schema.json sync (the contract tests police this — documented process).
2. **Retention classification on dimensions**: `attributes.retention:
   "persistent" (default) | "expiring"`; extract may propose it on NEW:
   dimensions; KnownDimension carries it into prompts.
3. **`expires_at` optional statement field**: concrete expiry mechanism that
   works WITHOUT time-reasoning in the engine — a sweep proposes forgetting
   for expired non-persistent values.
4. **Forgetting is a governance decision, not a TTL bomb** (the same
   anti-two-extremes stance as conflict handling: industry is split between
   silent TTL and never-delete):
   - `edgelore forget <id> --by human:x --reason "..."`: commanded forgetting
     (right-to-be-forgotten), works on persistent too; tombstone + audit.
   - usage counting on retrieval hits (`usage_count` / `last_used`) feeds
     decay proposals.
   - decay sweep: touches ONLY `expiring`/expired values; proposes; hard
     purge needs human confirmation (same "escalate when unsure" philosophy
     as constraint-guided adjudication).

## Deferred to the lifecycle milestone

Implementation of all the above, the decay sweep (needs the background
runtime), retention-as-rules (needs time support in the M1 engine), and the
合成 with 后台整理/Dream (dimension alias merging).
