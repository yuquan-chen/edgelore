// edgelore · 诊断实验 A — 模型裸能力测试。
//
// 不走我们的管线（不检索、不抽取、不capture），直接把金证据会话的原文
// 塞给 deepseek-flash，看模型本身能不能答对时间推理题。
//
// 如果 A（裸模型+原文） >> B（我们的管线） → 瓶颈在检索/管线，不在模型
// 如果 A ≈ B → 瓶颈在模型能力
//
// Usage: node benchmark/longmemeval/diag-direct.mjs [--limit 5]

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, requireChat } from "../lib/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { cfg } = boot();
const driver = requireChat(cfg, { maxTokens: 16000 });
const MODEL = cfg.llm?.model ?? "(unset)";

const dataset = JSON.parse(readFileSync(join(here, "data", "longmemeval_oracle.json"), "utf8"));
const temporal = dataset.filter((q) => q.question_type === "temporal-reasoning");

const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : 5;
const questions = temporal.slice(0, limit);

console.log(`模型: ${MODEL} (官方 DeepSeek API)`);
console.log(`测试: ${temporal.length} 道时间推理题中的前 ${Math.min(limit, temporal.length)} 道`);
console.log(`方法: 直接注入金证据会话原文（不走记忆管线）\n`);
console.log("═".repeat(60));

let correct = 0;
const results = [];

for (let i = 0; i < questions.length; i++) {
  const q = questions[i];

  // 把金证据会话格式化为对话记录
  let transcript = "";
  for (const sid of q.haystack_session_ids) {
    const idx = q.haystack_session_ids.indexOf(sid);
    const date = q.haystack_dates[idx] ?? "";
    const session = q.haystack_sessions[idx];
    if (!session) continue;
    transcript += `\n--- 会话 (${date}) ---\n`;
    for (const turn of session) {
      transcript += `[${turn.role}] ${turn.content}\n`;
    }
  }

  const prompt = [
    "You are answering a question about a user based on their conversation history.",
    "Read the conversation sessions below and answer the question.",
    "If the information is available, answer concisely in the question's language.",
    "If not enough information, reply with exactly: 不知道",
    "",
    "=== Conversation History ===",
    transcript.trim(),
    "=== End of History ===",
    "",
    `Question: ${q.question}`,
  ].join("\n");

  const t0 = Date.now();
  try {
    const answer = (await driver.complete(prompt)).trim();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // 简单判断：回答里是否包含金标准的关键词
    const goldLower = (typeof q.answer === "string" ? q.answer : JSON.stringify(q.answer)).toLowerCase();
    const answerLower = answer.toLowerCase();
    // 取金标准的核心词（去掉标点和常见词）
    const goldWords = goldLower.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter(w => w.length > 1);
    const overlap = goldWords.filter(w => answerLower.includes(w)).length;
    const likely = overlap >= Math.max(1, Math.floor(goldWords.length * 0.5));

    if (likely) correct++;
    results.push({ q: q.question, gold: q.answer, answer, likely, elapsed });

    console.log(`\n${i + 1}. ${likely ? "✓" : "?"} (${elapsed}s) ${q.question.slice(0, 80)}`);
    console.log(`   金: ${q.answer.slice(0, 80)}`);
    console.log(`   我: ${answer.slice(0, 80)}`);
  } catch (err) {
    console.log(`\n${i + 1}. ✗ ERROR (${err.message.slice(0, 60)})`);
    console.log(`   Q: ${q.question.slice(0, 60)}`);
  }
}

console.log("\n" + "═".repeat(60));
console.log(`结果: ${correct}/${questions.length} 大概率正确`);
console.log(`含义: ${correct / questions.length > 0.6
  ? "模型裸能力足够 → 瓶颈在我们的检索/管线，可以修"
  : "模型裸能力不足 → 需要换更强的模型或改回答策略"}`);
