// Human-reviewed stage attribution for the failed v7 LongMemEval answers.
//
// This intentionally keeps benchmark/judge problems separate from EdgeLore
// failures. A zero judge score does not prove that ingestion or recall failed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const tag = "v7-episode-graph-read-20260923";
const inputPath = join(dataDir, `failure-attribution-input-${tag}.json`);
const outputPath = join(dataDir, `failure-attribution-reviewed-${tag}.json`);
const reportPath = join(here, "..", "..", "docs", "notes", `failure-attribution-${tag}.md`);

const audit = JSON.parse(readFileSync(inputPath, "utf8"));

const reviewed = {
  // The raw fact and Claim -> Episode path both exist. The original reader
  // chose the wrong turn/section inside that Episode.
  dd2973ad: ["episode_evidence_failure", "multi_episode_turn", "原文与 Claim→Episode 路径都存在；旧算法没有同时选中预约与前一晚 2:00 入睡的两个证据回合。"],
  edced276: ["episode_evidence_failure", "multi_episode_turn", "夏威夷 10 天与纽约 5 天都在原始 Episode 中；旧算法让泛化旅行段落挤掉了 10 天证据。"],
  "89527b6b": ["episode_evidence_failure", "fixed_window_truncation", "Plesiosaur 的蓝色仍在 Episode；固定字符窗口恰好截断在颜色之前。"],
  "18dcd5a5": ["episode_evidence_failure", "markdown_section", "Mummies (4) 完整保存在长 Markdown 回答中；旧算法没有选中对应列表小节。"],
  "5809eb10": ["episode_evidence_failure", "long_turn_selection", "开工年份 2014 完整保存在 Episode；旧算法被同一长回合中的标题与摘要占满。"],
  eaca4986: ["episode_evidence_failure", "section_selection", "第二首歌的完整副歌和弦仍在 Episode；旧算法只恢复了前面的歌曲片段。"],
  "75499fd8": ["episode_evidence_failure", "adjacent_detail", "Golden Retriever 位于与 collar Claim 相邻的用户回合；旧算法只返回了用药和选定项。"],
  gpt4_1e4a8aec: ["episode_evidence_failure", "temporal_episode_priority", "种下 12 株番茄苗的原句仍在 Episode；旧算法没有把‘两周前’对齐到正确 Episode 与回合。"],
  "73d42213": ["episode_evidence_failure", "multi_episode_turn", "7:00 出发与两小时路程分别保存在两个 Episode；旧算法未同时恢复两个计算端点。"],

  // A sufficient Claim exists, but the produced MemoryCapsule omitted it.
  a3838d2b: ["retrieval_miss", "set_completeness", "Walk for Wildlife 已入库，但跨多个近义 Slot 聚合时没有召回。"],
  gpt4_2ba83207: ["retrieval_miss", "aggregation", "Thrive Market 的 150 美元 Claim 已入库，但最高消费比较时未召回。"],
  "1d4e3b97": ["retrieval_miss", "causal_support", "更换链条和飞轮的维护 Claim 已入库，但问题召回没有覆盖它。"],
  "2ebe6c92": ["retrieval_miss", "temporal_event", "完成 The Nightingale 的 Claim 已入库，但没有进入上下文。"],
  gpt4_d6585ce9: ["retrieval_miss", "event_participant", "与父母参加 Queen 演唱会的 Claim 已入库，但没有进入上下文。"],
  "92a0aa75": ["retrieval_miss", "multi_claim_arithmetic", "召回了晋升前 2 年 4 个月，却漏掉在公司共 3 年 9 个月，无法做差。"],

  // Retrieval crossed account/scope boundaries or preferred unrelated memory.
  "0edc2aef": ["scope_pollution", "foreign_account", "没有本账户的迈阿密酒店记录，却把其他账户的酒店清单交给回答模型。"],
  "75f70248": ["scope_pollution", "foreign_account", "答案使用了另一账户的猫 Lola；目标上下文要求 Luna 和客厅深度清洁。"],

  // The capsule already contains enough evidence; failure occurs after recall.
  "0a995998": ["answer_failure", "counting", "西装干洗、靴子退换和新靴取件都在上下文中，回答只计了一项。"],
  "3a704032": ["answer_failure", "temporal_window", "三株植物的信息已召回，回答自行把蛇纹兰排除。"],
  "46a3abf7": ["answer_failure", "state_interpretation", "三个鱼缸均已召回，回答把旧 5 加仑缸误判为不再持有。"],
  "88432d0a": ["answer_failure", "deduplication", "同一次酸面包经历被重复计数。"],
  d23cf73b: ["answer_failure", "classification", "已召回的饮食经历没有按题目口径正确归类为四种 cuisine。"],
  "7024f17c": ["answer_failure", "temporal_window", "证据已在上下文，回答采用了与标准答案不同的 last week 边界。"],
  gpt4_ab202e7f: ["answer_failure", "classification", "五个厨房物品均有证据，回答错误排除了咖啡机。"],
  bf659f65: ["answer_failure", "classification", "三张专辑或 EP 均已召回，回答错误排除黑胶。"],
  eace081b: ["answer_failure", "state_resolution", "上下文明确有最新的 Oahu 计划，回答没有采用。"],
  a2f3aa27: ["answer_failure", "state_resolution", "最新陈述接近 1300 已召回，回答仍锚定旧值 1250。"],
  "0977f2af": ["answer_failure", "temporal_inference", "Instant Pot 与 Air Fryer 均已召回，回答过度保守而拒绝题目要求的顺序判断。"],
  "031748ae_abs": ["answer_failure", "abstention", "问题换成未出现的 Manager 职位，回答却迁移了 Senior Engineer 的团队人数。"],
  "8a2466db": ["answer_failure", "personalization", "已召回 Premiere Pro/Lumetri 偏好，回答仍混入泛化工具。"],
  "35a27287": ["answer_failure", "personalization", "已召回语言练习偏好，回答没有据此组织文化活动建议。"],
  b86304ba: ["answer_failure", "reference_resolution", "三倍购买价已经召回，回答因题材措辞差异拒绝关联。"],
  ec81a493: ["answer_failure", "reference_resolution", "500 copies 已召回，回答对海报/专辑指代作了错误区分。"],
  gpt4_18c2b244: ["answer_failure", "temporal_order", "三个事件日期均在上下文，回答却称 ShopRite 日期缺失。"],
  gpt4_a1b77f9c: ["answer_failure", "arithmetic", "The Power 完成日期已召回，回答没有完成三段时长求和。"],
  "4dfccbf7": ["answer_failure", "arithmetic", "2 月 1 日开始、2 月 25 日送修均已召回，却算成 0 天。"],
  gpt4_21adecb5: ["answer_failure", "arithmetic", "本科完成与论文提交日期均已召回，却拒绝计算约六个月。"],
  "71017277": ["answer_failure", "semantic_match", "姑妈送的水晶吊灯已召回，回答因 jewelry/chandelier 类别差异拒绝关联。"],
  "7405e8b1": ["answer_failure", "comparison", "两次首单优惠信息已召回，回答仍拒绝比较。"],
  "37f165cf": ["answer_failure", "aggregation", "416 与 440 页均已召回，回答没有按题目把两本书相加。"],
  a96c20ee_abs: ["answer_failure", "abstention", "把‘在 Harvard 参加会议’错误拼接成‘在 Harvard 展示海报’。"],
  "09ba9854_abs": ["answer_failure", "provenance_policy", "用 assistant 给出的通用公交价格补齐用户缺失事实，产生了不该有的计算。"],

  // The zero score should not be used to optimize EdgeLore without caveats.
  gpt4_2f8be40d: ["benchmark_or_judge_issue", "judge_false_negative", "回答给出的婚礼数量 3 正确，并列出了三场；主要缺少第一对新人的 Mike，不应归因于摄入或召回。"],
  "07741c45": ["benchmark_or_judge_issue", "future_vs_current", "原文说鞋仍占据衣柜空间、计划放入鞋架；回答忠实区分了当前状态和计划，标准答案却把计划当成当前。"],
  "51a45a95": ["benchmark_or_judge_issue", "unsupported_gold", "用户只说兑换咖啡伴侣优惠券；Target 只是 assistant 后续举例，回答拒绝猜测是合理的。"],
  bc8a6e93_abs: ["benchmark_or_judge_issue", "judge_strictness", "‘不知道’已经正确拒答，只是没有复述‘提到侄女而非叔叔’的完整理由。"],
  "370a8ff4": ["benchmark_or_judge_issue", "incorrect_gold", "数据日期是 2023-01-19 与 2023-04-10，相隔 81 天（11 周 4 天），标准答案 15 周不成立。"],
  ba358f49: ["benchmark_or_judge_issue", "underspecified_gold", "2022-09-01 时 32 岁、婚礼仅知在 2023 年，缺少生日与婚礼相对顺序，32 或 33 才是严谨答案。"],
};

