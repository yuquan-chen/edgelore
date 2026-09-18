---
name: edgelore-memory
description: Persistent project memory via edgelore. Use BEFORE answering questions that may depend on previously stored project facts (decisions, preferences, constraints, budgets, lessons), and WHENEVER the user states facts worth remembering across sessions. Also use to check and resolve conflicting memories.
---

# edgelore persistent memory

This project keeps a durable memory graph (SQLite) with conflict detection,
rule checking, and human adjudication. Two access paths exist — prefer MCP
tools when the `edgelore` MCP server is connected; otherwise use the CLI via
Bash. Never store small talk, transient states ("I'm tired today"), or full
documents (store a reference + the key facts instead).

## When to recall (read)

- Before starting a task that touches budget, ownership, tech-stack, SLA, or
  anything a previous session may have decided.
- Before asserting a fact you did not learn in this conversation.

```bash
# MCP: memory_search { "query": "<topic>" }
node dist/src/cli.js search "<topic>" --db edgelore.db
```

If a hit shows `competing:` values or a conflicted dimension, check the
docket before relying on it:

```bash
# MCP: memory_conflicts {}
node dist/src/cli.js conflicts --db edgelore.db
```

## When to remember (write)

Store when the user states something durable: decisions ("we use PostgreSQL"),
preferences ("answer in Chinese"), constraints ("budget <= 5000"), facts
("owner is charles"), lessons ("mock tests missed the real DB migration —
always verify with a real instance").

```bash
# MCP: memory_remember { "text": "<the user's words, verbatim>" }
node dist/src/cli.js remember "<the user's words>" --db edgelore.db --created-by human:<owner>
```

Do NOT store: greetings, transient states, information equivalent to what is
already stored (dedup is automatic), guesses.

## When memories conflict

A single-value dimension can hold one accepted truth; a contradicting
statement is flagged `conflict` and waits for adjudication:

```bash
# MCP: memory_autoresolve { "dimensionId": "<id>" }
node dist/src/cli.js autoresolve "<dimension-id>" --db edgelore.db
```

If it reports `escalated`, tell the user both values and ask them to decide;
then resolve explicitly (human adjudication is required):

```bash
# MCP: memory_resolve { "dimensionId", "winnerStatementId", "note" }
node dist/src/cli.js resolve "<dimension-id>" "<winner-statement-id>" --by human:<owner> --db edgelore.db
```

## Notes

- Memory content stays in the speaker's language; keys are English.
- Never fabricate provenance — the system records authorship automatically.
- Full documents are not memories: summarize them, store the key facts, and
  reference the document location.
