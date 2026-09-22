# edgelore 摄入架构现状简报（给外部模型/顾问）

> 写给被请来评审的 AI（或人）。本文只陈述现状与问题，**不含任何解决方案**——请独立给出你的判断。
> 写作日期：2026-09-22。所有数字可复验（验证命令见文末）。

---

## 0. 一句话上下文

edgelore 是一个给 AI Agent 用的**共享长期记忆系统**：把对话抽成"维度（key）→ 语句（值）"的知识图谱存进单个 SQLite，带约束引擎、冲突裁决、provenance。当前在 LongMemEval 长程记忆基准上回归验证（500 题），但**它不是做题机器——一切优化只对真实用户价值负责**（owner 的红线，见 §2）。

评审对象：**摄入管线**（对话 → 记忆的写入路径）。它决定系统上限——读侧（检索+答题）只能兑现摄入存下的东西。

## 1. 阅读路径（按序）

| 序 | 材料 | 回答什么问题 | 精读点 |
|---|---|---|---|
| 1 | 本文档 | 全景 + 事实底座 + 问题清单 | — |
| 2 | `README_CN.md` | 产品是什么、差异化（约束引擎） | 前言即可 |
| 3 | `docs/agent-memory-design.md` | 摄入管线设计文档（gate→extract→capture 三段） | §4 两段式结构 |
| 4 | `docs/notes/autopsy/v4-full500-autopsy.md` | 上一轮 500 题错题解剖：失败模式、18 题回归归因、架构极限评估 | §0 混合库发现、§5 合成、§6 评估 |
| 5 | `src/agent/prompt.ts` | 抽取 prompt 原文（批量模式 `buildBatchExtractionPrompt`） | few-shot 形状、规则列表 |
| 6 | `src/agent/capture.ts` | 存储原语：地址查找、去重、冲突标记、provenance | 冲突分支 |
| 7 | `src/agent/runtime.ts` 的 `relevantDimensionsOf`（L213） | 已有维度怎么喂给抽取 prompt（top-30 词面打分） | 打分函数 |
| 8 | `src/agent/triggers.ts` + `src/agent/lang.ts` | 两个代码层强制防线（事件扫描 / 语言钉死） | 设计注释 |
| 9 | `benchmark/longmemeval/ingest.mjs` | 批量摄入编排（串行、断点、语言过滤+重试） | 主循环 |
| 参考 | `HANDOFF-v3.md`（根目录，不进 git） | 工作底稿：决策冻结表、坑清单 | — |
| 参考 | `docs/notes/autopsy/stage3-full500-autopsy.md` | 上上轮（74.2%）解剖，供两轮对比 | 各分片结论 |

## 2. 产品红线（评审前提）

1. **宁少勿滥**：宁可不记，不可记错/记滥。gate 白名单制，"一次性长期事件"在白名单内。
2. **不是做题架构**：基准只做回归锚。按基准金标措辞/判卷口味设计的行为视为过拟合。"没见过这个基准的真实用户也受益吗？"是每个提案的第一问。
3. **标而不裁**：冲突永不覆盖，标记后等裁决（人审 / 约束裁判 / confirm 转正）。
4. **双信任源**：用户陈述 → accepted；助手结论 → tentative。
5. **已证伪的死路**（实验结论，供参考）：
   - prompt 措辞级语言钉死：实测新层 20-30% 语句漂成西语（已改代码层强制，见 §7）
   - few-shot 保全措辞解决载荷压缩：两轮 0/13，逐题丢失细节完全相同
   - 全量维度清单喂 prompt：624KB 超上下文事故，窗口封顶是冻结决策
   - ANN 索引（<10 万语句不做）、cross-encoder 重排、细粒度话题标签（owner 反对硬编码词表）
   - 回滚拒答纪律（rule 7 的过冲问题在，但回滚会丢掉拒答题的收益）

## 3. 事实底座

