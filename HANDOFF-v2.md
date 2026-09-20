# edgelore · AI 交接文档 v2

> 给下一个接手的 AI。读完这份文档即可无缝继续工作，不需要翻聊天记录。
> 最后更新：2026-09-20（**全量 500 题 = 74.2%**（基线 28.2%，+46pp）；100 题子集 81.0%。官方同规模同协议，flash 同源裁判）

---

## 项目一句话

**AI Agent 的共享记忆系统**——自动从对话中抽取事实存入 SQLite 图库，支持冲突检测/治理、约束规则校验、混合检索（向量+词面+RRF+图扩展）。本地优先，零运行时依赖（Node 内置 SQLite）。

## 产品愿景（2026-09-20 定稿，路线图的灵魂锚）

> **第一期**：个人助理，记住**值得记住的**事（宁少勿滥）。
> **终局**：全公司共用**一个统一的 SQLite**——大家的记忆和项目细节存在一起，**有矛盾的时候主动提出来**。

由愿景导出的排序原则：
- 第一期 = 写路径保真（抽取保全/event_time）+ 触发层 + 遗忘机制（助理必须能忘）+ dogfood
- 第二期 = 多用户身份（用户层/共享层分离）+ **主动冲突披露**（写时喊响 + 回答时披露 + 跨用户归因——冲突机制已存在 60%，缺"主动"一公里）+ W6b 约束生产线（公司规则被遵守——差异化王牌）
- benchmark（71.0%）是回归验证锚，不是优化目标；一切产品改动先过"真实用户有益"拷问（见反过拟合纪律）

## 当前进度总览

| 里程碑 | 状态 | 提交 |
|---|---|---|
| M0–M4 全线（图模型/约束/存储/管线/MCP/冲突裁决/混合检索） | ✅ | 见 git log |
| 批量优化 W1–W5（saidBy 署名链/无偏向抽取/分组渲染/工装/配置） | ✅ | 8898eb1 |
| 评测工装修复（种子抽样/judge 哈希缓存/boot） | ✅ | 8066e80 |
| 质检加固 + 按 key 调和的 merge | ✅ | 3ba03d2 |
| F1 词面打分 + 回归取证 | ✅ | 1b5151b |
| 全量重抽（940 会话，新库 8384 语句/5643 维度，938/940 覆盖） | ✅ | — |

**当前分支**：`benchmark/longmemeval`
**测试**：171/171 全绿
**固定对照组**：`benchmark/longmemeval/data/stage1-ids.txt`（38.0% 那轮的精确 100 题，stage1/stage2 都用它）

## LongMemEval ORACLE 战绩（同一组 100 题，同一裁判）

| 能力 | 阶段1（500题） | **全量500（v3）** | 100题子集（v3） | 对外口径 |
|---|---|---|---|---|
| **总分** | 28.2% | **74.2%**（371/500） | 81.0% | +46pp（官方同规模） |
|---|---|---|---|

| 时间推理 | 19.0% | — | 76.2% | **81.9%** | 全量最高分能力 |
| 知识更新 | 64.3% | — | 71.4% | **81.9%** | 稳定强项 |
| 单会话用户 | 58.3% | — | 100% | **87.5%** | 强项 |
| 多会话 | 32.0% | — | 52.0% | **66.1%** | v3 兑现 |
| 单会话助手 | 5.9% | — | 82.4% | **55.4%** | ⚠️全量更难，最大剩余失分区 |
| 拒答 | 100% | — | 100% | **76.7%** | ⚠️全量放大，下轮解剖头号 |
| 偏好 | 36.7% | — | 50.0% | **60.0%** | 中等 |
| 单会话用户 | 58.3% | 100% | 100% | +41.7pp ✅已修复 |






⚠ 裁判 = deepseek-flash（同源偏差）；n=4-25 单能力 ±1-2 题噪声。外部坐标（GPT-4o 判卷，方向性）：全上下文 60.2% · Zep 71.2% · 我们 81.0%（flash 级模型）。拒答 -1 题待查（新抽取让松散相关内容变多，或 judge 噪声）。

## 两个回归的根因（已取证，见 docs/notes/stage2-regression-forensics.md）

