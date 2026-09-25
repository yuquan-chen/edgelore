// Streaming access to the released LongMemEval JSON arrays.
//
// The S file is ~277 MB and M is multiple GB. Keeping one question at a time
// makes benchmark preparation independent of V8's heap size.

import { createReadStream } from "node:fs";

/** Yield each object from a top-level JSON array without loading the file. */
export async function* readLongMemEval(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let depth = 0;
  let inString = false;
  let escaped = false;
  let collecting = false;
  let object = "";

  for await (const chunk of stream) {
    for (const char of chunk) {
      if (collecting) object += char;

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "[") {
        depth += 1;
        continue;
      }

      if (char === "{") {
        depth += 1;
        if (depth === 2) {
          collecting = true;
          object = "{";
        }
        continue;
      }

      if (char === "}") {
        if (depth === 2 && collecting) {
          depth -= 1;
          collecting = false;
          yield JSON.parse(object);
          object = "";
        } else {
          depth -= 1;
        }
        continue;
      }

      if (char === "]") depth -= 1;
    }
  }

  if (collecting || inString || depth !== 0) {
    throw new Error(`incomplete JSON array: ${path}`);
  }
}

export function capabilityOf(question) {
  return question.question_id.endsWith("_abs") ? "abstention" : question.question_type;
}

/** Read only the tiny identity/type index needed for deterministic selection. */
export async function questionIndex(path) {
  const index = [];
  for await (const question of readLongMemEval(path)) {
    index.push({ id: question.question_id, capability: capabilityOf(question) });
  }
  return index;
}

function hash32(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministic capability-balanced smoke selection.
 * Round-robin sampling ensures every memory ability appears before any gets a
 * second item; a stable hash supplies seed-dependent order within each group.
 */
export function selectStratifiedIds(index, count, seed) {
  if (!Number.isInteger(count) || count <= 0) throw new Error("sample count must be positive");
  const groups = new Map();
  for (const item of index) {
    const group = groups.get(item.capability) ?? [];
    group.push(item.id);
    groups.set(item.capability, group);
  }
  for (const [capability, ids] of groups) {
    ids.sort((a, b) => hash32(`${seed}:${capability}:${a}`) - hash32(`${seed}:${capability}:${b}`));
  }

  const capabilities = [...groups.keys()].sort();
  const selected = [];
  for (let round = 0; selected.length < Math.min(count, index.length); round += 1) {
    let added = false;
    for (const capability of capabilities) {
      const id = groups.get(capability)?.[round];
      if (id === undefined) continue;
      selected.push(id);
      added = true;
      if (selected.length >= count) break;
    }
    if (!added) break;
  }
  return selected;
}

/** Load only selected questions and preserve the requested id order. */
export async function loadQuestions(path, ids) {
  const wanted = new Set(ids);
  const found = new Map();
  for await (const question of readLongMemEval(path)) {
    if (wanted.has(question.question_id)) found.set(question.question_id, question);
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`dataset is missing selected question ${missing[0]}`);
  return ids.map((id) => found.get(id));
}
