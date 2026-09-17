# edgelore 竞品分析：AI Agent 记忆系统调研

> 调研日期：2026-09-17
> 目的：用户要求确认市面上是否已有同类项目（agent 共享记忆图 / Memory Agent），看别人怎么做，避免闭门造车。
> 数据来源：GitHub、各项目官网/文档、第三方横评（2025-12 时点 star 数与阶段划分）。star 数为彼时近似值，仅作量级参考。

---

## 1. 结论速览（先看这个）

市场已经非常拥挤，2025 年被称为 "Memory Era"。但**几乎没有人把"约束自检"当一等公民**——大家都在做"自动抽取事实 + 存起来 + 检索出来"。

edgelore 目前落地的**类型化图 + 约束表达式引擎 + 本地 SQLite** 路线，恰好卡在"图谱派"（Zep）和"本地派"（OMEGA/Engram）之间，而且那块**约束表达式引擎（M1 已实现）是竞品普遍缺失的独特卖点**。

短板也很明显：我们没有 LLM 自动抽取（Agent Memory 层还没做）、没有语义检索（"取"还没做）、没有 MCP 生态（M4 才做）。这三块是通往"真自己长"的必经路。

---

## 2. 行业全景：三个演进阶段（2025 横评共识）

| 阶段 | 时间 | 代表 | 核心思路 | 典型基准分 |
|---|---|---|---|---|
| 工程化集成 | 2023–2024 | Mem0、Supermemory | 自动抽取 + 向量库，封装复杂 DB 操作 | LoCoMo 60–70% |
| 结构化与图谱 | 2024–2025 H1 | Zep/Graphiti、Memobase | 知识图谱 + 时间轴，解决"相似≠相关"、时序错乱 | ~75% |
| 认知架构 | 2025 H2 | MemU、MemOS、EverMemOS、Mirix | 抛弃"数据库"隐喻，用"大脑/OS"隐喻，多智能体+记忆提纯 | 85%+，逼近 90% |

edgelore 当前处在**第 2 阶段（图谱 + 本地）**，但带了一个第 3 阶段才该有的"校验/约束"能力。

---

## 3. 主要竞品逐一点评（只挑和我们最相关的）

### 3.1 Zep / Graphiti —— 时序知识图谱（最强"图谱"对标）
- **架构**：三层子图。episode（原始消息/文本/JSON，无损真相层）→ semantic entity（抽取出的实体与事实）→ community（实体聚类，做高层推理）。
- **时间建模**：双时间戳 bitemporal——事件时间 T + 摄取时间 T'。矛盾时不删除，而是给旧边打 `invalid_at`，保留历史。
- **检索**：余弦语义 + BM25 全文 + BFS 图遍历（多跳），再 rerank（RRF/MMR/图距离/交叉编码器）。把 115k token 上下文压到 1.6k。
- **定位**：把记忆做成"企业级服务"，强治理（ABAC、per-graph 隔离、CMEK）。
- **和我们关系**：我们的 node/edge 图方向对了。但我们用"单值维度冲突标 `conflict`"比 Zep 的 `invalid_at` 更轻量；**我们目前缺时间维**，未来裁决冲突可能要补 `valid_from/valid_to`。

### 3.2 Mem0 / Mem0g —— 自动抽取 + 向量/图双存储（最强"写入端"对标）
- **写入管道（六段）**：存新记忆 → 查相关（防重）→ LLM 蒸馏事实 → 去重+向量化 → 图实体链接 → 时间推理。
- **ADD-only 架构**：不覆盖、不删。矛盾靠 `created_at` 降序取最新值。
- **四操作**：ADD / UPDATE / DELETE / NOOP，由 LLM 函数调用决策。
- **隔离**：强制 scope key（user_id / agent_id / run_id），杜绝跨租户泄漏。
- **Mem0g**：有向标记图（实体=节点，关系=边），矛盾关系标 invalid。
- **和我们关系**：我们的 `capture` 等价于 Mem0 管道的"写入端"。我们未来要补的 **Agent Memory 层 = Mem0 的"抽取/去重/冲突决策"前半段**（把一句话→JSON）。我们"字段三分法"（provenance 系统填 / 内容 Agent 填 / 机制系统生成）比 Mem0 的职责划分更清爽。

### 3.3 Letta (MemGPT) —— 自编辑记忆（Agent 自己管记忆）
- **三层**：core（常驻上下文的可编辑块，如 human/persona）→ archival（向量库，按需检索）→ recall（完整对话历史，可搜）。
- **自编辑**：Agent 通过 tool calling 自己 `core_memory_append/replace`、`archival_memory_search`，决定何时记、何时改。
- **sleep-time compute**：空闲时后台 agent 整理主 agent 记忆、消解矛盾、预计算关联。
- **和我们关系**：我们的"取"未来要给 LLM 喂工作记忆，Letta 的 core/archival 分页思路可借鉴；但我们没打算让 Agent 直接改原始存储（我们用 capture 受控写入 + Q01 人审闸门）。

### 3.4 OMEGA Memory / Engram —— 本地优先 + SQLite（最强"本地路线"对标）
- **OMEGA**：SQLite 后端，25 个 MCP 工具，auto-capture / auto-surface，全本地零云，宣称 LongMemEval 95.4%。
- **Engram**：Go 二进制，SQLite + FTS5，MCP/HTTP/CLI/TUI 多接口，显式冲突处理，刻意用确定性词法召回对抗"什么都 embedding"。
- **和我们关系**：**我们的 SQLite 持久化 + 本地优先定位，和这两个完全一致**。M4 做 MCP 时直接对标它们即可，不必另起炉灶。

