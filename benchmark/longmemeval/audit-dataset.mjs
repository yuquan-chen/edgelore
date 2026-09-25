// Stream a LongMemEval JSON file and report its physical ingestion scale.
// This deliberately avoids JSON.parse(file): the S/M variants are hundreds of
// megabytes to gigabytes and should not require a multi-gigabyte heap to audit.
//
// Usage:
//   node benchmark/longmemeval/audit-dataset.mjs
//   node benchmark/longmemeval/audit-dataset.mjs --dataset path/to/file.json

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argIndex = process.argv.indexOf("--dataset");
const datasetPath =
  argIndex >= 0 ? process.argv[argIndex + 1] : join(here, "data", "longmemeval_s_cleaned.json");

if (!datasetPath) throw new Error("--dataset requires a path");

const categories = new Map();
const uniqueSessions = new Set();
const uniqueEvidenceSessions = new Set();
const perQuestion = [];
let sessionOccurrences = 0;
let evidenceOccurrences = 0;
let userTurns = 0;
let assistantTurns = 0;
let transcriptChars = 0;
let abstentionQuestions = 0;
let activeArray;
let current;

function parseProperty(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return undefined;
  const raw = line
    .slice(colon + 1)
    .trim()
    .replace(/,$/, "");
  return JSON.parse(raw);
}

function finishCurrent() {
  if (!current) return;
  perQuestion.push(current);
  current = undefined;
}

const input = createReadStream(datasetPath, { encoding: "utf8" });
const lines = createInterface({ input, crlfDelay: Infinity });

for await (const line of lines) {
  const trimmed = line.trim();

  if (line.startsWith('        "question_id":')) {
    finishCurrent();
    const id = parseProperty(line);
    current = {
      id,
      sessions: 0,
      evidenceSessions: 0,
      turns: 0,
      chars: 0,
    };
    if (id.endsWith("_abs")) abstentionQuestions += 1;
    activeArray = undefined;
    continue;
  }

  if (!current) continue;

  if (line.startsWith('        "question_type":')) {
    const category = parseProperty(line);
    current.category = category;
    categories.set(category, (categories.get(category) ?? 0) + 1);
    continue;
  }

  if (line.startsWith('        "answer_session_ids": [')) {
    activeArray = "evidence";
    continue;
  }

  if (line.startsWith('        "haystack_session_ids": [')) {
    activeArray = "haystack";
    continue;
  }

  if (line.startsWith('        "haystack_')) {
    activeArray = undefined;
  }

  if (activeArray && (trimmed === "]" || trimmed === "],")) {
    activeArray = undefined;
    continue;
  }

  if (activeArray && /^".*",?$/.test(trimmed)) {
    const sessionId = JSON.parse(trimmed.replace(/,$/, ""));
    if (activeArray === "haystack") {
      current.sessions += 1;
      sessionOccurrences += 1;
      uniqueSessions.add(sessionId);
    } else {
      current.evidenceSessions += 1;
      evidenceOccurrences += 1;
      uniqueEvidenceSessions.add(sessionId);
    }
    continue;
  }

  if (trimmed === '"role": "user",') {
    userTurns += 1;
    current.turns += 1;
    continue;
  }

  if (trimmed === '"role": "assistant",') {
    assistantTurns += 1;
    current.turns += 1;
    continue;
  }

  if (trimmed.startsWith('"content":')) {
    // Some source conversations contain literal Unicode line separators.
    // Counting the serialized payload is sufficient for a scale audit and
    // avoids treating an isolated content line as a standalone JSON document.
    const serializedLength = Math.max(0, trimmed.length - '"content": "",'.length);
    transcriptChars += serializedLength;
    current.chars += serializedLength;
  }
}

finishCurrent();

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    min: sorted[0] ?? 0,
    avg: sorted.length ? total / sorted.length : 0,
    median: median ?? 0,
    max: sorted.at(-1) ?? 0,
    total,
  };
}

const file = await stat(datasetPath);
const report = {
  dataset: datasetPath,
  bytes: file.size,
  questions: perQuestion.length,
  abstentionQuestions,
  categories: Object.fromEntries([...categories].sort()),
  sessions: {
    occurrences: sessionOccurrences,
    unique: uniqueSessions.size,
    repeatedOccurrences: sessionOccurrences - uniqueSessions.size,
    perQuestion: summary(perQuestion.map((item) => item.sessions)),
  },
  evidenceSessions: {
    occurrences: evidenceOccurrences,
    unique: uniqueEvidenceSessions.size,
    perQuestion: summary(perQuestion.map((item) => item.evidenceSessions)),
  },
  transcript: {
    turns: userTurns + assistantTurns,
    userTurns,
    assistantTurns,
    characters: transcriptChars,
    turnsPerQuestion: summary(perQuestion.map((item) => item.turns)),
    charactersPerQuestion: summary(perQuestion.map((item) => item.chars)),
  },
};

console.log(JSON.stringify(report, null, 2));
