# 记忆类型分层（episodic/semantic/procedural）调研与决策

> 日期：2026-09-19 · 三路并行调研：外部框架查证（一手来源）+ 本地代码映射 + 评测证据归因
> 结论：**不推翻"先不加显式 type 字段"的冻结决策，但改标"阶段 2 后重新评估"；拆成两个独立决策点（event_time vs 完整三分类）**

## 一、用户记起的框架是什么

| 框架 | 分层 | 性质 |
|---|---|---|
| **Zep / Graphiti**（arXiv 2501.13956） | episode / semantic entity / community **三个 sub-graph** + 可选 Custom Entity Types | 数据结构分层 |
| **CoALA**（arXiv 2309.02427） | working / episodic / semantic / procedural 四层 | 认知科学分类（理论，无实现） |
| Mem0 | 论文：无类型（仅 Mem0^g 实体带 Person/Location/Event）；平台产品：15 个自动 categories | 产品级标签 |
| MemGPT/Letta | core(blocks)/recall/archival——OS 词汇，**不用 CoALA 术语**（社区映射"recall≈episodic"非官方） | 存储/位置分层 |

LongMemEval 是基准测试，不是框架。用户记的"三层"最可能是 Zep 的三 sub-graph 或 CoALA 去 working 后的三层。

### 补充查证：LangMem（LangChain，2025-02 发布）

用户实际记起的是 LangMem。其官方概念指南确实用 semantic/episodic/procedural 三分类（即 CoALA 去 working memory）：

| 认知科学 | LangMem 语义 | LangMem 实际做法 |
|---|---|---|
| Episodic | 过往交互经历 | 保留成功交互作为 **few-shot 学习示例** |
| Semantic | 事实/偏好/知识 | 结构化事实存储，个性化 |
| Procedural | 规则/行为指令 | **持续优化 Agent 的系统提示** |

**关键发现：LangMem 自己的检索也没有按类型路由**——检索是 `search_memory` 语义相似度/向量 + LangGraph Store namespace 分区；"三类型→三检索策略"（时间查/相似查/场景触发）是认知科学的理想映射，LangMem 实现的是"写时分型、读时同门"。也就是说：**连这个框架的代表实现都没有证明"类型标签改变检索策略"的收益**。
来源：https://langchain-ai.github.io/langmem/concepts/conceptual_guide ｜ https://www.langchain.com/blog/memory-for-agents ｜ https://www.langchain.com/blog/langmem-sdk-launch

## 一点五、核心架构洞察：edgelore 是"按结构分型"，LangMem 是"按标签分型"

LangMem 需要类型字段，因为它把三种记忆存进**同一个 bag**（LangGraph Store），不打标签无法区分。edgelore 的图**节点结构天然区分了存储层**：

| 类型 | LangMem | edgelore 现状 |
|---|---|---|
| semantic | 同一 Store + semantic 标签 | ✅ Dimension/Statement 结构就是它 |
| procedural | 同一 Store + procedural 标签 | ⚠️ Constraint 结构就是它（表达式引擎+Q01 人审+四态），**缺生产线**（gate 识别的规则被降级成 statement） |
| episodic | 同一 Store + episodic 标签 | ❌ **缺行为结构**：无 event_time、事件被拆散成 statement、gate 会滤掉一次性事件 |

→ 对 edgelore，问题不是"加不加标签"，而是**补齐让三种检索策略跑起来的两个结构**。标签在结构补齐后甚至可以从结构推导（有 event_time → episodic；是 Constraint 节点 → procedural；其余 → semantic）。

## 二、外部证据（关键、且反直觉）

**"类型标签提升检索质量"没有任何受控证据，反面信号倒不少：**

