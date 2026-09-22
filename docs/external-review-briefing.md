# edgelore 摄入架构评审简报（给外部模型/顾问）

> 写给被请来评审的 AI（或人）。读完本文 + 按阅读路径翻材料，你就能对"摄入到底该怎么优化"给出有根据的意见。
> 写作日期：2026-09-22。所有数字都可复验（验证命令见文末）。

---

## 0. 一句话上下文

edgelore 是一个给 AI Agent 用的**共享长期记忆系统**：把对话抽成"维度（key）→ 语句（值）"的知识图谱存进单个 SQLite，带约束引擎、冲突裁决、 provenance。当前在一个叫 LongMemEval 的长程记忆基准上回归验证（500 题），但**它不是做题机器——一切优化只对真实用户价值负责**（这条是 owner 的红线，见 §2）。

你的评审对象：**摄入管线**（对话 → 记忆的写入路径）。它决定了这个系统的上限——读侧（检索+答题）只能兑现摄入存下的东西。

## 1. 阅读路径（按序）

| 序 | 材料 | 回答什么问题 | 精读点 |
|---|---|---|---|
| 1 | 本文档 | 全景 + 事实底座 + 开放决策点 | — |
| 2 | `README_CN.md` | 产品是什么、差异化（约束引擎） | 前言即可 |
| 3 | `docs/agent-memory-design.md` | 摄入管线的设计文档（gate→extract→capture 三段） | §4 两段式结构 |
| 4 | `docs/notes/autopsy/v4-full500-autopsy.md` | 上一轮 500 题全量错题解剖：失败模式分布、18 题回归归因、架构极限评估 | §0 混合库发现、§5 合成、§6 评估 |
| 5 | `src/agent/prompt.ts` | 抽取 prompt 原文（批量模式 `buildBatchExtractionPrompt`） | few-shot 例子的形状、规则列表 |
| 6 | `src/agent/capture.ts` | 存储原语：地址查找、去重、冲突标记、provenance 注入 | 冲突分支 |
| 7 | `src/agent/runtime.ts` 的 `relevantDimensionsOf`（L213） | 已有维度怎么喂给抽取 prompt（top-30 词面打分） | 打分函数 |
| 8 | `src/agent/triggers.ts` + `src/agent/lang.ts` | 两个"代码层强制"防线的样子（事件扫描 / 语言钉死） | 设计注释 |
| 9 | `benchmark/longmemeval/ingest.mjs` | 批量摄入编排（串行、断点、语言过滤+重试） | 主循环 |
| 参考 | `HANDOFF-v3.md`（根目录，不进 git） | 工作底稿：决策冻结表、坑清单 | — |
| 参考 | `docs/notes/autopsy/stage3-full500-autopsy.md` | 上上轮（74.2%）的解剖，做两轮对比用 | 各分片结论 |

## 2. 产品红线（评审时请以此为前提）

1. **宁少勿滥**：记忆系统宁可不记，不可记错/记滥。gate 白名单制，"一次性长期事件"在白名单内。
2. **不是做题架构**：LongMemEval 只做回归锚。任何按基准金标措辞/判卷口味设计的行为都被视为过拟合。"没见过这个基准的真实用户也受益吗？"是每个提案的第一问。
3. **标而不裁**：冲突永不覆盖，标记后等裁决（人审 / 约束裁判 / confirm 转正）。
4. **双信任源**：用户陈述 → accepted；助手结论 → tentative（需确认）。
5. **已证死路，请不要建议**（都被实验证伪或有明确决策）：
   - prompt 措辞级语言钉死（实测 20-30% 漂移率，已改代码层强制）
   - few-shot 保全措辞解决载荷压缩（两轮 0/13，逐题同丢）
   - 把维度清单全量喂 prompt（624KB 超上下文事故，窗口封顶是冻结决策）
   - ANN 索引（<10 万语句不做）、cross-encoder 重排（速度毒药）、细粒度话题标签（硬编码词表，owner 明确反对）
   - 回滚拒答纪律（rule 7 的过冲要用"适用边界"修，不是回滚）

