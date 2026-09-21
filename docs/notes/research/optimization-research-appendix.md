# 优化调研原始报告（附录）

> 三路调研的完整原文：去重/隔离机制（Zep·Graphiti·Mem0·Letta）、时间建模最佳实践、本地差距清单

---

# 附录 A：实体去重/别名合并 与 多用户隔离 调研

# 主流记忆框架的实体去重/别名合并 与 多用户隔离 调研报告

来源：Zep 论文（arXiv 2501.13956）、Graphiti 源码（main 分支 node_operations.py / dedup_helpers.py / edge_operations.py）、Mem0 论文（arXiv 2504.19413）+ OSS 源码（main + v1.0.0 tag）、Letta 博客与文档、Graphiti issue #1771/#934。所有阈值均出自源码/论文原文，非转述。

---

## 1. Zep / Graphiti：写时三级 entity resolution（确定性优先，LLM 兜底）

**触发时机：纯写时（ingestion per-episode），OSS 无事后批量去重。**

机制步骤（源码 `graphiti_core/utils/maintenance/node_operations.py` + `dedup_helpers.py`）：

1. **候选召回**：新抽取的每个实体名做 embedding，对现有实体节点做 cosine 相似搜索（限同一 `group_id`），参数写死：**候选上限 15 个（NODE_DEDUP_CANDIDATE_LIMIT）、cosine 下限 0.6（NODE_DEDUP_COSINE_MIN_SCORE）**。论文版还加了 BM25 全文搜索兜底。
2. **第一级——精确匹配**：名字小写+空白归一化后完全相等 → 直接合并；若多个现有节点同归一名（歧义）→ 升级 LLM。
3. **第二级——模糊匹配（带熵门控）**：3-gram shingle → MinHash(32 置换) → LSH 分带（band=4）召回，再算 Jaccard；**Jaccard ≥ 0.9 自动合并**。熵门控：名字长度 <6 且 token 数 <2、或字符 Shannon 熵 <1.5 的短/低熵名**不走模糊路径**，直接送 LLM（防止 "AI"、"Bob" 这类短名误合）。
4. **第三级——LLM resolution**：剩余节点连同候选列表、episode 上下文一起进 dedupe prompt（论文附录 6.1.2：判定 `is_duplicate` + 返回既有节点 uuid + 生成“最完整的全名”）。LLM 返回 `duplicate_candidate_id < 0` 视为不重复。代码对 LLM 返回做防御校验（越界 id、重复 id 全部丢弃），保证失败时行为退化为“不合并”而非“错合并”。
5. **合并执行**：被判定为重复的新节点**永不落库**；返回 `uuid_map: 新uuid → 幸存节点uuid`，所有新边经 `resolve_edge_pointers(edges, uuid_map)` 重写端点后落库。幸存节点的 name/summary 由后续 summarize 流程覆盖重写；`_promote_resolved_node` 会把更具体类型的 label 上提（generic "Entity" → "Person"）。
6. **边（事实）去重**：同套流程但候选**硬约束在同一对实体的既有边内**（`EntityEdge.get_between_nodes` + hybrid RRF）——防止不同实体对的相似事实误并。重复事实不新建边，返回既有边 uuid。
7. **矛盾处理**：全库 hybrid 搜索找语义相关边，LLM 判 `contradicted_facts`，规则（`resolve_edge_contradictions`）对时间区间重叠的旧边设 `invalid_at`/`expired_at`——**边永不物理删除**，保留历史。

**关键缺口（第三方审查已指出）**：issue #1771（2026-08，Mnemoverse 对 Graphiti 0.29.3 的源码审查）确认——uuid_map 算完即弃，OSS 代码中**没有任何路径持久化 `IS_DUPLICATE_OF` 边**（helper 存在但零调用者），即**错误合并不留审计记录、不可从库内撤销**；且**没有已发布的工作点错误率**，0.9/0.6 是无引用常数。#934（开放中）正是“合并时把矛盾事实标记出来供人裁决”的功能请求。
**无 re-resolution**：只解决“新 vs 既有”，不回头扫库里已有的重复对；Zep Cloud 的图构建是异步后台处理（Mem0 论文实测写入后数小时内检索质量持续变化，说明平台侧确有后台消化）。