| 项 | 值 |
|---|---|
| 基准成绩 | v4 轮 82.2%（410/499，**三语混合库上取得**）；v3 轮 74.2%；基线 28.2% |
| 当前库 v5（干净库，2026-09-22 重摄） | 6708 语句 / 5956 维度 / 向量 100%（6708/6708）/ 覆盖 939/940 会话 / 语言 en 纯层（es=0, zh=0） |
| 旧 v4 库 | 13499 语句 = 旧中文层 4493 + 英文层 9006（其中 20-30% 漂成西语）；已被 v5 替换（备份 `memory.db.old-v4hybrid`） |
| 维度近亲 | v5 内 Jaccard≥0.5 的直接近亲对 **4278**（详见 §5）；v4 混合库为 11027 |
| 错题失败模式（89 题，v4 轮） | (a) 抽取丢失/压瘪 44%、(d) 推理/拒答纪律 33%、(b) 检索聚合 16%、(e) 判卷噪声 7%、(c) 污染 1% |
| 18 题回归归因 | 10 题 = 拒答/对冲纪律过冲（读侧）；4 题 = 抽取丢失被上轮运气掩盖；2 题 = judge 方差；1 题 = 双层库挤占；1 题 = 世界知识代答 |
| 摄入成本 | 全量 940 会话 ≈ 1888 调用 / ~5M input tokens / 150 分钟 |
| 答题侧窗口 | 检索 k=10（聚合题经决策层 Jev 放大到 30）、渲染 ≤48 行、每维度 ≤8 条 |
| 摄入侧窗口 | 批量抽取每会话 ≤12 条事实；已有维度清单 top-30（词面 bigram 打分）；产品 per-turn 路径为 50 |
| tentative 占比 | 3390/6708 = 51%（accepted 3318） |

## 4. 摄入管线现状（两条路）

```
产品路径（每轮实时）：turn → gate(值得存?) → extract(结构化) → capture(落库) → 向量
批量路径（940 会话摄入用）：会话 → 事件扫描 → 一次批量抽取 → 容错解析 → 语言钉死 → capture×N → 向量
```

逐步（带真实案例）：

1. **入口**：会话 turns 带角色前缀（`[user]/[assistant]`），会话日期注入（相对时间换算锚）。
2. **事件扫描**（触发层 v0，`src/agent/triggers.ts`）：确定性正则扫 user 轮"第一人称 ∧ (时间词 ∨ 旁插标记)"句，命中句作为"必须逐条裁决"清单进 prompt。战果：三个两轮全丢的旁插事件（DC 六小时车程 / 6月3日 BBQ / 捐咖啡机）在 v5 全部入库。
3. **批量抽取**（一次 LLM 调用）：角色 + few-shot（日期解析、saidBy 署名）+ 规则（相对时间→绝对日期、数字原样、旁插算记忆、语言钉死）+ 必裁块 + knownDimensions top-30 + 会话日期 + 全文 → `{contents:[{dimensionKey, value, saidBy, dimensionDescription?, cardinality?, unit?}]}`，上限 12 条。
4. **容错解析**：坏条目跳过计数（不连坐）、`NEW:` 剥壳、裸数字强转、saidBy 非法丢署名保事实。
5. **语言钉死（代码层）**：`dominantLang(会话)` → 每语句 `detectLang`，置信外语丢弃，漂移占主导则重抽一次。v5 实战丢弃 29 条。
6. **capture()**（存储原语）：
   - 找地址：key 存在 → 复用；不存在 → 铸新维度（description + cardinality=single|multi）
   - 去重：同维度同值（逐字）→ dedup
   - **冲突标记**：single 维度已有 accepted 用户值 + 新值不同 + 来源不同 → 新语句 tentative + 维度 conflict，永不覆盖
   - provenance 系统注入（created_by / source_refs / created_at），模型无权填写
   - 双信任源：user→accepted，assistant→tentative