## 3. 事实底座（关键数字，全部可复验）

| 项 | 值 |
|---|---|
| 基准成绩 | v4 轮 82.2%（410/499，**三语混合库上取得**）；v3 轮 74.2%；基线 28.2% |
| 当前库 v5（干净库，2026-09-22 重摄） | 6708 语句 / 5956 维度 / 向量 100% / 覆盖 939/940 会话 / 语言 en 纯层（es=0, zh=0）|
| 旧 v4 库 | 13499 语句 = 旧中文层 4493 + 英文层 9006（其中 20-30% 漂移成西语）；已被 v5 替换（备份 `memory.db.old-v4hybrid`）|
| 维度近亲 | v5 内 Jaccard≥0.5 的直接近亲对 **4278**（见 §5 案例）；v4 混合库为 11027 |
| 错题失败模式（89 题，v4 轮） | (a) 抽取丢失/压瘪 44%、(d) 推理/拒答纪律 33%、(b) 检索聚合 16%、(e) 判卷噪声 7%、(c) 污染 1% |
| 18 题回归的归因 | 10 题 = 拒答/对冲纪律过冲（读侧）；4 题 = 抽取丢失被上轮运气掩盖；2 题 = judge 方差；1 题 = 双层库挤占；1 题 = 世界知识代答 |
| 摄入成本 | 全量 940 会话 ≈ 1888 调用 / ~5M input tokens / 150 分钟 |
| 答题侧窗口 | 检索 k=10（聚合题经决策层 Jev 放大到 30）、渲染 ≤48 行、每维度 ≤8 条 |
| 摄入侧窗口 | 批量抽取每会话 ≤12 条事实；已有维度清单 top-30（词面 bigram 打分）|

## 4. 摄入管线现状（两条路）

```
产品路径（每轮实时）：turn → gate(值得存?) → extract(结构化) → capture(落库) → 向量
批量路径（940 会话摄入用）：会话 → 事件扫描 → 一次批量抽取 → 容错解析 → 语言钉死 → capture×N → 向量
```

逐步（带真实案例）：

1. **入口**：会话 turns 带角色前缀（`[user]/[assistant]`），会话日期注入（相对时间换算锚）。
2. **事件扫描**（触发层 v0，`src/agent/triggers.ts`）：确定性正则扫 user 轮"第一人称 ∧ (时间词 ∨ 旁插标记)"句，命中句作为"必须逐条裁决"清单进 prompt。战果：三个两轮全丢的旁插事件（DC 六小时车程 / 6月3日 BBQ / 捐咖啡机）在 v5 全部入库。
3. **批量抽取**（一次 LLM 调用）：角色 + few-shot（日期解析、saidBy 署名）+ 规则（相对时间→绝对日期、数字原样、旁插算记忆、语言钉死）+ **必裁块** + **knownDimensions top-30** + 会话日期 + 全文 → `{contents:[{dimensionKey, value, saidBy, dimensionDescription?, cardinality?, unit?}]}`，上限 12 条。
4. **容错解析**：坏条目跳过计数（不连坐）、`NEW:` 剥壳、裸数字强转、saidBy 非法丢署名保事实。
5. **语言钉死（代码层）**：`dominantLang(会话)` → 每语句 `detectLang`，置信外语丢弃，漂移占主导则重抽一次。v5 实战丢弃 29 条。
6. **capture()**（存储原语）：
   - 找地址：key 存在 → 复用；不存在 → 铸新维度（description + cardinality=single|multi）
   - 去重：同维度同值（逐字）→ dedup
   - **冲突标记**：single 维度已有 accepted 用户值 + 新值不同 + 来源不同 → 新语句 tentative + 维度 conflict，**永不覆盖**
   - provenance 系统注入（created_by / source_refs / created_at），模型无权填写
   - 双信任源：user→accepted，assistant→tentative