来源：[Zep 论文](https://arxiv.org/abs/2501.13956)（附录含 ER prompt 原文）、[node_operations.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/node_operations.py)、[dedup_helpers.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/dedup_helpers.py)、[issue #1771](https://github.com/getzep/graphiti/issues/1771)、[issue #934](https://github.com/getzep/graphiti/issues/934)

---

## 2. Mem0：两代方案——LLM resolver（论文/v1）→ 只加不改+关联（现 main 分支 V3）

**触发时机：写时（add 时逐条判定）。**

**A. 经典 ADD/UPDATE/DELETE/NOOP resolver（论文 + `DEFAULT_UPDATE_MEMORY_PROMPT`，现仍留在 prompts.py）**

1. 抽取候选事实后，对每条**向量搜 top-s 相似既有记忆**（论文配置 s=10，实为 payload 过滤 `user_id/agent_id/run_id` 后的向量搜索）。
2. 候选事实 + 检索到的既有记忆一起交给 LLM 做 function-call，四选一：
   - **ADD**：无语义等价记忆；
   - **UPDATE**：同主题有增量信息 → **保持原 ID 原地改写**，prompt 规则“信息量取多者”（"Likes cheese pizza" vs "Loves cheese pizza" → NOOP 语义，"Loves to play cricket with friends" → UPDATE）；
   - **DELETE**：新事实与既有矛盾 → 删旧；
   - **NOOP**：已存在或无关。
3. 论文附录 Algorithm 1 把判定形式化：`¬SemanticallySimilar → ADD; Contradicts → DELETE; Augments → UPDATE; else NOOP`。
4. **防漂移方式**：注意它的 UPDATE 是**同 ID 原地替换**——即一条记忆只表达一个事实，新信息通过“改写旧条目”而非“新增平行条目”进入，从根上阻止同一事实漂移成多 key；历史记录进 history 表（每条 add/update/delete 都有 old_memory/new_memory 审计行）。

**B. V3 加性管线（现 main 分支默认路径，`_add_to_vector_store`）**：Mem0 后来把 UPDATE/DELETE 从默认路径里**拿掉了**，改为：LLM 抽取时给新事实挂 `linked_memory_ids`（指向上一步向量检索出的相关既有记忆的 ID，prompt 要求“同主题/实体重叠/偏好更新/后续事件”必须 link 不重写）；配 MD5 hash 精确去重（批内 + 批间）+ 归一化。即**改用“append + 显式关联”替代原地改写**，把冲突解释推迟到检索时。

**C. 图谱版实体去重（v1.0.0 `graph_memory.py`，OSS 已移除、平台内置）**：新三元组的 source/destination 实体名 embedding 检索同 user 下既有节点，**cosine ≥ 0.9 取 top-1 即复用**（`mentions` 计数 +1），否则 MERGE 新建；关系检索阈值 0.7。矛盾关系由 LLM resolver **标记 invalid 而非物理删除**（论文 2.2）。

来源：[Mem0 论文](https://arxiv.org/abs/2504.19413)、[prompts.py（resolver prompt 原文）](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)、[main.py（V3 管线）](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)、[v1.0.0 graph_memory.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/memory/graph_memory.py)、[平台 Graph Memory 文档](https://docs.mem0.ai/platform/features/graph-memory)

---

## 3. Letta sleep-time compute：后台 agent 改写记忆，靠“结构隔离 + 自审 + 版本回退”保安全

**触发时机：后台（用户不在线时）。**

1. **结构隔离（核心设计）**：创建 sleep-time agent 时后台实际生成两个 agent——主 agent **被剥夺 core memory 的编辑工具**（只读 + 对话 + 检索），**core memory（memory blocks）的编辑工具全部挂在 sleep-time agent 上**，它可以异步改写主 agent 的 in-context memory 和自己的。收益：对话路径不被记忆操作拖慢，且改坏记忆的是“专职整理者”而非对话者。
2. **改什么**：memory blocks（结构化的 in-context 记忆分区）；sleeptime agent 在对话间隙持续把增量记忆**重整理为干净、简洁、详细的条目**（"MemGPT 增量式记忆会越来越乱，sleeptime 持续修订 learned context"）；也可后台消化新上传的文档数据源。
3. **anytime 语义**：主 agent 随时可读，不等 sleep agent 完成一次完整整理——写读解耦，不存在“整理期间不可用”。
4. **运行时机/频率可配**：`frequency` 设置（越高越费 token、整理越及时）；新旧两代实现：(a) 平台 sleeptime agent 在**每轮对话后**由主 agent 消息触发后台分析；(b) 新的 CLI "Dreaming"（文档 "Memory & dreaming"）：**N 步完成后或 context compaction 时**运行。
5. **怎么验证不弄坏**（三层）：
   - **Agent 自审**："Agent reviews before applying" 选项——提议的记忆修改先放进**第二个后台会话让 agent 审查并修订**后才落盘（产品文档明说：更多 token、**不问人**）；
   - **git 版本化（MemFS）**：记忆是 git-backed 文件系统，大整理（拆大文件、**合并重复**、重构层级）前**强制先备份仓库**，可回退；
   - **体检命令**：`/doctor` 审计记忆的 placement、**duplication**、system-prompt token 占用。
6. 主/sleep agent 可用不同模型：主用快模型，sleep 用强模型（无延迟约束）。

来源：[Letta sleep-time compute 博客](https://www.letta.com/blog/sleep-time-compute)、[Sleep-time compute 论文](https://arxiv.org/abs/2504.13171)、[Memory & dreaming 文档](https://docs.letta.com/guides/agents/memory-dreaming)、[Memory blocks](https://docs.letta.com/concepts/memory-blocks)

---

## 4. 多用户隔离：Zep 硬分区，Mem0/LangMem 软过滤，Letta 以 agent 为边界

| 框架 | 隔离单位 | 硬/软 | 跨用户共享 |
|---|---|---|---|
| **Zep** | **user graph**：每个 user_id 一张独立图 | **硬分区**（图级别，一切抽取/去重/检索只在自己图内；`group_id` 同理限定 Graphiti 图） | ① Graph API 建 standalone（group）图给团队共享；② **UserGroups**：策略型访问控制组，整组用户继承授权访问指定 standalone 图；③ 删用户 = 删其全部 threads+图（RTBF 一次调用） |
| **Mem0** | `user_id / agent_id / app_id / run_id` 四级 scope | **软过滤**：单集合内 payload 过滤（源码：Qdrant `FieldCondition(user_id=MatchValue)`；图谱版则把 `user_id` 写死进每条 Cypher 的 WHERE）。文档明示“只传 user_id 时不约束其他字段”（OR 语义） | 无内建共享记忆；平台有 org→project→（app/user）层级，同一 project 内的 agent 共享 org 配置。坑：默认抽取路径每条事实只挂说话者（user 或 agent 二选一），AND 查询两字段恒空 |
| **Letta** | **agent** 为隔离边界（无 user_id 概念） | 硬边界（每个 agent 独立 context + MemFS） | **显式共享 memory block**：同一个 block 可 attach 到多个 agent，多方读写同一状态（这是唯一的“跨 agent 记忆共享”原语，粒度可控） |
| **LangMem/LangGraph** | **namespace 元组**（如 `("memories", user_id)`），支持动态按对话参数生成 | 软过滤（store 内 namespace 前缀匹配） | 不同 namespace 前缀即可表达共享层（如 `("org", ...)` vs `("user", alice, ...)`） |

对 edgelore 最相关的结论：**Zep 选硬分区是因为它的去重/合并会改写共享结构**（图、社区），软过滤下误跨用户合并是灾难；Mem0 敢用软过滤是因为它的操作单位是“单条记忆”且 resolver 检索被 WHERE 锁在 user 内。

来源：[Zep Users and User Graphs](https://help.getzep.com/users)、[Mem0 Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)、[Mem0 OSS Qdrant 过滤](https://github.com/mem0ai/mem0/blob/main/mem0/vector_stores/qdrant.py)、[Letta Memory blocks / 共享 blocks](https://docs.letta.com/concepts/memory-blocks)、[LangMem](https://langchain-ai.github.io/langmem/)

---

## 5. 通用规律（触发时机 / 置信度 / 人审）

- **触发时机**：Zep/Graphiti/Mem0 全部**写时拦截**（cost 落在 ingest，读路径干净）；Letta 独家**后台 sweep**（cost 落在 sleep，允许“先乱后整”）；LangMem 两条腿（hot-path 工具 + background consolidation）。**没有一家做“既有库的全量回扫 re-resolution”**——包括以工程质量著称的 Graphiti（#1771 证实 uuid_map 即弃、无事后合并）。教训：事后 sweep 一旦实现，必须自带合并记录，否则重蹈 #1771。
- **置信度阶梯是行业共识**：精确归一匹配（无 LLM）→ 强启发式（Graphiti MinHash Jaccard≥0.9；Mem0 图 cosine≥0.9）→ LLM 裁决（两家的 0.6~0.9 中间带）→ 保守放弃（默认不合并）。Graphiti 的**熵门控**（短名/低熵名禁走自动模糊合并）是防误合的关键细节。
- **人审边界**：没有一家在自动路径上等人审；人审只出现在（a）冲突裁决（Graphiti #934 请求中、edgelore 已有人工 resolution）、（b）Letta 的双 agent 自审（替代人审而非征求人审）、（c）Mem0/Zep 平台的 dashboard 事后修正。共同点：**自动化上限压在“可逆/低伤害”操作上，不可逆操作（删除）一律走标记失效**。

---

## 6. 对 edgelore M5 别名合并的具体建议

痛点对齐：`therapyFrequency / therapySessionFrequency / userTherapySchedule` 三 key 各持一值 = Graphiti 论文里“同名不同形实体”的 key 版；多用户共用单库时 `userPlan/userHabit` 互灌 = Mem0/Zep 的 scope 问题。

**A. 隔离先行（合并的前置条件）**
学 Zep 把“用户域 key”硬分区：检索/合并候选生成永远带 user 过滤（Graphiti 候选搜索 `[node.group_id]` 的做法），**别名合并的候选集绝不允许跨 user**。`userPlan` 这类通用 key 的灌水问题本质是缺 scope：要么改成 `user:{id}:plan` 硬分区，要么把“通用 key 定义”放共享层、值放用户层（Letta shared-block 模式：共享的是 schema/block，不是值）。

**B. 写时拦截（M5 主体，学 Graphiti 三级阶梯）**
新 key 写入时，按序执行：
1. **归一化精确匹配**：key 名小写 + 拆 camelCase/snake_case 成 token 集（`therapySessionFrequency` → {therapy, session, frequency}）→ token 集完全相等即别名，直接合。零 LLM 成本。
2. **模糊自动合并（带熵门控）**：token 集交并比 ≥ 0.9（等价 Graphiti 的 3-gram Jaccard 0.9）**且**两侧 key 长度 ≥2 token（熵门控防 `mode`/`name` 类短 key 误合）→ 自动合并。
3. **中间带 LLM 裁决**：key embedding cosine 0.6~0.9 或 Jaccard 0.5~0.9 → 送 LLM（结构化输出 `is_alias + canonical_key + 理由`），并把**两个 key 的现有值、值类型、写入时间**一并给模型——Graphiti dedupe prompt 同样把 summary 一起给 LLM 判，只看名字会漏语义漂移。
4. 都不中 → 新 key。

**C. 合并动作（吸收 #1771 的教训，三件套）**
1. **留合并记录**：uuid_map 式的 `alias → canonical` 映射**落库**（Graphiti 算完即弃被批为不可审计、不可撤销），edgelore 应持久化合并边 + 时间 + 判定依据（哪级判定、置信度、LLM 理由），支持一键拆开。
2. **值合并按 Graphiti 时态规则**：两侧值相容 → 合到 canonical；矛盾 → **不裁决，标记冲突**（旧值设 superseded_at 而非删除），交给已有的 conflict adjudication 层（人工/约束自动）——这正是 #934 的诉求和 edgelore 现有能力的对接点。
3. **端点重写**：合并后旧 key 的历史检索引用全部走 alias 映射（Graphiti 的 resolve_edge_pointers），保证旧会话回放/审计不断链。

**D. 后台 sweep（学 Letta，做补充而非主体）**
写时拦截挡不住“两个 key 在不同时间、各自演化后变得同义”（漂移是过程性的）。建议低频后台任务（对话空闲时，学 sleep-time compute）：
- 扫描对象：同 user 下**值语义或 key 名**高相似的 key 对（embed key 名 + 采样值文本，双信号）；
- 产出动作分层（见 E），**绝不直接改写**——sweep 只提议，改写走与写时同一套合并流程（Letta 的做法：sleep agent 拥有编辑工具，但走显式修订流程）；
- 验证安全：sweep 的合并提议先经第二遍 LLM 自审（Letta "Agent reviews before applying"），且合并前做快照（Letta git 备份思路——edgelore 库加合并前 snapshot 或依赖合并记录做反向操作）。加一个 `/doctor` 式体检：统计同 user 下 key 名 cosine>0.9 未合并对、单 key 值版本数、疑似漂移 key 清单。

**E. 置信度分层（建议的落地表）**

| 层 | 判定信号 | 动作 |
|---|---|---|
| 自动合 | 归一化 token 集相等；或 Jaccard ≥0.9 且类型相容且无值冲突 | 立即合并 + 落合并记录 + 通知 |
| 自动合（强） | LLM 裁决 is_alias 且值相容（更新型） | 合并 + 值按时间取新，旧值标 superseded |
| 标记待审 | LLM 裁决 is_alias 但值矛盾；或中间带 LLM 置信度低；或 sweep 提议未经自审通过 | 不合，打 `suspected_alias` 标签进冲突队列，检索时两 key 都返回并在结果中互链（先止血“散账”，再等人审/约束裁决） |
| 不动 | cosine <0.6；或熵门控拒绝且 LLM 说不是 | 什么都不做 |

**F. 防“检索散账”的兜底（不做合并也生效）**：学 Mem0 V3 的 `linked_memory_ids`——即使暂不合并 key，凡判定“疑似别名”就在两个 key 的记录上互挂 alias 链接，检索命中其一时带出另一个，消除散账的主要伤害；正式合并随后可做。

来源：[Zep 论文](https://arxiv.org/abs/2501.13956) | [Graphiti node_operations.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/node_operations.py) | [Graphiti dedup_helpers.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/dedup_helpers.py) | [Graphiti edge_operations.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py) | [Graphiti #1771](https://github.com/getzep/graphiti/issues/1771) | [Graphiti #934](https://github.com/getzep/graphiti/issues/934) | [Mem0 论文](https://arxiv.org/abs/2504.19413) | [Mem0 prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py) | [Mem0 main.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py) | [Mem0 v1.0.0 graph_memory.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/memory/graph_memory.py) | [Mem0 Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory) | [Mem0 Graph Memory](https://docs.mem0.ai/platform/features/graph-memory) | [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute) | [Letta Memory & dreaming](https://docs.letta.com/guides/agents/memory-dreaming) | [Letta Memory blocks](https://docs.letta.com/concepts/memory-blocks) | [Zep Users and User Graphs](https://help.getzep.com/users) | [LangMem](https://langchain-ai.github.io/langmem/) | [Sleep-time compute 论文](https://arxiv.org/abs/2504.13171)

---

# 附录 B：记忆系统的时间建模调研

我已从所有主要来源（Zep paper + Graphiti source code、Zep blog、LongMemEval paper、Chronos paper、Hindsight paper + benchmarks）收集了所需的一切。以下是完整报告。

# 记忆系统的时间建模 — 最佳实践调研（面向 edgelore W6a: event_time）

## 1. Zep/Graphiti 的 bi-temporal 落地细节

### 1.1 四字段模型与写入规则

每条 fact 边上存四个时间戳，分属两条时间线（论文 §2.2.3，[arXiv:2501.13956](https://arxiv.org/html/2501.13956v1)）：

| 字段 | 时间线 | 含义 | 写入时机 |
|---|---|---|---|
| `t_valid` (valid_at) | T（现实世界） | 事实**在现实中**开始为真的时刻 | LLM 抽取（可空） |
| `t_invalid` (invalid_at) | T（现实世界） | 事实在现实中失效的时刻 | LLM 抽取（可空）；矛盾失效时也可被系统设置 |
| `t_created` (created_at) | T′（事务） | 事实入库时刻 | 系统（= 会话/episode 时间），**必填** |
| `t_expired` (expired_at) | T′（事务） | 事实在库内被标记过期时刻 | 矛盾失效时系统写当前时间，初始为 null |

步骤化（[Zep blog](https://blog.getzep.com/beyond-static-knowledge-graphs/) + 当前源码 [extract_edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py)）：

1. **每条消息携带参考时间戳 `t_ref`**（消息发送时间），作为整个抽取链的锚。
2. 抽取实体/事实时**同一个 LLM 调用同时产出 fact + valid_at/invalid_at**（新版 Graphiti 已把旧版"先抽 fact 再单独跑 date extraction prompt"合并为单次结构化抽取）。prompt 里有显式的 `<REFERENCE_TIME>` 字段，标注 "ISO 8601 (UTC); used to resolve relative time mentions"。
3. 对**已存在的边**（在新 episode 中被再次提及）也重跑时间抽取——"John: I bought an iPhone in July" 之后 "Oh, scratch that, I bought it in August" 会把旧边的 valid_at 纠正为八月。
4. **边失效（invalidation）**：对每条新边，用 LLM 比对同实体对的语义相近旧边找矛盾（[invalidate_edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/invalidate_edges.py)）。发现冲突时：设旧边 `t_expired` = 当前时间；**按 valid_at 排序，现实世界更早发生的边被失效**（解决乱序入库，blog 里的 divorce/marry 例子）；同时**改写旧边 fact 文本**为过去时叙述（"Maria works as a junior manager" → "Maria used to work as a junior manager, until her promotion..."），保证检索读到的语料自洽。

### 1.2 相对时间的解析机制

- **解析者 = LLM，锚点 = `t_ref`**。"two weeks ago" 这类表达式与 `<REFERENCE_TIME>` 一起送入 LLM，在抽取时即转为绝对 ISO 8601（OpenAI Cookbook 的 Graphiti 教程同样如此：["Convert relative times into absolute ISO 8601 datetimes based on the reference timestamp"](https://cookbook.openai.com/examples/partners/temporal_agents_with_knowledge_graphs/temporal_agents)）。
- 当前源码里的 **DATETIME RULES**（值得照抄）：
  - 现在时的事实 → `valid_at = REFERENCE_TIME`；
  - 只提到日期没提时间 → 00:00:00；只提年份 → 该年 1 月 1 日 00:00:00；无时区 → Z(UTC)；
  - **"Leave both fields null if no explicit or resolvable time is stated"**（没有明确或可解析的时间就留 null——防幻觉的显式逃生门）；
  - "Do not hallucinate or infer temporal bounds from unrelated events"。
- 论文版 temporal extraction prompt（附录 6.1.5）还有一条防漂移规则：**"IMPORTANT: Only extract time information if it is part of the provided fact. Otherwise ignore the time mentioned"** —— 只取与本 fact 相关的时间，忽略句中无关时间。

### 1.3 失败率数据

- Zep **没有公布**时间抽取本身的失败率。间接证据：LongMemEval 分题型结果（论文 Table 3）——TR 题从 full-context 36.5%→54.1%（gpt-4o-mini）、45.1%→62.4%（gpt-4o）；但作者自注 **"additional development may be needed to improve less capable models' understanding of Zep's temporal data"**（弱模型读不懂 `valid_at` 范围标注，gpt-4o-mini 在 knowledge-update 上反而降了）。
- 相对时间解析失败率的可比数据来自 LongMemEval 论文 E.4（见 §4）：弱模型做**查询侧**时间范围抽取时 3/4 示例产生假阳性范围。

## 2. 抽取时的时间归一化：各家怎么做

**结论先行：主流框架一致选择"抽取时(in-line)就转绝对时间"，不存在"存原文、检索时再解析"的成熟实现。**

| 框架 | 归一化时机 | 做法 |
|---|---|---|
| Zep/Graphiti | 入库时，单次抽取调用 | LLM + `t_ref` → ISO 8601 `valid_at/invalid_at`（见 §1） |
| Hindsight (Vectorize, [arXiv:2512.12818](https://arxiv.org/html/2512.12818v1)) | 入库时 | 抽取 pipeline 第 2 步就是 "temporal expression normalization and range extraction"，把 "last week"/"in March" 转绝对区间 (τs, τe)；**并在 embedding 前把归一化时间以人类可读形式拼进 fact 文本**，让检索/rerank 也能感知时间 |
| Chronos (PwC, [arXiv:2603.16862](https://arxiv.org/html/2603.16862v1), LongMemEvalS SOTA 92.6%/95.6%) | 入库时 | SVO 事件元组 + `start_datetime`/`end_datetime` **区间**（非点值）；多分辨率归一化：明确日期原样保留、相对引用从 t_conv 计算偏移、"recently"/"last month" 等模糊表达展开成以 t_conv 为中心的**窗口区间** |
| OpenAI Cookbook 教程 | 入库时 | 相对时间 → 基于 reference timestamp 的 ISO 8601 |
| LongMemEval 官方优化（[arXiv:2410.10813](https://arxiv.org/html/2410.10813v2)） | 索引时 + 查询时各一次 | 索引时 LLM 抽 "timestamped events"；查询时 LLM 从问题抽时间范围做过滤 |

实证支持"抽取时归一化"的论据：

1. Chronos：入库时归一化的 event calendar 是**最大消融贡献项**——去掉它准确率近乎腰斩（Chronos Low -34.5 分），占总增益 58.9%；TR 题 90.23%（GPT-4o）/95.5%（Opus 4.6）。
2. LongMemEval：索引时绑定时间戳 + 查询时范围过滤使 TR 召回 +6.8~11.3%。
3. 查询侧只解析一次、且解析的是**短问题**（比长对话便宜且准）；如果解析失败，区间检索退化但语义检索仍在——冗余安全。
4. 例外值得注意：**Hindsight 的查询侧时间解析不走 LLM**——先用规则（两个现成多语言日期解析库）解析 "yesterday"/"last weekend"/"June 2024"，**解析不了再 fallback 到 flan-t5-small 小模型**；再不行就不加时间约束（见 §3）。

## 3. 时间类问题的检索策略

### 3.1 时间范围过滤的工程实现

- **过滤载体是数据库列，不是索引魔法**。Graphiti 把 valid_at/invalid_at 存为 Neo4j/Postgres 属性列，检索时用 [SearchFilters](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py) 做 `valid_at`/`invalid_at` 的比较谓词（SQL/Cypher WHERE），与向量检索组合。Hindsight 用 pgvector + Postgres 列，同思路。
- **匹配语义 = 区间重叠**（Hindsight Eq.13）：`R_temp = {f : [τs_fact, τe_fact] ∩ [τstart_query, τend_query] ≠ ∅}`；再按区间中点距离打分 `s_temp = 1 − |τmid_fact − τmid_query|/(Δτ/2)` 做邻近度排序。Chronos 的 start/end 区间设计同样是为了"编码事件所有可能发生时间而非单点估计"，让过滤命中更稳。
- **把时间拼进被检索文本**也是通用做法：Zep 的 constructor 输出格式化为 `FACT (Date range: from - to)`；Hindsight 在 embedding 和 cross-encoder rerank 输入里都带格式化时间——弱信号通道即使不显式过滤也能靠文本感知时间。

### 3.2 查询意图识别：有，且有两条路线

1. **显式分类/抽取路线（LongMemEval 官方）**：查询时 LLM M_T 判断问题是否"时间敏感"，是则抽 `[τstart, τend]` 过滤候选。**关键失败数据**：M_T 必须用强模型——GPT-4o 在无时间引用的问题上会正确输出 "No date extracted"；Llama 3.1 8B 即使给 10 个平衡的 in-context 示例，仍在无时间问题上**幻觉出时间范围**（如 "How long had I been taking guitar lessons..." → 输出 2023/05/01~05/28），错误过滤直接剪掉正确答案、拉低召回（论文 E.4 Table 11）。
2. **Agentic 路线（Chronos）**：不做硬过滤，而是用 dynamic prompting 生成"每个问题一份的检索指引"（告诉 agent 该查什么、按什么时间范围过滤、如何多跳），agent 通过 tool-call 在 event calendar / turn calendar 上**迭代地**收紧 datetime range；grep 工具兜底精确词匹配。TR 90.23%，SOTA。
3. Hindsight 则是**并行四通道**（semantic + BM25 + graph + temporal），时间通道只在"检测到时间约束"时启用，四路 RRF 融合——即使时间解析失败，其余通道保底。

## 4. LongMemEval 时间推理的 SOTA 公开分析

当前 LongMemEval-S 榜（各系统自报，[hindsight-benchmarks](https://github.com/vectorize-io/hindsight-benchmarks)、[Chronos](https://arxiv.org/abs/2603.16862)）：

| 系统 | Temporal Reasoning | Overall |
|---|---|---|
| Full-context GPT-4o | 45.1% | 60.2% |
| Zep (GPT-4o) | 62.4% | 71.2% |
| Supermemory (Gemini-3) | 82.0% | 85.2% |
| Hindsight (OSS-120B) | 85.7% | 89.0% |
| Hindsight (Gemini-3) | 91.0% | 91.4% |
| **Chronos (GPT-4o)** | **90.2%** | 92.6% |
| **Chronos (Opus 4.6)** | **95.5%** | **95.6%** |

公开分析中的共性结论：

1. **TR 是所有系统的最弱项之一，但也是结构化时间表示收益最大的项**。Hindsight：OSS-20B full-context TR 31.6% → 加记忆架构 79.7%（其余题型也有大涨，证明是架构而非模型在起作用）。
2. **赢家公式 = "双历/双索引"**：结构化事件日历（带区间时间）+ 原文轮次日历（保语义上下文），检索两边都查（Chronos、Hindsight 的 world/experience 网络、Zep 的 episode/semantic 双子图同理）。单纯把对话压缩成 fact 会丢原文上下文（LongMemEval §5.2：fact-as-value 整体降分，仅 MR/TR 题例外）。
3. **区间 > 点值**：Chronos 与 Hindsight 都用 start/end 区间，显式处理"模糊表达→窗口"。
4. **读取侧**：检索结果按时间戳排序喂给 reader（LongMemEval §5.1），Chain-of-Note + JSON 结构化可再提升至多 10 分。
5. **LoCoMo 的 Temporal 题同样印证**：Zep 79.8 vs Mem0 55.5 vs LangMem 23.4 vs OpenAI 21.7——没有 bi-temporal/时间列的系统在时间题上接近随机。

## 5. 对 edgelore W6a（event_time）的具体建议

edgelore 现状痛点映射到调研结论：38% 失分中 38% 来自抽取丢时间锚点；库内只有 `created_at`（= 会话日期，相当于只有 T′ 时间线）而没有 T 时间线。**这相当于只实现了 Zep 四字段的 transaction 半边，event 半边完全缺失**——与 Zep 论文里"TR 36.5% baseline"的失败模式同构。

### 5.1 字段放哪

在现有语句/记忆记录上加**两个可空列**（不要只加一个点值字段）：

- `event_time`（`t_valid` 对应物）：事件发生/开始时间，TIMESTAMP (UTC)，可空，**建 B-tree 索引**（用作范围 WHERE，与 Graphiti 把 valid_at 做成可过滤列一致）；
- `event_end_time`（可选，`t_invalid` 对应物）：仅当语句描述有跨度/终止的状态变化时填（"我在 X 实习了三个月"）。没有就 NULL，不要造默认值。
- `created_at` 保留原义（说话时间 = 事务线），**永远不拿它冒充 event_time**。
- 同时在 `content` 文本里保留/拼入人类可读时间（Hindsight 做法：embed 与 rerank 输入都带 "2026-08-15（两个月前）"式标注）——语义检索通道免费获得时间感知。

### 5.2 抽取 prompt 怎么要（含 fallback）

照抄 Graphiti 的成熟规则，在现有抽取 prompt 中加一段（关键句直接可用）：

```
<REFERENCE_TIME>{当前消息时间戳，ISO 8601 UTC}</REFERENCE_TIME>

DATETIME RULES:
1. event_time 用 ISO 8601 (YYYY-MM-DDTHH:MM:SSZ)。默认视为 UTC。
2. "TREAT THE CURRENT TIME AS THE TIME THE MESSAGE WAS SENT" — 所有相对时间
   ("两周前"/"上周五"/"今天早上") 都以 REFERENCE_TIME 为锚换算成绝对日期。
3. 陈述为现在时/进行时且无其他时间线索 → event_time = REFERENCE_TIME。
4. 只有日期没有时间 → 当日 00:00:00；只有年份 → 该年 1 月 1 日。
5. 语句中没有任何与该事实直接相关、可解析的时间 → event_time = null。
   绝不从无关事件推断时间。
6. 只抽取与该事实本身相关的时间；忽略句中其他话题提到的时间。
```

两个针对 edgelore 取证发现的专项要求：

- **防"整句起点事件丢失"**（"今天做了X"类）：加一条 "如果句子报告了一个动作/事件的完成或发生，即使没有任何显式时间词，也必须保留整句事件并按规则 3 处理 event_time；不要因为'没有时间信息'而丢弃事件本身"。丢失的根源是抽取器把"无时间"误判为"不重要"。
- **fallback 结构**（Hindsight 两级 fallback 的翻译，适配 deepseek-v4-flash 这类较小模型）：抽取仍由 LLM 完成，但**查询侧**解析用"规则优先、LLM 兜底"：规则库（chrono/dateparser 类，中文要选支持"上周/下个月/前天"的）解析绝大多数显式+常见相对表达；规则失败再问 LLM。**绝不让弱模型在"问题没有时间引用"时输出时间范围**——LongMemEval E.4 实证弱模型会幻觉范围剪掉正确答案。若用 LLM 抽查询时间范围，prompt 必须含 "如果问题不涉及时间范围，输出 NO_TIME_RANGE" 并把它当一等输出。

### 5.3 解析失败怎么办

1. **存原文兜底**：LLM 归一化失败时，`event_time=NULL` 但 `time_expression_raw`（原文片段 "about two weeks ago"）保留在记录上——比 Graphiti 更进一步（Graphiti 只留 null），为事后回填和查询侧模糊匹配留钩子。
2. **不硬造**：null 就是 null。"只提年份→1月1日"这类 Graphiti 式粗化可以做，但"完全不知道"时填 created_at 是错的（等于把 T′ 冒充 T，正是当前 bug）。
3. **回填通道**：后续会话出现同一事实的更精确时间（Graphiti 的 "scratch that, it was August" 模式）时允许 UPDATE event_time——时间字段是可修正的，不要 append-only。
4. **监控**：给 `event_time IS NULL 且 time_expression_raw IS NOT NULL`（解析失败）与"起点事件整句丢失"各记一个比率，作为 W6a 验收指标。

### 5.4 检索层怎么用

1. **不要做硬过滤作为唯一路径**。采用 Hindsight 式并行通道：现有 hybrid 检索照跑，新增一条时间通道——仅当查询侧解析出 `[start, end]` 时，用 `event_time BETWEEN ... OR event_end_time BETWEEN ... OR (event_time <= end AND COALESCE(event_end_time, event_time) >= start)`（区间重叠语义）过滤候选后并入 RRF；解析不出范围就完全不启用该通道。
2. **查询意图识别轻量化**：先规则（正则命中"上周/之前/之后/那天/N 月"→走范围抽取），规则不命中则判定 NO_TIME_RANGE 直接跳过——用强模型也不必每问都跑，省一层延迟。
3. **rerank 喂时间**：把 `(event_time 可读形式)` 拼进 reranker 输入文本；返回给回答层的上下文按 Zep 模板格式化 `事实 (时间: 从 - 到)`，未解析的显示原文 `（"about two weeks ago"，约 2026-09-05）`。
4. **读取排序**：命中多条时按 event_time 排序后再交给回答层（LongMemEval 官方设置），knowledge-update 类问题自然取到最新状态。
5. **验证锚点**：以 LongMemEval 时间推理子集为 A/B 基准——Zep 只加 bi-temporal 就从 36.5→54~62%；edgelore 的 W6a 目标可设在同题组 38% → 55%+（对应"补齐 event 半边 + 查询侧时间通道"的最小改动），抽取丢锚点率（§5.3-4 监控项）目标 <5%。

### 来源

- Zep paper: https://arxiv.org/abs/2501.13956 (HTML: https://arxiv.org/html/2501.13956v1)
- Zep blog (bi-temporal 细节/乱序入库/失效改写): https://blog.getzep.com/beyond-static-knowledge-graphs/
- Graphiti 源码 extract_edges.py (REFERENCE_TIME + DATETIME RULES): https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py
- Graphiti invalidate_edges.py: https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/invalidate_edges.py
- Graphiti search_filters.py (valid_at/invalid_at 过滤): https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py
- OpenAI Cookbook Temporal Agents: https://cookbook.openai.com/examples/partners/temporal_agents_with_knowledge_graphs/temporal_agents
- LongMemEval paper: https://arxiv.org/abs/2410.10813 (HTML v2: https://arxiv.org/html/2410.10813v2, §5.4 + E.4)
- Chronos paper: https://arxiv.org/abs/2603.16862 (HTML: https://arxiv.org/html/2603.16862v1)
- Hindsight paper: https://arxiv.org/abs/2512.12818 (HTML: https://arxiv.org/html/2512.12818v1, §4.1.2/§4.2.2)
- Hindsight benchmarks (各系统 LongMemEval 分题型): https://github.com/vectorize-io/hindsight-benchmarks
- Mem0 Temporal Reasoning (valid_from/valid_to): https://mem0.ai/blog (《Introducing Temporal Reasoning in Mem0》, 2026-05)

---

# 附录 C：本地待优化点结构化清单

# edgelore 待优化点结构化清单（路线图合并稿）

> 2026-09-20 · 基于 stage2-autopsy.md / stage2-regression-forensics.md / memory-type-taxonomy.md / HANDOFF-v2.md 四份文档合成，并逐项对照代码与 memory.db 实测核实（只读）。
> 当前 HEAD = `4e3ab68`（relevantDimensionsOf 已提交并接入 ingest.mjs:172——比 HANDOFF-v2 记载更新）。库实测：5,657 维度 / 8,402 语句 / **576 个 conflict 维度**（其中单卡维度 >1 accepted 的跨分片值冲突 131 个）/ **64 组同维度同值重复语句**（抽样证实全部来自 2 个不同会话=孪生/跨分片）/ 45 个 >8 条目的维度（受 cap-8 截断）/ 14 个 >20 条目巨型维度。
>
> **核实中发现的清单外新问题**（已并入下列条目）：
> 1. **created_at 存的是斜杠格式**（"2023/05/28"，全部 8,402 条）：ingest.mjs:55 直接 `haystack_dates[i].slice(0,10)` 入库，违反 Provenance 的 ISO-8601 契约（types.ts:28-38）。斜杠 `"2023/04/10"` 与 ISO `"2023-04-10"` 的 ASCII 比较（`/` 0x2F > `-` 0x2D）使 retrieval.ts:139-141 的 dateFrom/dateTo 过滤对同年日期**静默失效**——这是“按题时间过滤污染”和 W6a 的前置炸弹。
> 2. **EDGELORE_RETRIEVAL_{MODE,K,RRF_SMOOTHING,MAX_ENTRIES_PER_DIM,MAX_CONTEXT_LINES} 五个旋钮在 benchmark 答题路径未接线**：answer.mjs:163-165 只传 `{embedder, vectors}`，cfg.retrieval（config.ts:128-134）被丢弃。改 env 调 k=30 之类的实验目前无效，必须改代码。
> 3. **merge.mjs 按值去重缺口**：capture() 在分片内 dedup（capture.ts:116-119），但 merge.mjs:98-108 跨分片统一维度时只重挂 dimension_id、不按 (dim, value) 去重——64 组孪生重复由此产生。
> 4. 产品逐 turn 路径（runtime.ts:112-118）回退仍用 `knownDimensionsOf().slice(0,50)`（插入序前 50，非相关性），relevantDimensionsOf 只接了 benchmark 批量抽取路径。

---

## A 层：行级改动（每项 ≤20 行；只需重跑 answer+judge ≈200 调用，不动库）

| # | 名称 | 对应失分根因 | 改动位置 | 改动量 | 需重摄入/重跑 | 预期收益 | 依赖 |
|---|---|---|---|---|---|---|---|
| A1 | **渲染截断改 newest-first 或双端保留** | b 类截断：巨型维度 oldest-first 前 8 裁掉最新值（a96c20ee Harvard 条目、userPlan 10/46、userHabit 15/38、charityEventParticipation 10/12）；45 个维度受益 | `src/agent/runtime.ts:326-328`（升序 sort）+ `:347`（`members.slice(0, maxEntries)`→`slice(-maxEntries)` 或 4 旧+4 新双端） | 行级 | 重跑 answer+judge（~200 调用） | +2~4 题（多会话 a96c20ee 确定抢回；时间推理 2-3 题条件性抢回）；双端保留防“最早的X”类倒退 | 无；建议与 A2/A3/A4 攒一批同跑 |
| A2 | **ask rule 3 修正：新 tentative 可推翻旧 accepted** | 状态-日期倒挂：抽取给新值标 tentative、旧值标 accepted，rule 3 强制信 accepted（945e3d21 实锤按设计答错）；知识更新能力 -14.3pp 的成分之一 | `src/agent/ask.ts:43-45`（rule 3 措辞加“日期更新的 tentative 推翻较旧 accepted”）；可选配套：抽取时状态对齐时间序（属 D 层） | 行级 | 重跑 answer+judge | +1 题确定（945e3d21）；知识更新能力整体止血 | 无；注意与 A1 同屏渲染顺序配合（截断后 tentative 新值可见才有意义） |
| A3 | **created_at 格式归一（slash→ISO）** | 新发现：dateFrom/dateTo 过滤对同年斜杠日期静默失效；污染过滤（A5）和 W6a 的前置；渲染 [@2023/04/10] 与 Today 行格式不一致 | 两处：`src/agent/retrieval.ts:139` 一行兼容（`day = s.created_at.slice(0,10).replace(/\//g,'-')`，存量库立即生效）+ `benchmark/longmemeval/ingest.mjs:55` 改用 ISO（新增会话生效，全清需重摄入） | 行级 | 兼容行不需重摄入；ingest 修正随下次重摄入生效 | 本身不直接得分，解除 A5/W6a 的封锁；消除判分日期比较的隐患 | A5 依赖其前半 |
| A4 | **ask 时按题日过滤未来语句（dateTo=question_date）** | 污染放大器：模型明引 "latest accepted @2023-10-09" 等未来语句（6d550036、a4996e51、2b8f3739 等 ≥3 题供错数）；dateTo 过滤器已存在但没人传 | `benchmark/longmemeval/answer.mjs:206-210` 传 `dateTo: isoDay(q.question_date)`；产品侧对应 answerQuestion 调用方 | 行级 | 重跑 answer+judge | +1~3 题（污染实锤题中“未来语句是唯一错源”的子集）；与 A3 前半（比较归一）绑定否则失效 | **依赖 A3 前半** |
| A5 | **scope 隔离——基准方案（source_refs 过滤）** | 全局 key 池化：938 会话单库，跨题污染实锤 7-8 题（d 类 3 + 时间推理 4）；131 个跨用户假冲突的根源 | `src/agent/retrieval.ts:137-143`（候选预过滤加一条 `source_refs ∩ 允许集`）+ `answer.mjs` 传 `q.haystack_session_ids`（RetrievalConfig 加可选字段，产品路径不传=行为不变） | 行级（~20 行） | 重跑 answer+judge | +3~6 题（d 类污染题的主要修复；比 A4 更根治——A4 只挡未来，本项挡全部他题会话）；131 假冲突在评测口径下消失 | 与 A3 无关（纯 source_refs，不碰日期）；与方案 B 二选一或并行 |
| A5' | scope 隔离——产品方案（project_id/scope 字段）对比 | 同上 + 产品多用户语义 | `src/model/types.ts:41-44,139-140`（字段已预留，零迁移）；需改 `capture.ts:92-97`（按 key 查找改为按 key+project_id）、retrieval/contextMemoriesOf/relevantDimensionsOf/conflicts 全部查询路径加过滤、ingest 按题注入 | 文件级（跨 5+ 文件） | 重摄入+重跑 | 同 A5（benchmark 口径）；收益在产品侧（多租户） | 比 A5 贵一个量级；建议 A5 先拿分，A5' 作为产品工作流单独排期 |
| A6 | **statementText 纳入维度 description** | f 类数值不可达（4 题：4adc0475/d6062bb9/55241a1f/0977f2af）+ b 类稀释：'key: 纯数字’与问题 bigram 零重叠，description 的自然语言词可桥接 | `src/agent/retrieval.ts:240-244`（statementText 拼 `dim?.attributes?.description`）；同步点：runtime.ts:146、ingest.mjs:116-117、reindex.mjs:29-31 三处内联拼接需统一调用 statementText | 行级 | 词面路立即可用（重跑 answer+judge）；**向量路需重嵌入**：`node benchmark/longmemeval/reindex.mjs`（存量 8.4k 条，一次全量回填） | f 类 +1~2 题、稀释题若干 +0.5~1；副产品：消灭三处内联拼接的分叉 | 向量路收益依赖 reindex；否则向量分数与词面文本不一致（RRF 两路失配） |
| A7 | **merge 去重（跨分片语句 dedup）** | 孪生会话双份入库：64 组重复（实测全部 sess=2），虚增头部计数、浪费 48 行预算 | `benchmark/longmemeval/merge.mjs:98-108` 统一维度后加一步：按 (dimension_id, value) 去重（保留最早，删重+删其向量） | 行级（~15 行） | 零评测调用——只改 merge，下次合并自动生效；对已合并库可写一次性清理脚本 | 小：计数更准、预算省 ~1-2%；语义上是正确性修复 | 无；与 A8（M5 合并）同为库后处理，可同脚本 |
| A8 | **检索 k 提升实验（k=30）** | 时间推理 b 类“差几位进屏”（76048e76 #18、9a159967 #27）；autopsy 测算 k=30 下 +1 题 | 零代码：answer.mjs `--k 30`（A9 接线后可走 env） | 行级（0 行代码） | 重跑 answer+judge | 期望 +1 题，方差大；注意 k=30 会更频繁触发 48 行 omitted 降级（runtime.ts:340-344），与 A1 的双端保留互补 | 建议仅在攒批重跑时顺带跑一档对照，不做单独一轮 |
| A9 | **EDGELORE_RETRIEVAL_* 旋钮接线到 benchmark 答题路径** | 新发现：五个 env 旋钮 config.ts:128-134 解析后被 answer.mjs:163-165 丢弃 | `benchmark/longmemeval/answer.mjs:163-165` 传 `...cfg.retrieval`（k 仍由 --k 覆盖） | 行级（1 行） | 不需（接线本身不改行为，默认值相同） | 使 A8 及后续调参免改代码 | 无 |

## B 层：文件级改动（新模块或跨文件；M5 评测口径可零重摄入，其余需重摄入批）

| # | 名称 | 对应失分根因 | 改动位置 | 改动量 | 需重摄入/重跑 | 预期收益 | 依赖 |
|---|---|---|---|---|---|---|---|
| B1 | **M5 维度别名合并**（64% 回归的第一根因；P0） | 散账：漂移指数 0.79 对/key、最大相似连通分量 1070 key（19%）；知识更新“最新 accepted”跨 key 失效（3 例全中）；跨 key 冲突盲区（gymSchedule/gymDays 免检） | 设计已冻结：docs/notes/lifecycle-design-draft.md。两落点：① benchmark 口径——独立离线脚本对 memory.db 后处理（相似 key 聚类→统一 canonical→语句重挂+合并描述），类似 merge.mjs:64-110 的全库版；② 产品侧——runtime 后台 hook（"Dream"）+ CLI 命令 | 文件级（新模块 ~200-400 行 + 挂点） | ① **零重摄入**（对现库后处理→重跑 answer+judge）；② 产品侧无评测成本 | +4~8 题（b 类 16 题的散账子集 + 回归 7 个散账案例即现成验收用例）；知识更新能力修复的主杠杆 | 与 A7 同为库后处理可合并实施；抽取消除漂移的收益（prompt 侧）则随 D1 批生效 |
| B2 | **W6a event_time 字段 + 入库解析**（episodic 行为结构；唯一有外部硬证据的结构，taxonomy 结论“几乎必加”） | 抽取丢时间锚点 5/13（相对状语“about two weeks ago”被丢/未转绝对）；episodic 按时间查的正确性（created_at 是说话时间，event_time 是事件时间） | `src/model/types.ts:145-155`（StatementNode 可选 event_time，照抄 saidBy 模式，schema m0.1 不 bump）+ schema.json 用例 + `prompt.ts:217-261`（抽取解析相对时间，锚定会话日期）+ `retrieval.ts:137-143`（过滤/排序优先 event_time 回退 created_at——**前置 A3**） | 文件级 | **需全量重摄入**（prompt 变了）；契约/单测同步 | 时间推理能力 +2~4 题（中期）；与 A3/A4 组成完整时间线语义 | A3 必须先行；随 D1 重摄入批搭车（勿单独付全价） |
| B3 | **W6b constraint 生产线**（procedural 行为结构） | gate 白名单认出 constraint/lesson 但被降级存 statement（taxonomy“脑裂”）；benchmark 不直接考，产品价值核心 | `src/agent/extract.ts`/`capture.ts`（CaptureContent 增可选 rule 载荷）+ 新建 Constraint 走 Q01 proposed→人审激活；ask 注入端已就绪（runtime.ts:353-357 已注入 active 裁决行） | 文件级~工作流级 | 需重摄入（若要存量规则转正）；benchmark 无感 | benchmark 0 分；产品价值（规则被遵守）+ 裁决台 autoresolve 的裁判供给（conflicts.ts:294-303 需要active单维约束才有裁判） | 与 D1 同批可选搭车；难度在 NL→表达式，flash 不可靠，初版建议“识别→proposed+人审补表达式” |
| B4 | **memoryType 标签** | ——（taxonomy 结论：结构补齐后可推导，暂不加） | 无 | 无 | 无 | 0（维持冻结决策，重估窗口在 B2/B3 落地后） | 挂起；触发信号见 taxonomy 第五节 |
| B5 | **abstain 契约校准** | 拒答标记失灵：严格“不知道”0/21，软拒答 12/21——abstain 计数失真 + judge 对解释性拒答的宽容度构成 ±1-2 题判分波动面 | `src/agent/ask.ts:51-52`（rule 6 措辞：部分相关才作答，否则精确输出“不知道”）+ `ask.ts:102`（abstained 判定可加归一化） | 文件级（prompt 措辞为主） | 重跑 answer+judge | 直接分 ±0~2 题，主要是**压判分方差**（e 类噪声 2%→~0） | 无；注意别把 b/c 类“应作答”题推向拒答（autopsy 显示 strict refusal 已是 0，风险低） |
| B6 | **元偏好句式抽取** | SP 2 题金标是“user would prefer…”元偏好，抽取只存成分不存偏好本身（contentRate 20%/29%）；偏好能力 50% 持平的成分 | `prompt.ts:217-261`（批量 prompt 加“显式抽取偏好陈述本身，成分随附”）+ normalizeBatchContents 无需改 | 文件级（prompt 措辞） | 需重摄入 | 偏好 +1~2 题 | **必须随 D1 批**（单独重摄入不值全价） |

## C 层：检索 O(N) 规模墙——量级判断（非当前行动项）

现状实测：8,402 语句 / 5,657 维度。每查询成本 = 全表 `queryNodes`（retrieval.ts:134 + runtime.ts:321 两次全扫）+ 8.4k 次 bigram F1 + 暴力余弦 8.4k×1024 ≈ 8.6M FLOP + **`vectors.all()`（retrieval.ts:170）每查询从 SQLite 物化全部向量（现 ~34MB）**。单题延迟亚秒级；500 题全量也无感。

| 量级 | 判断 |
|---|---|
| ≤5 万语句（≈当前 6 倍，覆盖 500 题全量绰绰有余） | 暴力扫描完全够。唯一值得先做的是把 `vectors.all()` 的结果按 db 版本缓存在进程内存（第一瓶颈是 IO 物化，不是算力），行级改动 |
| 10^5 ~ 10^6 语句（产品多用户/长期累积） | 先上词面倒排索引（bigram→stmt id）+ 向量内存缓存；**ANN（sqlite-vec/HNSW）在 ≥10^5 语句或 p95 <100ms 的在线延迟预算出现时才引入** |
| 决策规则 | benchmark 永远到不了墙（940 会话→8-9k 语句）；产品侧以“语句数 ≥10 万”或“查询 p95 超 100ms”为 ANN 触发线，此前一切索引工作都是过早优化 |

## D 层：工作流级（重摄入批次 / 时机 / 治理 / 文档债）

| # | 名称 | 对应失分根因 | 改动位置 | 改动量 | 需重摄入/重跑 | 预期收益 | 依赖 |
|---|---|---|---|---|---|---|---|
| D1 | **抽取保全措辞批**（量词/时间/关联词不剥离 + 相对时间转绝对 + saidBy 误标抑制） | a 类 18 题（38%，最大单项杠杆）+ 回归 b 类 27%（$50 罚单/three meals/6:00pm 新抽取净丢）+ B2/B6 搭车 | `src/agent/prompt.ts:217-261`（批量 prompt：加“value 必须保留量词/时间状语/并列项（'or Lager’）；相对时间转绝对日期”）；`prompt.ts:112-121`（逐 turn 规则同步）；配合 B2/B6 | 措辞级，但**生效靠全价重摄入** | 流程：smoke-reingest（~20 调用）→ run-all（~2000 调用，删 checkpoint 全价）→ merge → 100 题验证（~200） | a 类 18 题按修复率 +5~10 题；是 53%→60%+ 的最大依赖项 | 与 B2/B6 同批一次付全价；改抽取层前必跑 smoke 门 |
| D2 | **stage2b 验证与全量 500 题的时机** | 量化 F1（已提交 1b5151b）+ A 层修复的合成收益 | 无新代码——流程编排 | 工作流 | 见下 | 见下 | 见下 |
| D3 | **裁决台消化（576 conflict，其中跨分片假冲突 131）** | 产品治理材料，非 benchmark 阻塞（ask 层 rule 3/4 无视 conflict 照常工作）；benchmark 口径下 131 个假冲突由 A5 直接消灭 | CLI 已齐（conflicts/resolve/autoresolve/confirm）；剩余工作：给 autoresolve 供裁判（=B3）、人审工单导出 | 工作流 | 不需 | benchmark 0；产品信任螺旋必需 | benchmark 侧无依赖；产品侧依赖 B3/A5' |
| D4 | **文档债** | —— | README.md:27-38 还停在"M0 done / Up next M1"（实际 M0-M4+Agent 层+评测全完成）；README_CN.md“46 个用例”（实际 171）；docs/HANDOFF.md 是 v1；**HANDOFF-v2.md 尚未 git add（untracked）**；建议移入 docs/ 并提交 | 文档级 | 不需 | 接手成本归零 | 无；顺手项 |

---

## D2 展开 stage2b / 500 题时机建议（攒批纪律：HANDOFF-v2 成本纪律）

```
第 1 轮（现在，~200 调用，零重摄入）"stage2b+"
  攒批：A1 渲染截断 + A2 rule 3 + A3 兼容行 + A4 dateTo + A5 source_refs 过滤
        + A6 statementText(+reindex) + A7 merge 去重 + A9 接线
  跑：merge → reindex → answer --ids stage1-ids → judge
  预期：53% → 58-62%（F1 合成 +3~4、渲染 +2~4、rule3 +1、污染 +3~6，重叠扣减）
  同时用 --k 30 跑一档对照（A8），验证时间推理 b 类的 k 敏感性。

第 2 轮（抽取批，全价一次）"reingest-v3"
  攒批：D1 措辞 + B2 event_time + B6 元偏好 + ingest.mjs:55 ISO 日期（A3 后半）
  流程：smoke（20 调用）→ run-all（~2000）→ merge → B1 别名合并（离线后处理，零摄入成本）→ 100 题验证（~200）
  预期：a 类 +5~10、散账 +4~8（与 A 层部分重叠）、时间锚点 +2~4 → 65-72% 区间

第 3 轮（仅当第 2 轮 100 题验证达标）
  全量 500 题正式跑分（~1100 调用），一次付清。
  原则：500 题是"成绩单"不是"实验台"——任何还在攒的修复先落进第 1/2 轮。
```

## 依赖关系总图（文字版）

- A4 ← A3（前半）；A6 向量路 ← reindex；A8 ← A9（若想走 env）
- B1 与 A7 同为库后处理，可合一脚本；B1 评测收益在现库即可兑现（零重摄入）
- B2 ← A3（日期比较语义）；B2/B6/D1 同批重摄入；B3 与 B2 独立
- D3 ← A5（假冲突预防性消失）+ B3（autoresolve 裁判供给）
- C 层无当前依赖；触发线见上表
- A5（source_refs 过滤，行级）与 A5'（project_id 产品化，文件级）是同一根因的两个价位：先 A5 拿分，A5' 排产品工作流——不建议直接做 A5' 来抢 benchmark 分

## 关键文件索引（改动落点速查）

- 渲染：`c:\Users\SZU1\Desktop\edgelore\src\agent\runtime.ts`（326-328, 340-357, 347）
- rule 3 / abstain：`c:\Users\SZU1\Desktop\edgelore\src\agent\ask.ts`（43-45, 51-52, 102）
- 检索/打分/statementText/日期过滤：`c:\Users\SZU1\Desktop\edgelore\src\agent\retrieval.ts`（134, 137-143, 170, 240-244, 270-281）
- scope 字段（已预留）：`c:\Users\SZU1\Desktop\edgelore\src\model\types.ts`（41-44, 139-142, 145-155 无 event_time）
- capture 全局 scope 注释：`c:\Users\SZU1\Desktop\edgelore\src\agent\capture.ts`（92-97）
- 抽取 prompt（批量/逐 turn）：`c:\Users\SZU1\Desktop\edgelore\src\agent\prompt.ts`（112-121, 217-261）
- 旋钮（未被 benchmark 消费）：`c:\Users\SZU1\Desktop\edgelore\src\config.ts`（128-134）
- 答题入口（k=10、now、未接 cfg.retrieval）：`c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\answer.mjs`（48, 163-165, 206-210）
- 斜杠日期源头：`c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\ingest.mjs`（55, 96-107, 116-117, 172）
- 合并/冲突标记/去重缺口：`c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\merge.mjs`（64-110, 120-138）
- 重嵌入工具：`c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\reindex.mjs`
- M5 冻结设计：`c:\Users\SZU1\Desktop\edgelore\docs\notes\lifecycle-design-draft.md`