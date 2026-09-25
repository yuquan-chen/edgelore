// EdgeLore · MemoryAgentBench Conflict Resolution evaluation.
// Uses the official substring exact-match metric; no judge call is required.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraph,
  SqliteVectorStore,
  buildAskPrompt,
  embeddingDriver,
  recall,
  usageTotals,
} from "../../dist/src/index.js";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const runDirArg = argValue("--run-dir");
if (!runDirArg) throw new Error("--run-dir is required");
const runDir = resolve(runDirArg);
const datasetPath = resolve(argValue("--dataset") ?? join(here, "data", "conflict-6k.json"));
const databasePath = join(runDir, "memory.db");
if (!existsSync(datasetPath) || !existsSync(databasePath)) {
  throw new Error("dataset or completed memory database is missing");
}
const perType = Number(argValue("--per-type") ?? 5);
if (!Number.isInteger(perType) || perType < 1 || perType > 100) {
  throw new Error("--per-type must be an integer from 1 to 100");
}
const recallOnly = args.includes("--recall-only");
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const allQuestions = [
  ...dataset.questions.single_hop
    .map((item) => ({ ...item, type: "single_hop" })),
  ...dataset.questions.multi_hop.map((item) => ({ ...item, type: "multi_hop" })),
];
const selectedIds = new Set(
  (argValue("--ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const questions =
  selectedIds.size > 0
    ? allQuestions.filter((item) => selectedIds.has(item.id))
    : [
        ...allQuestions.filter((item) => item.type === "single_hop").slice(0, perType),
        ...allQuestions.filter((item) => item.type === "multi_hop").slice(0, perType),
      ];
if (selectedIds.size > 0 && questions.length !== selectedIds.size) {
  throw new Error("one or more --ids values were not found in the dataset");
}
const { cfg } = boot();
const graph = new SqliteGraph(databasePath);
const scope = {
  owner_id: "actor:memoryagentbench",
  project_id: "factconsolidation-6k",
  phase_id: "history",
};
const sessionIds = graph.getAllEpisodes().map((episode) => episode.id);
const retrieval = cfg.embedding
  ? {
      ...cfg.retrieval,
      embedder: embeddingDriver(cfg),
      vectors: new SqliteVectorStore(graph),
      maxGraphExpansionHits: Number(argValue("--graph-hits") ?? 4),
    }
  : { ...cfg.retrieval, mode: "lexical" };
const forcedThinking = /glm-5\.3/i.test(cfg.llm?.model ?? "");
const driver = recallOnly
  ? undefined
  : requireChat(cfg, {
      maxTokens: 500,
      timeoutMs: 120_000,
      maxRetries: 0,
      extraBody: forcedThinking ? { reasoning_effort: "low" } : { thinking: { type: "disabled" } },
    });

function normalized(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const results = [];
for (const item of questions) {
  const capsule = await recall(graph, item.question, {
    scope: { ...scope, sessionIds },
    retrieval,
  });
  const answer = driver
    ? (
        await driver.complete(
          `${buildAskPrompt(item.question, capsule.context)}\n\nReturn only the concise answer.`,
        )
      ).trim()
    : undefined;
  const correct =
    answer === undefined
      ? null
      : item.answers.some((expected) => normalized(answer).includes(normalized(expected)));
  results.push({
    id: item.id,
    type: item.type,
    question: item.question,
    expected_answers: item.answers,
    answer,
    correct,
    capsule: {
      claims: capsule.claims,
      slots: capsule.slots,
      evidence: capsule.evidence,
      context: capsule.context,
    },
  });
  console.log(
    `${item.id} [${item.type}] ${answer === undefined ? "recalled" : correct ? "PASS" : "FAIL"}` +
      (answer === undefined ? "" : ` ${JSON.stringify(answer)} / ${JSON.stringify(item.answers)}`),
  );
}

const scored = results.filter((item) => item.correct !== null);
const summary = {
  total: scored.length,
  correct: scored.filter((item) => item.correct).length,
  accuracy:
    scored.length === 0 ? null : scored.filter((item) => item.correct).length / scored.length,
  by_type: Object.fromEntries(
    ["single_hop", "multi_hop"].map((type) => {
      const rows = scored.filter((item) => item.type === type);
      const correct = rows.filter((item) => item.correct).length;
      return [
        type,
        { total: rows.length, correct, accuracy: rows.length ? correct / rows.length : null },
      ];
    }),
  ),
};
const output = {
  benchmark: dataset.benchmark,
  task: dataset.task,
  variant: dataset.variant,
  model: recallOnly ? null : (cfg.llm?.model ?? null),
  embedding_model: cfg.embedding?.model ?? null,
  summary,
  usage: usageTotals(),
  evaluated_at: new Date().toISOString(),
  results,
};
const outputPath = join(
  runDir,
  argValue("--output") ?? (recallOnly ? "recall-probe.json" : "evaluation.json"),
);
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`summary ${JSON.stringify(summary)}`);
console.log(`result -> ${outputPath}`);
