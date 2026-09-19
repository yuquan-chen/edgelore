# edgelore 优化路线图（2026-09-20 定稿）

> 给明天清醒的你：这是今天全部取证 + 三路调研（Zep/Graphiti/Mem0/Letta 机制、时间建模最佳实践、本地代码逐项核实）的最终合成。
> 详细依据：[stage2-autopsy.md](stage2-autopsy.md)（47 题逐题）、[stage2-regression-forensics.md](stage2-regression-forensics.md)、[optimization-research-appendix.md](optimization-research-appendix.md)（三份调研原文）
> 当前基线：LongMemEval-ORACLE 固定 100 题 **53.0%**，171+ 测试绿，HEAD `4e3ab68`

---

## 一页 TL;DR（30 秒版）

**目标：53% → 65-72%，分两轮花钱，中间全部免费改代码。**

| 轮次 | 花费 | 攒批内容 | 预期 |
|---|---|---|---|
| **第 1 轮 "stage2b+"** | ~200 次调用（重跑 answer+judge，不动库） | A 层 9 个行级修复（渲染截断/rule 3/日期格式/污染过滤/scope 过滤/打分桥接/merge 去重/旋钮接线） | **58-62%** |
| **第 2 轮 "reingest-v3"** | ~2200 次调用（smoke 门 → 全量重摄入 → merge → 别名合并离线后处理 → 100 题验证） | 抽取保全措辞 + event_time 字段 + 元偏好抽取 + ISO 日期 + **M5 别名合并** | **65-72%** |
| 第 3 轮（达标才做） | ~1100 次调用 | 全量 500 题正式跑分 | 正式成绩单 |

**两个新实锤 bug（调研中核实，优先处理）**：① 库内全部 8402 条语句的 `created_at` 是**斜杠格式**（"2023/05/28"），dateFrom/dateTo 过滤对同年日期静默失效；② `EDGELORE_RETRIEVAL_*` 五个旋钮在 benchmark 答题路径被丢弃——改 env 调参目前无效。

---

## 第 1 轮明细（A 层：行级改动，全部不需要重摄入）

| # | 修复 | 位置 | 预期 |
|---|---|---|---|
| A1 | 渲染截断改双端保留（4 旧+4 新） | runtime.ts:326-347 | +2~4 题（巨型维度最新值不再被裁） |
| A2 | ask rule 3 修正：日期更新的 tentative 可推翻较旧 accepted | ask.ts:43-45 | +1 题（945e3d21 实锤），知识更新止血 |
| A3 | created_at 斜杠→ISO：retrieval.ts:139 加一行兼容（存量库立即生效）+ ingest.mjs:55 源头改 ISO | 两处 | 解锁 A4；消除日期比较隐患 |
| A4 | 答题时传 dateTo=题目 question_date（挡未来语句污染） | answer.mjs:206-210 | +1~3 题 |
| A5 | **scope 隔离·基准方案**：检索候选按 source_refs ∩ 该题会话集过滤 | retrieval.ts:137-143 + answer.mjs | +3~6 题（跨题污染根治；131 个跨用户假冲突消失） |
| A6 | statementText 纳入维度 description（数值不可达桥接）+ 三处内联拼接统一 | retrieval.ts:240-244 | +1~2 题；需 reindex 一次让向量路同步 |
| A7 | merge 按 (维度,值) 去重（64 组孪生重复） | merge.mjs:98-108 | 计数更准；零评测成本 |
| A8 | k=30 对照实验（走 A9 的 env） | 零代码 | +0~1 题 |
| A9 | EDGELORE_RETRIEVAL_* 旋钮接线到 answer.mjs | answer.mjs:163-165（1 行） | 调参免改代码 |

另有免费顺手项：产品逐 turn 路径的回退 knownDimensionsOf().slice(0,50) 换成 relevantDimensionsOf（今天刚实现的）。

## 第 2 轮明细（B+D 层：一次重摄入付全价，务必攒批）

| # | 内容 | 依据 |
|---|---|---|
| D1 | 抽取保全措辞：value 必须保留量词/时间状语/并列项（"or Lager"）；相对时间转绝对日期 | a 类 18 题（38%）+ 回归 27% 丢数字 |
| B2 | **event_time 字段**（照抄 saidBy 模式：可选字段、schema 不 bump、零迁移）+ 抽取 prompt 嵌入 Graphiti 的 REFERENCE_TIME + DATETIME RULES（成熟规则可逐句照抄，见附录 B §5.2）；解析失败存 time_expression_raw 原文兜底，绝不拿 created_at 冒充 | 时间锚点丢失 5/13；Chronos 消融：事件日历占总增益 58.9% |
| B6 | 元偏好句式抽取（偏好本身，不只成分） | 偏好 2 题金标全是元偏好 |
| B1 | **M5 别名合并**（离线后处理，零重摄入成本）——设计今天已充实（见下） | 64% 回归第一根因 |

### M5 别名合并的实施要点（外部机制 → 本方案）

1. **隔离先行**：合并候选生成永远限定在同一用户/同一题的会话集内（Zep 硬分区的原因：合并会改写共享结构，软过滤下跨用户误合是灾难）
2. **三级置信阶梯**（Graphiti 式）：
   - 归一化 token 集完全相等 → 直接合（零 LLM）
   - Jaccard ≥0.9 且 ≥2 token（熵门控防短 key 误合）→ 自动合
   - 中间带 → LLM 裁决（**把两 key 的现有值、类型、时间一起给模型**，只看名字会漏）
3. **合并记录落库**（Graphiti #1771 的教训：uuid_map 即弃 = 不可审计不可撤销）——edgelore 用 alias→canonical 映射 + 判定依据持久化，支持一键拆开
4. **永不物理删除**：值矛盾 → 旧值标 superseded，进已有的冲突裁决层
5. **止血兜底**（Mem0 V3 linked_memory_ids 式）：暂不合 key 时，判定"疑似别名"就互挂链接，检索命中其一带出另一个——散账的主要伤害先消掉
6. 附加：低频后台 sweep（Letta sleep-time 模式）只**提议**不动手，提议经第二遍自审 + 快照可回退

## 不做清单（有数据支撑的克制）

- **ANN/向量索引**：当前 8.4k 语句，暴力扫描亚秒级；触发线 = 语句数 ≥10 万或查询 p95 >100ms（benchmark 永远到不了）。先做的唯一优化：vectors.all() 结果进程内缓存
- **memoryType 标签**：维持冻结，重估窗口在 B2/B3 落地后（见 memory-type-taxonomy.md）
- **全量回扫 re-resolution**：行业无人做（Graphiti #1771 即教训）；做后台 sweep 也只提议不直接改

## 外部框架给我们的三个世界观校准

1. **写时拦截是主流**（Zep/Graphiti/Mem0 全部在写入时做去重），Letta 独家后台 sweep——我们的 M5 是"离线后处理 + 写时拦截"双落点，符合主流且多一层
2. **置信度阶梯是行业共识**：精确 → 强启发式 → LLM → 保守放弃；自动化上限压在"可逆"操作上
3. **时间建模 = 结构化表示收益最大的单项**（Chronos 消融 58.9%；LoCoMo 上无 bi-temporal 的系统时间题接近随机）——B2 的优先级有硬证据

## 成本总账

第 1 轮 ~200 + 第 2 轮 ~2200 + 第 3 轮 ~1100 = **全部做完 ~3500 次调用**，把 53% 推到 65-72%（如只做前两轮 ~2400 次到 65-72%，500 题另议）。