1. **维度漂移散账（64%）**：新抽取铸 key 更多（5657 维度=5657 key，**零复用**；recommend*/userX* catch-all 巨型 key 吸积），同一语义槽拆成多 key → 计数散账、"最新 accepted"更新语义跨 key 失效。**→ M5 别名合并升为最高优先级**
2. **新抽取丢数字（27%）**：$50 罚单/three meals/6:00 pm 被剥掉（旧库都有）——抽取 prompt 需补"不得剥量词/时间"，随下次重摄入生效
3. **词面 attractor（已修）**：长 value 巨型语句霸占全部检索槽 → lexicalScore 改 F1 平衡（query 覆盖率 × doc 精确率），已提交
4. maxContextLines=48 不是瓶颈（实测从未触发）；瓶颈在 k=8 屏幕被 attractor 占 + 金料散 19.6 key/组

## 反过拟合纪律（2026-09-20 起，所有评测优化必须遵守）

1. 每项修改必须对应**失败模式**（来自错题取证），不对应**具体题目**；取证里的题目 ID 只用作验收清单（改完回归看失败模式是否消失），绝不进 prompt/runtime/配置
2. **分层红线（test/boundary.test.ts 机器强制）**：`src/` 是产品——禁止出现任何 benchmark/数据集词汇（haystack/longmemeval/question_date/oracle/gold/judge/stage1/stage2）和案例关键词；这些只允许存在于 `benchmark/` 工装层。发现于 benchmark 的问题可以决定**优先级**，但实现必须是通用药方，不是给单个病人演的戏
3. 每个 prompt/规则改动都要能回答："一个从没见过这个 benchmark 的用户，这条规则对他的真实记忆也有益吗？"——答否就不做
4. 修复优先修**通用机制**（检索/渲染/治理），修不动才动措辞；措辞也要是普适原则（如"最新用户陈述优先"），不是案例规则
5. 有数据支撑的克制同样重要：明确不做 ANN（<10 万语句）、不做 memoryType 标签、不做全量回扫（见 optimization-roadmap.md 不做清单）
6. **灵魂锚**：benchmark 是罗盘不是领土。产品的灵魂 = 约束引擎进主链路（W6b）+ 真实使用闭环（edgelore-memory MCP 技能 dogfood）+ 触发层——这三样 benchmark 测不了，但不做它们，项目就没有差异化

## 关键架构决策（已冻结，不要重开讨论）

| 决策 | 内容 | 原因 |
|---|---|---|
| 字段三分法 | provenance 系统注入，内容 Agent 填（saidBy 属内容轴），状态系统生成 | 防 AI 伪造 |
| 标而不裁 | 冲突标记不覆盖，旧值留档，分级裁决（resolve 人审/autoresolve 约束/confirm 转正） | 信任螺旋防护 |
| 宁少勿滥 | gate 过滤瞬时/寒暄；**一次性长期事件在白名单**（W3） | 事件不再被误滤 |
| 双信任源 | saidBy=assistant → 语句 tentative，不进人审队列；用户复述=确认 | 助手结论入库且不污染裁决 |
| 检索混合 | 向量+词面 F1+RRF（smoothing 可配）+图扩展+分组渲染（图给计数） | 计数由图统计 |
| 批量抽取单一来源 | buildBatchExtractionPrompt 在 src，ingest/fill-gaps 共用 | 消灭 prompt 分叉 |
| 无显式 type 字段 | 阶段 2 后按 docs/notes/memory-type-taxonomy.md 三个决策点分别裁决 | 行为结构优先于标签 |
| merge 按 key 调和 | 分片合并时统一同 key 维度、值冲突标记进裁决台 | 多写者调和的第一块砖 |

## 记忆类型分层（LangMem/CoALA 三分类）决策

完整调研在 docs/notes/memory-type-taxonomy.md。结论：**加行为结构，缓加标签**——
- W6a `event_time` 字段（episodic 行为）：bi-temporal 是唯一有硬证据的结构，**阶段 2 后几乎必加**
- W6b constraint 生产线（procedural 行为）：gate 认出的规则现在被降级存语句
- memoryType 标签：可从结构推导，暂不加

## API 配置（.env.local，已 gitignore）

```
OPENAI_API_KEY=sk-hx0e...（dogrouter key）
OPENAI_BASE_URL=https://api.dogrouter.ai/v1
EDGELORE_MODEL=deepseek-v4-flash-0731
OPENAI_EMBEDDING_API_KEY=sk-hx0e...
OPENAI_EMBEDDING_BASE_URL=https://api.dogrouter.ai/v1
EDGELORE_EMBEDDING_MODEL=qwen3.7-text-embedding
EDGELORE_EMBEDDING_DIMENSIONS=1024
```
全部入口经 src/config.ts 读取；可调旋钮：EDGELORE_RETRIEVAL_{MODE,K,RRF_SMOOTHING,MAX_ENTRIES_PER_DIM,MAX_CONTEXT_LINES}、EDGELORE_EXTRACTION_MAX_FACTS、EDGELORE_JUDGE_MODEL。