- Zep：类型只用于路由搜索字段（edge→fact、entity→name），**episodic 层自家检索实验都没用**（future work）；论文无组件消融
- Mem0 论文管线：纯向量检索零类型参与；平台 categories 是异步打标产品功能——**官方文档自认**：类别多会 "dilute accuracy"、换类别表不回溯旧数据（系统性标签漂移）、建议固定标签用 metadata 别用推断 categories；源码里 `mentions` 计数"写而不读"
- Mem0 vs Mem0^g（最接近的对照）：temporal +2、**multi-hop −4**，分裂
- Letta 裸文件 74.0% > Mem0 图 68.5%（LoCoMo）——无类型原始流赢了类型化管线（跨系统，非消融）
- 四家全部没有"同系统去类型"消融

**唯一强证据：bi-temporal（事件时间 vs 摄入时间）**。Zep 是四家唯一完整落地（`valid_at/invalid_at/created_at/expired_at` 四字段、矛盾失效不删除、t_ref 解析相对时间）；LoCoMo/LongMemEval 的 temporal 类问题上显式时间结构一方占优。Mem0 论文还证明：显式提示下 LLM 稳定打时间戳都会失败——**时间字段要靠 schema 保证，不能靠 prompt 自觉**。

来源：Zep 论文 https://arxiv.org/html/2501.13956v1 ｜ Mem0 论文 https://arxiv.org/html/2504.19413v1 ｜ Mem0 categories https://docs.mem0.ai/platform/features/custom-categories ｜ CoALA https://arxiv.org/html/2309.02427v3 ｜ MemGPT https://arxiv.org/html/2310.08560v2 ｜ Letta 裸文件 https://www.letta.com/blog/benchmarking-ai-agent-memory ｜ Zep 反驳 Mem0 https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

## 三、edgelore 现状映射（半做）

| 认知层 | edgelore 对应物 | 状态 |
|---|---|---|
| **semantic** | DimensionNode + StatementNode（槽位-值对） | ✅ 显式，核心已建模 |
| **procedural** | Constraint 机器（Q01 人审 + M1 四态引擎）**齐全但零生产路径**——gate 认出的 constraint/lesson 候选全被降级存成 statement；lesson 无 why/适用条件字段 | ⚠️ 脑裂 |
| **episodic** | 最弱：事件无结构（一个 turn 拆成 N 条 statement，事件身份/顺序/时长全丢）；只有 created_at（说话时间），无 event_time；core:message/source/said_by 边定义了但零生产者（saidBy 边在本轮 W2 接线） | ❌ 缺口最大 |
| **working** | retrievalContext（临时渲染、按构造易逝） | ✅ 设计正确 |

隐式分类法已在 gate 白名单存在（decision/preference/constraint/fact/quantity/relation/lesson-feedback 七类），**但类型在 gate 产生、在 extract 丢弃**。事件类（W3 拟加的 "one-off event with lasting significance"）会渗入白名单而存储层无结构承接。

## 四、评测归因（类型系统能救哪些分）

- 类型系统**能解释的失分**：多会话（部分——gate 把一次性事件当 transient 过滤，具名实例：婚礼/烟熏炉/音乐会）、时间推理（数据层——"上周五开会"的 created_at 是说话日期，全称缺陷）、偏好粒度（部分——procedural 规则形天然强制细粒度）
- **不能解释的**：单会话助手 7.1% 是署名问题（saidBy，W2/W3 已覆盖）；拒答/知识更新/单用户是门槛/漂移/模型问题
- 预期增量（W1-W5+两阶段之后的边际）：整体 **+2~6pp**（中心 ~+4pp → ~48-53%）；时间推理能力内 +8~15pp、多会话 +3~10pp、偏好 +5~15pp
- 顺序正确性四条：①最大失分块（235 不当拒答/49 助手丢弃/85 时间拒答）的修复不含类型字段，其中两个必须重摄入后才可测；②W3+W4 已实现 episodic 的一阶收益（prompt 级事件白名单/时间过滤/分组计数/Today 行），类型的边际价值只能在新基线上测；③**漂移先于标签**——同一事件漂成两个 key 时打了 episodic 标签计数照样分裂，别名合并在 M5（不在 W1-W5）；④没有 W1 的种子抽样，任何"加类型涨了多少"都不可信