7. **向量**：每会话落库后批量 embedding（qwen3.7-text-embedding, 1024 维）。
8. **冲突裁决**（benchmark 无人审，产品里三通道）：resolve 人审 / autoresolve 约束裁判 / confirm 助手转正。ask 层 rule 3（最新用户陈述优先，tentative 也算数）是无人审场景的补丁。

## 5. 核心病灶：维度 key 漂移（你要评审的主要问题）

**现象**：v5 干净库内仍有 **4278 对**"词面近亲"维度。两类混杂：

**A 类：真别名（同一事实、不同地址，该合并）**
```
[hawaiiFamilyTrip]  "Completed island-hopping trip to Hawaii with family"  ← 会话 60e8941a 铸
[familyTripHawaii]  "Recent family trip to Hawaii, enjoyed snorkeling"    ← 会话 02e66dec 铸
（同一趟旅行；另一对 masterMarketingPlan/marketingMasterPlan 是纯词序翻转，两个会话各铸一个）
```

**B 类：假近亲（同类型不同实例，合并=毁数据）**
```
[ufMbaProgramDetails]  "University of Florida MBA: ranked #24 online..."   ← J=1.00！
[asuMbaProgramDetails] "Arizona State University MBA: ranked #25 online..."
（两所大学的 MBA，必须分开。同型的还有 cowPurchasePlan/dogBedPurchasePlan、
  dayTripPlanning/laTripPlanning/sfTripPlanning——词面 Jaccard 分不清 A 和 B）
```

**根因链**：
1. "这是不是已有概念的另一个名字"是**全局+语义判断**，但实现上交给了**每次抽取调用现场决策**；
2. 现场只带 top-30 已有维度，且打分是**词面 bigram containment**（对整会话长文本区分度接近噪声，30 个名额被全会话所有话题分摊，零分时兜底返回任意前 30）→ 已有的 `familyTripHawaii` 物理上不在现场 → 只能铸新；
3. camelCase 组词是自由生成不是查表：看见也可能翻词序（masterMarketing/marketingMaster）、改详略（jewelryCleaningPlan/jewelryCleaningKitPlan，同会话内都漂，全库批内漂移 1056 对）；
4. prompt 反漂移规则（rule 4/5）是 prompt 级——与语言钉死同一课：**prompt 级规则防不住采样本性**。

**危害**：同一事实散在多地址 → 检索窗口（k=10/30）装不下全部 → 计数/知识更新题漏项、旧值复活。上轮 KU（知识更新）错题的头号死因。

**现有工具的问题**：离线合并脚本 `benchmark/longmemeval/alias-merge.mjs` 用 union-find 把 J≥0.5 的对做传递闭包——实测会链出 **321 个维度的怪物组**（在线学习资源、数据可视化、野马车升级件全部连体），且无法区分 §5 的 A/B 两类。**已挂起，等待判据修复。**

## 6. 开放决策点（请重点给意见的部分）

**D1. key 归一的治本位置**
- 选项 a：`relevantDimensionsOf` 从词面 bigram 换成**向量检索**（transcript 嵌入反正要算；维度用名下语句向量质心代表；本地相似度零 API 成本）——让"该看见的 key 真的在窗口里"
- 选项 b：capture 层**同槽位检查**：铸新 key 前用嵌入相似度找候选已有维度，命中则问决策层（TypeSafe Jev，99ms/免费）"这是同一槽位吗"
- 选项 c：事后合并兜底（需先修判据：反链式 + 同槽位语义确认）
- 我的倾向：a 先行 + c 兜底。**请评审：a 的窗口会不会把"词面远但该看"的 key 挤出去？b 的调用成本与延迟值得吗？c 的判据怎么区分 §5 的 A/B 两类？**