## 关键文件地图

| 文件 | 作用 |
|---|---|
| src/config.ts | 配置枢纽（唯一 loadDotEnv/driver 工厂） |
| src/agent/capture.ts | 存储原语（saidBy 信任策略/去重翻转） |
| src/agent/conflicts.ts | resolve/autoresolve/**confirm** |
| src/agent/prompt.ts | gate/extract/批量抽取 prompt（单一来源） |
| src/agent/extract.ts | 抽取契约 + normalizeBatchContents（批量宽容解析） |
| src/agent/retrieval.ts | 混合检索（F1 词面/smoothing/states/date 过滤） |
| src/agent/runtime.ts | 编排 + 分组渲染（图给计数） |
| src/agent/ask.ts | 回答层（Today 注入/拒答契约） |
| benchmark/lib/boot.mjs | 评测统一启动（env+driver） |
| benchmark/longmemeval/answer.mjs | 答题（--seed/--sample/--ids/--tag/--dry-run） |
| benchmark/longmemeval/judge.mjs | 判分（--hypotheses/--tag，verdict 键含答案哈希） |
| benchmark/longmemeval/merge.mjs | 分片合并 + **按 key 调和 + 冲突标记** |
| benchmark/longmemeval/smoke-reingest.mjs | 重抽质检门（覆盖率 A/B） |
| docs/notes/stage2-regression-forensics.md | 回归取证（12 题逐题） |
| docs/notes/memory-type-taxonomy.md | 类型分层调研与决策 |
| docs/notes/lifecycle-design-draft.md | M5 遗忘机制设计（已冻结待实现） |

## 下一步（按数据排序的优先级）

| 优先级 | 任务 | 依据 | 说明 |
|---|---|---|---|
| **P0** | **M5 维度别名合并** | 64% 回归 = 漂移散账 | 已冻结设计；取证报告里 7 个散账案例就是验收用例 |
| **P0** | 抽取 prompt 补"不得剥量词/时间" | 27% 回归 | 一行措辞；**攒着与别名合并一起重摄入验证**（一次全价） |
| P1 | stage2b 验证（F1 修复后同 100 题重跑，~200 调用） | 量化 attractor 修复收益 | 也可与 M5 完成后合并验证，省一轮 |
| P1 | 全量 500 题正式跑分（~1100 调用） | 53% 是真实水平 | 独立决策点 |
| P2 | W6a event_time / W6b constraint 生产线 | 类型分层决策点 | 阶段 2 已达标，进入评估窗口 |
| P2 | 裁决台 99+576 个 conflict 消化 | 产品治理 | 人审/autoresolve |
| P3 | README 更新（还写着 M0） | 文档 | 顺手 |

## 评测工装使用

```bash
# 内部自测（29 题，~50 调用）
node benchmark/internal/run-eval.mjs

# LongMemEval：固定子集答题 + 判分（可复现对照）
node benchmark/longmemeval/answer.mjs --ids benchmark/longmemeval/data/stage1-ids.txt --tag NAME
node benchmark/longmemeval/judge.mjs --tag NAME

# 抽样（可复现）与零 API 预检
node benchmark/longmemeval/answer.mjs --sample 100 --seed 20260919 --dry-run

# 重抽质检门（改抽取层后、全量重摄入前必跑，~20 调用）
node benchmark/longmemeval/smoke-reingest.mjs --n 20

# 全量重抽（断点续跑；改抽取层 = 删 checkpoint + shard db 全价重付）
node benchmark/longmemeval/run-all.mjs
node benchmark/longmemeval/merge.mjs     # 含按 key 调和 + 冲突标记
node benchmark/longmemeval/coverage.mjs

# 冲突治理
node dist/src/cli.js conflicts --db benchmark/longmemeval/data/memory.db
node dist/src/cli.js resolve <dim> <stmt> --by human:x --db ...
node dist/src/cli.js autoresolve <dim> --db ...
node dist/src/cli.js confirm <stmt> --by human:x --db ...
```

**成本纪律**：改 ask/检索层 = 重跑 answer+judge（~200 调用）；改抽取层 = smoke 质检（~20）→ 全量重摄入（~2000）；两者都攒批了再动。