## 五、决策（拆成两个独立决策点，用"三检索策略"语言重述）

**用户认可的三策略映射（episodic→时间查 / semantic→相似查 / procedural→场景触发）在 edgelore 的落地现状：**

| 检索策略 | 现状 |
|---|---|
| Semantic → 按语义相似查 | ✅ 现有混合检索（向量+词面+RRF）就是 |
| Episodic → 按时间范围查 | 🟡 W4 正在接（dateFrom/dateTo 过滤，暂基于说话时间）；**event_time 才让它正确**——"上周五开会"按说话日期过滤会滤掉正确答案 |
| Procedural → 按场景触发 | 🟡 注入端已有（W4 分组渲染会把命中维度的 active constraint 裁决行 `rule "name" -> verdict` 注入回答上下文）；**缺生产端**——gate 认出的规则被降级存成 statement，永远变不成可触发的 Constraint |

### (a) W6a：event_time 字段 + 入库解析（episodic 行为结构）—— 几乎必加
时间推理是 W1-W5 唯一无覆盖的层；bi-temporal 是全部调研中唯一有硬证据的结构（Zep 唯一完整落地，temporal 类问题稳定占优）；且 LLM 靠 prompt 自觉打时间戳不可靠（Mem0 论文实证），必须靠 schema 保证。**排期：阶段 2 验证后作为独立工作流**（抽取 prompt 解析相对时间 + StatementNode 可选字段 + 检索按事件时间过滤）。

### (a') W6b：constraint 生产线（procedural 行为结构）—— 阶段 2 后候选
gate/extract 识别规则类候选 → 创建真 Constraint 节点（走 Q01 激活）→ ask 层场景触发注入。**benchmark 不直接考这类**（LongMemEval 是用户事实问答），但它是产品价值核心（"上线要先灰度"这类规则被遵守）。与 W6a 互相独立。

### (b) memoryType 显式标签 —— 大概率不需要单独加
结构补齐后可从结构推导（event_time→episodic、Constraint→procedural、其余→semantic）；若确需文档性标签，走 attributes 宽元数据（零迁移）或照抄 W2 saidBy 的一级字段模式。

**升级到结构化 EventNode（路径 C）的信号（任一出现）**：
- W3 事件白名单生效后，多会话计数仍丢条目（→ 需要结构性保留保证，即 EventNode）
- 偏好粒度仍粗（→ 需要规则形抽取 schema 强制拆条）
- 出现"规则要参与回答校验/偏好要常驻 prompt"等**类型驱动的行为需求**——试金石：问"这个字段会改变检索/回答/存储的哪个行为？"答不出就继续等

**不加的信号**：残差主要在维度漂移（根治是 M5 别名合并）和 flash 模型能力。

### 实现路径（若加）
- 路径 A：`attributes.memoryType` 宽元数据——~3 文件、零契约变更，但词表无 schema 约束（正是漂移担忧）；必须在 extract 边界封闭枚举 fail-loud
- 路径 B：StatementNode 一级可选字段（照抄 W2 saidBy 模式：可选 enum + schema m0.1 不 bump + capture 校验 + contract 用例）——**W2 就是这个改动的付费原型，之后边际成本大降**
- 路径 C：新增 `core:event` 节点——只有决定建事件结构时才走，成本最高
- **零代码探针**（阶段 2 后可做）：一次性脚本对现库回填 attributes.memoryType + 用 W1 固定题集 A/B"类型过滤检索 vs 不过滤"，数据达标再走路径 B

## 六、与现有冻结决策的关系

HANDOFF"无显式 type 字段｜先不加，等检索精准后再补｜漂移没修好前标签也会漂"——在 M0-M4 语境下正确，且被外部证据反向加强（Mem0 自己的 categories 漂移教训）。修改：从"永久冻结"改为"**阶段 2 后重新评估**"，重估时按第五节两个决策点分别裁决。