**D2. 载荷压缩的机械检测**
抽取后校验：会话原文的数字字面量（$185、45 minutes、10-12）未出现在任何输出语句 → 机械报警 → 重抽一次。与语言钉死同一哲学（能机械验证的不靠 prompt 自觉）。**请评审：误报率与重抽成本的平衡？除数字外还有什么可机械验证的载荷（URL/专名/引文长度）？**

**D3. 语义改述去重（降冲突噪声）**
capture 去重只认逐字相同；同事实改述（"Uses Shell rewards near office" vs "Shell rewards program member"）被标成 conflict。候选：嵌入相似度 > 阈值 → 算改述不算冲突。风险：真冲突（wear count 4 vs 6）绝不能被吞。**请评审：阈值策略？只在 single 维度做？要不要 saidBy 一致才判改述？**

**D4. 助手内容住进用户维度**
助手调研数据（"Corolla EPA 53mpg"）与用户自述（"my car averages 32mpg"）挤同一维度，是账本污染的温床。候选：影子维度（key::assistant）/ 检索降权 / 维持现状靠答题规则。**请评审：哪种对"账本优先"语义最干净？**

**D5. maxFacts=12 的预算分配**：助手推荐清单与用户事件自由竞争，输的总是事件。要不要给事件类保底配额？还是事件扫描的必裁块已经够？

**D6. 相对日期锚定的系统性错误**：裸日期（"December 12" 无年份）被锚成未来。候选：抽取规则改为"无年份取会话相对过去的最近一个"。小改动，请确认无副作用。

## 7. 已经修好的（不必再议）

- 串行摄入（并行分片的同槽位双 accepted 已绝）
- 语言钉死代码层（E5，`src/agent/lang.ts`，漂移召回 97%/误杀≈0）
- 事件扫描通道（触发层 v0，`src/agent/triggers.ts`，旁插事件 14/15 命中，~2.7 句/会话噪音）
- 空 description 桥接（92% 维度有描述）
- 跨用户隔离（污染类错题连续两轮 ≈0）

## 8. 验证命令（全部只读，可自己跑）

```bash
node --experimental-sqlite -e "..."   # 语句/维度/语言普查（见 HANDOFF-v3.md 工装节）
npm test                              # 211 测试 + 产品/基准边界守卫
node benchmark/longmemeval/smoke-reingest.mjs   # 抽取改动质检门（~20 调用，写临时库）
```

库文件：`benchmark/longmemeval/data/memory.db`（v5 现役）+ `memory.db.old-{38,71,74}pct`、`memory.db.old-v4hybrid`（历史对照）。表结构：`nodes(id,type,state,dimension_id,data)`，语句 type=`core:statement`（data JSON 含 value/source_refs/saidBy/created_at），维度 type=`core:dimension`（data JSON 含 key/description/cardinality），向量在 `embeddings` 表。

## 9. 硬约束（协作时请遵守）

- **commit message 不加 Co-Authored-By / Generated-with 等署名**（owner 明确要求，历史已清理）
- src/ 是产品：禁止 benchmark 词汇（haystack/longmemeval/gold/judge 等）与案例关键词进 src/（`test/boundary.test.ts` 机器强制）
- 成本纪律：抽取层改动 → 先 smoke（~20 调用）再全量（~2000）；读侧改动 → answer+judge（~200）
- 改动先过"真实用户受益"拷问，再过基准回归

## 10. 当前进行时（2026-09-22 晚）

- v5 干净库已换上，500 题全量评分（tag=v5-500）运行中——它将是第一个**可干净归因的基线**（82.2% 混着四个变量，不能当净效应读）
- 错因清单共 16 条（写路径 6 / 存储工序 3 / 读路径 5 / 判卷与数据集 2），逐条讨论进行到 #1（事件扫描已落地）；#2 载荷压缩、#7 key 漂移是接下来的主战场
- 架构天花板评估：flash + 本架构 ≈ 88-90%；破 90 需更强的抽取/判卷模型，不是架构问题