### 3.5 其他值得扫一眼
- **A-MEM**（NeurIPS 2025）：Zettelkasten 原则，动态互联知识网络，Agent 动态索引/链接/演化记忆结构。
- **Cognee**：向量 + 图，ECL（Extract/Cognify/Load）管道，6 行代码。
- **Memary**：知识图谱跟踪实体/偏好/聊天历史，交互时自动更新。
- **Supermemory**：知识图谱式超记忆，宣称 LongMemEval/LoCoMo 第一。
- **LangMem**：LangChain 官方 Memory SDK，自适应记忆。
- **Memobase**：基于用户 profile 的长期记忆，适合虚拟角色/教育/个性化助手。

> 行业信号：**MCP 已成为记忆系统标配**——awesome-agent-memory 列表里几乎所有框架都 ship 了 MCP server。这印证了我们"M4 换 MCP"的排期是对的。

---

## 4. 对比维度表

| 维度 | Zep/Graphiti | Mem0 | Letta | OMEGA/Engram | **edgelore（我们）** |
|---|---|---|---|---|---|
| 核心隐喻 | 时序知识图谱服务 | 自动抽取+双存储 | 自编辑分层记忆 | 本地 SQLite 记忆 | **类型化图 + 约束引擎** |
| 存储 | Neo4j 等图 DB | 向量+图+SQL | 向量+DB | SQLite | SQLite（JSON blob） |
| 写入方式 | 自动抽取实体/事实 | LLM 六段抽取 | Agent 工具调用 | auto-capture | **capture(JSON)** |
| 冲突处理 | `invalid_at` 不删 | ADD-only + 时间戳 | 后台整理 | 显式冲突 | **单值维度标 `conflict`** |
| 检索 | 向量+BM25+BFS | 向量+BM25+实体+时间 | 向量检索 | SQL/FTS | 取：未来 RAG |
| 触发 | 被动（应用调） | 每轮消息后异步 | Agent 自主 | 自动 | 未来 |
| 生态 | MCP、云/自托管 | MCP、云/自托管 | REST/MCP | MCP | M4 做 MCP |
| **独有卖点** | 时间推理+企业治理 | 生产级抽取管道 | 自编辑+分页 | 本地零云 | **约束表达式四态自检** |

---

## 5. edgelore 的定位与差异化

**我们卡在"图谱 + 本地"象限**：比 OMEGA/Engram 多了图谱推理，比 Zep 轻、可本地跑、自带约束校验。

**王牌差异化 = 约束表达式引擎（M1 已实现）**：
竞品都在"存事实 + 检索"，没有一个提供"声明式约束 + 四态自检"（satisfied / violated / indeterminate / error）。edgelore 的 D09 白名单运算符能对记忆做"校验层"——例如"预算 ≤ 5000""SLA 必须 < 200ms"这种规则可以直接写表达式、自动检查记忆是否违规。**这是需要"记住的东西必须满足某些规则"场景（合规、预算、SLA、风控）的天然切入点，竞品空白。**

**辅助差异化**：
- open-world typed nodes + cardinality（单值/多值），单值冲突主动升级（比 Mem0 全保留更主动，但裁决留人审）。
- 字段三分法（provenance 读取 / 内容 Agent 操作 / 机制系统生成）职责清晰，接口最小。
- 存储层（capture 消费 JSON）与 Agent Memory 层（未来）严格分离，扩展点干净。

---

## 6. 对我们的启发 / 下一步建议

1. **M4 必须认真做 MCP**：MCP 已是记忆系统标配，OMEGA/Engram 都是 MCP-first。我们 M3 用 CLI 桥，M4 换 MCP 正路，直接对齐生态。
2. **Agent Memory 层（未来里程碑）= Mem0 的"抽取端"**：LLM 把一句话 → `capture` 的 content JSON。没有它，我们只能手动喂 JSON，而 Mem0/Zep 的核心价值正是自动抽取。这是"真自己长"的第一块拼图。
3. **"取"/RAG 是必做**：Zep 的 BFS+向量+BM25 检索是核心能力，我们的"取"原语不落地就比不了检索。
4. **时间维缺失要注意**：Zep 的 bitemporal 很关键（矛盾靠时间判）。我们单值冲突现在"先标不裁决"，未来裁决时大概率要补 `valid_from/valid_to` 或置信度——M3 边界里留了 TODO。
5. **冲突策略选型**：Mem0 全保留（ADD-only）vs 我们"单值标 conflict 升级"。我们更主动，但"谁对"的裁决逻辑要靠 M0 设计的 Q01 人审闸门，目前未实现裁决。
6. **评测基准**：行业用 LongMemEval / LoCoMo / ConvoMem。我们未来做 Agent Memory 层时可参照自测，而不是只靠 46 个单元用例。

---

## 7. 一句话总结

市场拥挤，但**没人把"约束自检"做成一等能力**。edgelore 若坚持"类型化图 + 约束表达式引擎 + 本地优先"，能在"记忆必须满足规则"的细分场景（合规/预算/SLA/风控）找到差异化立足点。当前最大短板是**自动抽取（Agent Memory 层）** 和 **语义检索（取）**——这两块是通往"真自己长"的最高优先级，应排在 M4 之后。