const actualIds = audit.failures.map((item) => item.questionId);
const missing = actualIds.filter((id) => !reviewed[id]);
const extra = Object.keys(reviewed).filter((id) => !actualIds.includes(id));
if (missing.length || extra.length) {
  throw new Error(`review map mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`);
}

const failures = audit.failures.map((item) => {
  const [primaryCause, subtype, explanationZh] = reviewed[item.questionId];
  return {
    questionId: item.questionId,
    type: item.type,
    primaryCause,
    subtype,
    explanationZh,
    question: item.question,
    expectedAnswer: item.expectedAnswer,
    hypothesis: item.hypothesis,
  };
});

const counts = Object.fromEntries(
  [...new Set(failures.map((item) => item.primaryCause))]
    .map((cause) => [cause, failures.filter((item) => item.primaryCause === cause).length]),
);

const output = {
  tag,
  reviewedAt: new Date().toISOString(),
  method: "Human review of source turns, extracted Claims, reproduced MemoryCapsule, hypothesis, and gold answer.",
  counts,
  failures,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

const labels = {
  episode_evidence_failure: "Episode 证据选择失败",
  retrieval_miss: "召回遗漏",
  scope_pollution: "作用域污染",
  answer_failure: "回答阶段失败",
  benchmark_or_judge_issue: "题目/裁判问题",
};
const order = ["episode_evidence_failure", "retrieval_miss", "scope_pollution", "answer_failure", "benchmark_or_judge_issue"];
const lines = [
  "# v7 错题阶段归因",
  "",
  `对象：${failures.length} 道被 judge 判错的问题。人工同时核对了原始证据、Claim、实际召回上下文和最终回答。`,
  "",
  "| 根因 | 数量 | 占 48 道错题 |",
  "| --- | ---: | ---: |",
  ...order.map((cause) => `| ${labels[cause]} | ${counts[cause]} | ${(counts[cause] / failures.length * 100).toFixed(1)}% |`),
  "",
  "这 9 题不是摄入损失：原文仍在 Episode，Claim→Episode 路径也存在，失败发生在 Episode 内部的 turn/section 选择。另有 6 题是跨 Slot 的召回遗漏；25 题的所需证据已经交给回答模型，错误发生在计数、时间、状态、指代、拒答或 provenance 使用阶段。还有 6 题存在标准答案或 judge 问题，不应反向污染架构设计。",
  "",
  "## 对主线二的直接结论",
  "",
  "暂不修改摄入，也不增加 EvidenceSpan 节点。现有 Episode 已承担无损原件职责，Claim 继续作为可检索、可冲突判断的语义索引。先修复 Episode 读取：按 Episode 分配证据位置，再按 turn 与 Markdown/列表/代码/歌曲 section 选择完整语义单元。",
  "",
  "召回层优先修复集合完整性和多 Claim 计算依赖：先召回候选 Slot，再做同义 Slot 扩张，并为 count/max/sum/difference/order 等问题生成有界的 completeness plan。账户/项目 scope 必须在检索前硬过滤，不能靠回答模型忽略 foreign-account 结果。",
  "",
  "回答层需要一个薄而明确的 MemoryCapsule contract：列出可用 Claim、状态、时间、saidBy/provenance 和证据；默认最新用户事实优先，不得拿 assistant 建议补用户事实，计算题必须显示所用操作数，证据不足才拒答。",
  "",
  "## 明细",
  "",
  "| ID | 归因 | 子类 | 说明 |",
  "| --- | --- | --- | --- |",
  ...failures.map((item) => `| ${item.questionId} | ${labels[item.primaryCause]} | ${item.subtype} | ${item.explanationZh} |`),
  "",
];
writeFileSync(reportPath, lines.join("\n"));

console.log(JSON.stringify({ outputPath, reportPath, counts }, null, 2));