7. **向量**：每会话落库后批量 embedding（qwen3.7-text-embedding, 1024 维）。
8. **冲突裁决**（benchmark 无人审，产品里三通道）：resolve 人审 / autoresolve 约束裁判 / confirm 助手转正。ask 层 rule 3（最新用户陈述优先，tentative 也算数）是无人审场景的补丁。

## 5. 核心病灶：维度 key 漂移

**现象**：v5 干净库内仍有 **4278 对**"词面近亲"维度。人工抽样发现两类混杂：

**A 类：真别名（同一事实、不同地址）**
```
[hawaiiFamilyTrip]  "Completed island-hopping trip to Hawaii with family"  ← 会话 60e8941a 铸
[familyTripHawaii]  "Recent family trip to Hawaii, enjoyed snorkeling"    ← 会话 02e66dec 铸
```
另例：`masterMarketingPlan`/`marketingMasterPlan`（纯词序翻转，两个会话各铸一个）。

**B 类：假近亲（同类型不同实例）**
```
[ufMbaProgramDetails]  "University of Florida MBA: ranked #24 online..."   ← J=1.00
[asuMbaProgramDetails] "Arizona State University MBA: ranked #25 online..."
```
两所大学的 MBA 必须分开。同型：`cowPurchasePlan`/`dogBedPurchasePlan`、`dayTripPlanning`/`laTripPlanning`/`sfTripPlanning`。**词面 Jaccard 分不清 A 和 B。**

**根因链**：
1. "这是不是已有概念的另一个名字"是全局+语义判断，但实现上交给了每次抽取调用现场决策；
2. 现场只带 top-30 已有维度，打分是**词面 bigram containment**——对整会话长文本区分度接近噪声（一个会话几万个 bigram，任何 key+description 能命中的比例是千分之几），30 个名额被全会话所有话题分摊，零分时兜底返回任意前 30（queryNodes 自然顺序）；
3. 已有的 `familyTripHawaii` 不在现场 → 模型物理上看不见 → 只能铸新；
4. camelCase 组词是自由生成不是查表：看见也可能翻词序、改详略（`jewelryCleaningPlan`/`jewelryCleaningKitPlan` 同会话内漂移；全库批内漂移 1056 对）；
5. prompt 反漂移规则（rule 4/5）是 prompt 级——与语言钉死同一课：prompt 级规则防不住采样本性。

**危害**：同一事实散在多地址 → 检索窗口（k=10/30）装不下 → 计数/知识更新题漏项、旧值复活。上轮 KU（知识更新）错题的头号死因。

**现有离线合并工具（`benchmark/longmemeval/alias-merge.mjs`）的已知缺陷**：
- union-find 把 J≥0.5 的对做传递闭包——实测链出 321 个维度的组（在线学习资源、数据可视化、野马车升级件连体）；
- 纯词面判据无法区分 §5 的 A/B 两类；
- （另有两个已修的 argv 静默失败 bug：`--shard` 裸 tag 被当过滤器致全跳、`--threshold` 缺省取 NaN 致静默合并 0 组。）
- 该脚本**当前处于挂起状态**，未对 v5 库执行过合并。

## 6. 问题清单（只陈述，未解决）

| # | 问题 | 现状/证据 |
|---|---|---|
| P1 | 维度 key 漂移：同一事实多个地址 | §5 全述；4278 对近亲 |
| P2 | 离线合并工具判据：无法区分 A/B 类 + 链式闭包连体 | §5；脚本挂起中 |
| P3 | 载荷压缩：抽取摘要化丢细节（引文/音符/和弦/URL/标题/排班/数量） | ~12 题；两轮 prompt 措辞 0/13 |
| P4 | 旁插事件残余：扫描看见但抽取裁决不存 | 15 个靶句中 3 个（Alex 毕业典礼 / 芝加哥 4 天 / 45 分钟 5K） |
| P5 | 裸值语句检索不可达：值为纯数字的语句无文本可匹配 | `gasMileage` 维度存有裸值 `"32"` |
| P6 | 助手内容与用户事实共居维度 | `gasMileage` 内助手 EPA 数据（53 mpg）与用户自述（32 mpg）并存 |
| P7 | 冲突噪声：同事实改述被标 conflict | `gasRewardsProgram`："Uses Shell rewards near office" vs "Shell rewards program member" 被标冲突；与真冲突（wear count 4 vs 6）无法区分 |
| P8 | conflict 无人审：维度长期停留 conflict 状态 | benchmark 场景无裁决者；ask 层 rule 3 是唯一补丁 |
| P9 | maxFacts=12 名额竞争：助手推荐清单与用户事件自由竞争 | 抽取输出中推荐类内容占比高 |
| P10 | 裸日期年份锚定：无年份日期被锚成未来 | "December 12" → 2023-12-12（未来）；zh/en 两层同错 |
| P11 | dateTo 驱逐：共享会话 ID 挂双时间线，ingest 先到先得取日期 → A4 守卫清空检索 | 影响 2 题（07741c45、89941a94） |
| P12 | 拒答/对冲纪律过冲：rule 7 数量词卫兵把"可合理推断"的计数/比较题拦成拒答 | 18 题回归中 10 题 |
| P13 | 判卷方差：同实质答案两轮判决翻转 | afdc33df、3b6f954b |
| P14 | 数据集固有缺陷：金标算术错、which 先行词歧义、人名不在 haystack 等 | 约 7 题 |

## 7. 已经修好的（背景，不必再议）

- 串行摄入（并行分片的同槽位双 accepted 已绝）
- 语言钉死代码层（`src/agent/lang.ts`；真库验证：漂移召回 97%，人工复检 20/20 无误杀）
- 事件扫描通道（`src/agent/triggers.ts`；回测 15 个靶句命中 14 个，噪音 ~2.7 句/会话）
- 空 description 桥接（92% 维度有描述）
- 跨用户隔离（污染类错题连续两轮 ≈0）

## 8. 验证命令（只读）

```bash
npm test                              # 211 测试 + 产品/基准边界守卫
node benchmark/longmemeval/smoke-reingest.mjs   # 抽取改动质检门（~20 调用，写临时库）
```

库文件：`benchmark/longmemeval/data/memory.db`（v5 现役）+ `memory.db.old-{38,71,74}pct`、`memory.db.old-v4hybrid`（历史对照）。表结构：`nodes(id,type,state,dimension_id,data)`；语句 type=`core:statement`（data JSON 含 value/source_refs/saidBy/created_at）；维度 type=`core:dimension`（data JSON 含 key/description/cardinality）；向量在 `embeddings` 表。

## 9. 硬约束（协作时请遵守）

- **commit message 不加 Co-Authored-By / Generated-with 等署名**（owner 要求，历史已清理）
- src/ 是产品：禁止 benchmark 词汇（haystack/longmemeval/gold/judge 等）与案例关键词进 src/（`test/boundary.test.ts` 机器强制）
- 成本纪律：抽取层改动 → 先 smoke（~20 调用）再全量（~2000）；读侧改动 → answer+judge（~200）
- 改动先过"真实用户受益"拷问，再过基准回归

## 10. 当前进行时（2026-09-22 晚）

- v5 干净库已换上，500 题全量评分（tag=v5-500）运行中——它将是第一个可干净归因的基线（82.2% 混着四个变量，不能当净效应读）
- 16 条错因清单（写路径 6 / 存储工序 3 / 读路径 5 / 判卷与数据集 2）逐条讨论进行中；#1（旁插事件）的扫描通道已落地，#2（载荷压缩）、#7（key 漂移）为接下来的主战场
- 架构天花板评估：当前抽取/判卷模型（deepseek-v4-flash）+ 本架构 ≈ 88-90%；更高的部分需换更强的模型，不是架构问题
