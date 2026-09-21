# 聚合类问题的检索架构调研（三路：外部 SOTA + IR 理论 + 本地数据反推）

> 2026-09-20 · 回答核心问题：相似度检索答不了"全集"类问题，数据越大越糟——结构上怎么解？

---

# 第一部分：外部 SOTA 方案（GraphRAG/Chronos/Zep/Mem0/Hindsight）

# 聚合类/全局类问题的记忆系统方案调研

## 0. 问题定义(共识)

向量相似度检索答不了两类问题：
- **聚合/set 类**：“我今年坐过哪些航班” —— 答案是一个**全集**，散布在几十个 turn 里，每个 turn 单独看都与问题“低相似度”(问题文本里甚至没有航班号)，top-k 检索必然漏。GraphRAG 论文原话：RAG "fails on global questions directed at an entire text corpus... inherently a query-focused summarization (QFS) task, rather than an explicit retrieval task"。Barnett et al. 把它归为 RAG 七大失败点的 FP7 "Incomplete"(拿到部分列表就停止聚合)。https://arxiv.org/abs/2404.16130 , https://arxiv.org/abs/2401.05856
- **时间过滤类**：“上个月我做了什么” —— 需要把“上个月”翻译成日期区间再过滤，embedding 空间里“上个月”和具体事件毫无相似度信号。

现有系统的解法收敛为一个共识：**为这类问题建一个绕过向量检索的“结构化通道”(时间区间/实体/预计算摘要)，加一个前置的意图判断来路由**。区别只在结构化通道建多细、意图判断用什么实现。

---

## 1. Microsoft GraphRAG —— 社区摘要分层 + Map-Reduce 全局问答

来源：https://arxiv.org/abs/2404.16130 , https://microsoft.github.io/graphrag/ , https://graphrag.com

**为什么向量 RAG 答不了**：global question 的答案必须“覆盖全语料”(如“数据集里有哪些主题”)，而向量检索只取 top-k 个 chunk,天然只覆盖语料局部。问题本质是 QFS(查询聚焦摘要)而非检索。

**建图机制(索引期)**：
1. 文档 → 600-token chunk(小 chunk 抽取召回高一倍，600 vs 2400 token 差近 2 倍实体数)
2. 每 chunk 用 LLM 抽 (entity, type, description) + (source, target, relationship description) 元组，支持多轮 "gleanings"(用 logit-bias 强制 LLM 答“还有没有漏的实体”，补漏)
3. 实例级描述 → 按实体聚合成单一元素摘要(再一次 LLM 摘要)
4. 实体图上跑 **Leiden 层级社区发现**，每层都互斥完备覆盖全图
5. 自底向上生成**社区报告**：叶子层按边权重(源/目标节点度数)优先级塞满 context 窗口做摘要；高层直接汇总子社区报告

**查询机制(Global Search)**:
1. 选一个社区层级，所有社区报告洗牌后切 chunk
2. **Map**:每 chunk 并行生成部分答案 + 0-100 有用性评分，0 分丢弃
3. **Reduce**:按分数降序装进 context,生成最终全局答案

**成本(关键数字)**：
- 索引：第三方实测 **$15–120 / 百万源 token**(取决于抽取模型)，同语料 vector RAG 只要 ~$0.13/M;1M-token 语料整体对比：vector RAG <$5 vs GraphRAG **$50–200(10-40 倍)**。https://www.nextgencodingcompany.com , https://ai.plainenglish.io
- 论文实测图规模:1M token 播客 → 8564 节点/20691 边；1.7M token 新闻 → 15754 节点
- 查询期：C3(低层社区)比直接 map-reduce 原文省 26-33% token;C0(根层)省 **97%+**(9x-43x 少 token),但质量略降
- 论文自己承认：**要不要建图取决于预算和每语料生命周期查询数**，很多场景“无图全局摘要”性价比更高

**对个人记忆的适配度**：低。它是为静态百万 token 语料的“主题感知”设计的；个人记忆是持续增量的，全量重跑 Leiden + 全社区摘要不现实(Zep 为此改用可增量更新的 label propagation,见下)。

---

## 2. Chronos —— 事件日历 + 动态检索指引(个人记忆场景最直接的答案)

来源：https://arxiv.org/abs/2603.16862 (PwC, 2026-03),LongMemEval-S SOTA:92.60% (GPT-4o) / 95.60% (Opus 4.6)

**核心立场**：不做全量知识图谱，“查询条件化的选择性抽取” —— 只结构化**时间锚定的事件**，其余保留原始 turn。

**结构化日历怎么建(索引期)**：
1. 会话 turn 按 25-turn 批次(5-turn 重叠)送 LLM 抽取
2. 抽取条件：必须有完整 ⟨subject, verb, object⟩ 的**时间锚定事件**
3. **多分辨率时间归一化**：相对表达("recently", "last month")以会话时间戳 t_conv 为基准，展开成 **ISO 8601 的 [start_datetime, end_datetime] 区间**(而不是单点估计，编码事件可能发生的所有时间)
4. 每个事件生成 **2-4 个“完全不同词汇”的别名**("bought Fitbit" → "picked up a fitness tracker" / "got a step counter" / "purchased a wearable"),供 BM25/grep 召回
5. 事件和原始 turn 各自 embedding(text-embedding-3-large),形成**双日历索引**(event calendar + turn calendar)

**怎么答“列出去年所有航班”(查询期)**：
1. **动态检索指引(dynamic prompting)**:一个 LLM meta-prompt(Gemini 3 Flash,每题 1 次调用)分析问题，输出 1-5 条“该检索什么、怎么过滤时间、怎么做多跳”的指引 bullet,注入 agent 系统提示。例：“注意相机镜头购买细节，特别是最近一次的型号”
2. 预检索：turn 日历向量召回 top-100 → Cohere Rerank → top-15 → 前后各扩 1 turn 上下文
3. **ReAct agent 循环**：带 4 个工具 —— `search_turns` / `search_events`(向量)+ `grep_turns` / `grep_events`(精确匹配)。agent 可以**迭代地按 datetime 区间约束检索**，事件和源对话交叉验证
4. 聚合题机制：“How many times did I exercise in May?” → 事件日历的 datetime 区间**过滤掉 5 月以外的一切**，只对 5 月事件做枚举计数，而不是靠语义相似度排序

**效果**：multi-session aggregation 类 **91.73%**(比 EmergenceMem 相对提升 12.97%),temporal reasoning 90.23%。消融：去掉事件索引，精度**近乎减半**(GPT-4o 配置掉 34.5 点)—— 事件通道是最大贡献项(58.9% 增益来源)。

**成本**：索引期每会话 1-2 次小模型抽取调用(稀疏抽取，只抽时间事件，事件索引保持紧凑)；查询期 = 1 次指引生成 + 1 次重排 + agent 若干工具调用。论文明说：双索引存储翻倍、抽取有离线 LLM 成本，是已知 tradeoff。

---

## 3. Zep / Graphiti —— 双时态图 + 混合检索(BFS 是扩展手段，不是聚合手段)

来源：https://arxiv.org/abs/2501.13956 , https://github.com/getzep/graphiti , https://help.getzep.com , https://blog.getzep.com/how-do-you-search-a-knowledge-graph/

**结构**：三层子图 —— episode(原始消息，无损)/ semantic entity+fact(实体节点 + 带四时间戳的事实边：t_valid/t_invalid 事实有效期 + t'_created/t'_expired 系统期)/ community。**双时态模型**是特色：相对时间("two weeks ago")基于消息参考时间戳解析为 ISO 8601 有效期，新边可把矛盾旧边的 t_invalid 置为失效(LLM 对比判断矛盾)。

**社区层(它对全局问题的让步)**：借用 GraphRAG 思想但用 **label propagation 替代 Leiden** —— 理由是**可增量更新**：新实体加入时看邻居社区投票归属，只更新受影响社区摘要，避免全量重算；代价是周期性仍需全量 refresh。社区摘要用 map-reduce 生成，但检索方式不同于 GraphRAG:**社区名字含关键词，embedding 后参与 cosine 搜索**(平行于 LightRAG 的高层关键词检索)。

**查询路由到图查询的机制**：
1. 问题文本 → 三路并行搜索：**cosine 语义**(搜 fact/entity name/community name)+ **BM25 全文** + **BFS**(从命中节点/最近 episode 做 n-hop 扩展，把“图上近 = 上下文近”的节点拉进候选)
2. Rerank:RRF / MMR / **episode-mentions**(会话内提及频率)/ node distance(距锚点图距离)/ cross-encoder(最贵)

**能答聚合题吗**：部分。时间区间过滤(t_valid/t_invalid)+ BFS 实体锚点扩展解决“这个实体相关的一切”；社区摘要给“全局主题”。但**没有显式的聚合问句路由和全集枚举通道** —— LongMemEval 上 multi-session 类从 full-context 44.3% 提到 57.9%(gpt-4o),temporal 45.1%→62.4%,仍远低于 Chronos 的 91.7%,差距正是缺全集枚举。

**成本**：每消息多次 LLM 调用(实体抽取→消解→事实抽取→消解→时间抽取)，gpt-4o-mini;Mem0 论文实测 Zep 记忆图 **>600k token/对话**(26k 原文的 20 倍，因每节点缓存摘要+边上存事实)，且**图构建异步、延迟数小时才可查**。https://arxiv.org/abs/2504.19413

---

## 4. Mem0 / Hindsight —— 有没有专门的 structured channel?

### Mem0(https://arxiv.org/abs/2504.19413 , https://github.com/mem0ai/mem0)
**没有专门的聚合通道**。管线：
1. 写入：消息对 + 异步滚动摘要 + 最近 m=10 条 → LLM 抽候选事实 → 与 top-s=10 相似旧记忆一起送 LLM tool-call 判 ADD/UPDATE/DELETE/NOOP
2. 查询：**纯向量 top-k**,无意图路由。Mem0ᵍ 变体加图：实体节点 + 关系三元组，检索是**实体锚点子图扩展**(query 抽实体 → 锚点 → 遍历入边出边)+ **语义三元组匹配**(整 query embedding 对所有三元组文本算相似度过阈值)两条路
3. 聚合题实际走的是“向量碰运气 + LLM 在 partial context 里数数”—— LoCoMo temporal 类 J=55.51(纯文本)/58.13(图)，multi-hop J=51.15,论文自己说图变体在多跳上**没有增益**(“potential inefficiencies or redundancies”)
- 成本优势真实：记忆 7k token/对话，检索 p50 0.148s,比 full-context p95 快 91%
- 注意：Mem0 的 LoCoMo SOTA 声明被 Zep 方公开质疑(基准方法学)：https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

### Hindsight(https://arxiv.org/abs/2512.12818 , https://github.com/vectorize.io/hindsight)—— **有，而且是本次调研中最完整的 structured channel 设计**
1. **四网络记忆**：world(客观事实)/ experience(主体经历)/ opinion(带置信度的主观信念)/ observation(每实体异步预计算的**偏好中性摘要**，事实变更时后台重算)
2. 语句模型：每条记忆 = (text, embedding, **τ_s, τ_e 发生区间**， τ_m 提及时间， 网络 type, 置信度)，LLM 叙事式抽取(每对话 2-5 条，保留跨 turn 上下文)
3. 图：四种边 —— entity(共现实体双向连)、temporal(时间近邻，权重 exp(-Δt/σ))、semantic(相似度阈值)、causal(LLM 抽取，遍历时加权)
4. **召回 = 四路并行**：语义(HNSW)+ BM25(GIN)+ spreading activation 图扩展(因果/实体边乘数 >1)+ **时间图检索**。关键在第四路：**规则解析器(两个开源日期库)先把“上周末/2024年6月”解析成区间，多数查询低延迟搞定；解析不了才 fallback 到 flan-t5-small**。然后 R_temp = {f: [τ_s,τ_e]f ∩ [τ_start,τ_end] ≠ ∅},**图遍历被限制在 R_temp 内**，按区间中点距离打分
5. RRF 融合 → ms-marco MiniLM 交叉编码器重排(把格式化时间文本也喂进重排器)→ token 预算贪心打包
6. 效果：LongMemEval multi-session 21.1%→**79.7%**(OSS-20B,同一模型 full-context 基线)、temporal 31.6%→79.7%;总 91.4%(Gemini-3 生成)。这证明**增益主要来自架构而非模型**
- **对聚合题的答案**：时间通道做 set retrieval(区间重叠 = 全集过滤)，observation 网络做实体级 roll-up(“总结 Alice”不用扫全量事实)。仍缺的是“逐条枚举后交给 LLM 计数”的显式 map-reduce,靠 token 预算内塞尽可能多的命中事实近似

---

## 5. 学术界：global questions / set retrieval / aggregate QA

| 工作 | 要点 | URL |
|---|---|---|
| GraphRAG (Edge et al. 2024) | 定义了问题：global Q = QFS 不是 retrieval;社区摘要分层 + map-reduce | https://arxiv.org/abs/2404.16130 |
| Seven Failure Points (Barnett et al. 2024) | FP7 "Incomplete":聚合/计数题 LLM 拿到部分集合就作答，是工程上最高频失败点之一 | https://arxiv.org/abs/2401.05856 , https://dl.acm.org/doi/10.1145/3624918 |
| LongMemEval (Wu et al. 2024/ICLR 2025) | 把 multi-session aggregation / temporal reasoning / knowledge-update / abstention 定为独立评测类；LLM 性能随时长骤降(115k token 上 full-context 只剩 ~60%) | https://arxiv.org/abs/2410.10813 |
| RAPTOR (Sarthi et al. 2024) | 非图替代方案：embedding 聚类递归摘要成树，query 可在任意层检索 —— 层级摘要路线的图无关版本 | https://arxiv.org/abs/2401.18059 |
| LightRAG (Guo et al. 2024) | **双级检索**：索引期给每个实体/关系打 low-level 和 high-level 关键词；查询期 LLM 抽两组关键词(low=具体实体，high=主题)，分别走精确匹配和主题匹配 —— 比 GraphRAG 便宜 ~90%,查询快 10 倍 | https://arxiv.org/abs/2410.05779 , https://github.com/HKUDS/LightRAG |
| RAG failure taxonomy (TrustNLP@ACL 2026) | 系统化 RAG 失败模式分类，单阶段指标测不出的失败(含聚合不完整) | https://aclanthology.org/2026.trustnlp-main.27 |
| RAG-Reasoning survey (EMNLP 2025 Findings) | 收录 AggR 等聚合式推理 RAG:检索证据集后显式聚合再生成 | https://arxiv.org/abs/2506.00054 |

共识：**没有一篇“set retrieval 专治聚合题”的独立方法论论文**；聚合能力被各系统作为子模块解决(时间区间过滤 + 全集枚举 + 分层摘要)，评测靠 LongMemEval 的 MS/TR 类。

---

## 6. 查询意图路由：先分类，再走不同通道

| 系统 | 路由实现 | 细节 |
|---|---|---|
| **Adaptive-RAG** (Jeong et al. 2024) | **T5-large 分类器**(0.77B),弱监督自动打标(按模型答题结果迭代生成复杂度标签)，三路：no-retrieval / single-hop / multi-hop | https://arxiv.org/abs/2403.14403 , https://github.com/starsuzi/Adaptive-RAG |
| **Chronos 动态指引** | **LLM meta-prompt**(便宜小模型，每题 1 次)：抽问题目标(实体/属性/时间约束/操作)→ 输出检索指引 bullet。**不是离散分类器**，是生成式路由；消融显示强模型下(Opus 4.6)该组件增益归零，弱模型下 +14~16 点 | https://arxiv.org/abs/2603.16862 |
| **Hindsight 时间通道** | **规则优先**：两个日期解析库正则/规则解析时间表达，多数查询零 LLM;失败才用 flan-t5-small(80M)兜底 —— 意图检测即“是否含时间约束” | https://arxiv.org/abs/2512.12818 |
| **LightRAG** | LLM 把 query 抽成 low-level / high-level 两组关键词，分别路由到实体匹配 vs 主题匹配 | https://arxiv.org/abs/2410.05779 |
| **Self-RAG / Self-Route** | Self-RAG 用反思 token 决定是否检索；Self-Route(Google)按模型自评可答性路由到 RAG vs 长上下文，省成本 | https://arxiv.org/abs/2310.11511 |
| 工程实践 | 轻量分类先于昂贵检索：pattern matching 起步 → 小分类器；不同问题类型(lookup/比较/时间)路由到 BM25/vector/SQL 不同通道 | https://promptql.io/beyond-basic-rag-improving-your-knowledge-agents , https://www.devtoa.com/... |

**分类器实现谱系**(按成本升序)：关键词/正则(时间表达、聚合词“哪些/多少/总共/all/列出”)→ 微型 seq2seq(flan-t5-small)→ 微调 T5-large(Adaptive-RAG,需要训练数据)→ LLM meta-prompt(Chronos,零训练但每题 +1 次调用)。**实践收敛点：规则打头 + 小模型兜底 + LLM 兜底**，没有主流系统用大模型做每题分类(除非顺带产出检索计划)。

---

## 7. 对本地 SQLite 图记忆系统(edgelore:维度/语句模型，已有 key 体系)的落地建议排序

前提：SQLite 本地、维度/语句模型、已有 key 体系、已有 hybrid RRF 检索 + turn-size guard + 冲突仲裁；LLM 走 dogrouter 中转(deepseek-v4-flash,便宜)，embedding qwen3.7-text-embedding 1024 维。按 **(对聚合题收益)/(实现+维护成本)** 排序：

**① 时间结构化通道 + 规则意图路由(Chronos/Hindsight 模式)—— 最高 ROI,先做这个**
- 写入侧：LLM 抽取事件时给语句补 `(t_start, t_end)` ISO 8601 区间列(flash 模型一次调用，顺手在现有抽取 prompt 里加字段)，相对时间以 turn 时间戳为基准展开成区间；未解析成功的留 NULL
- 查询侧：**正则/关键词路由器**(零成本):`哪些|多少|总共|几次|列出|所有|every|how many|total` + 日期表达(`今年|去年|上个月|最近N天|YYYY年`)→ 判定 aggregate/temporal
- 命中后**绕过向量检索**，直接 SQL:`SELECT * FROM statements WHERE t_start <= :end AND t_end >= :start AND <key 维度过滤>` —— SQLite 区间查询 + GROUP BY/COUNT 是它最擅长的；“我今年坐过哪些航班”变成一条 WHERE 子句 + 把全集(有 turn-size guard 兜底)喂给 LLM 枚举
- 这是 Chronos 消融里贡献 58.9% 增益、Hindsight 把 multi-session 从 21% 拉到 80% 的那个组件

**② 聚合题专用提示模板 + 全集注入(Chronos agent 循环的静态简化版)**
- aggregate 命中时：换用“枚举-计数-不编造”模板，明确要求列出全部命中语句再汇总；把 `t_start/t_end` 格式化成人类可读时间随语句一起注入(Chronos 把时间从字符串推理变成结构化过滤；Hindsight 证明把格式化时间喂给重排器/生成器都有增益)
- 成本 ≈ 0,只改 prompt 组装

**③ 维度级/实体级 observation roll-up(Hindsight observation 网络 / Zep 实体摘要)**
- “总结我所有旅行” 不该现场扫全量。按 维度(或 key 的实体)维护**预计算摘要**：新语句写入后 debounce 触发 flash 模型增量更新该维度的 roll-up(“旅行：2025 年 X 次，去过…,偏好…”);查询期 roll-up 直接作为 context 一等公民
- 成本：每维度每次更新 1 次 flash 调用；收益覆盖所有“总结类”问题；与已有 key 体系天然对齐(每 key 一份 roll-up 表)

**④ 时间桶分层摘要(GraphRAG/RAPTOR 思想的轻量版，不做图聚类)**
- 全局主题题(“我这一年的模式是什么”)用**月/年桶摘要**替代 Leiden 社区：每桶一份摘要，写入增量更新，查询时 map(各桶并行出部分答案)→ reduce。个人记忆规模(数千~数万语句)下，时间桶的“社区划分”效果 ≈ 语义聚类，但零图算法依赖、天然支持增量
- 只有当①-③都不够、且全局题成为高频需求时再上；不要引入 Leiden/Louvain —— Zep 用 label propagation 替代 Leiden 的理由(增量维护)对你同样成立，而 label propagation 在 SQLite 上也就是个邻居投票 UPDATE

**⑤ 已有 hybrid 检索加 BFS/实体锚点扩展(Zep/Graphiti 模式)**
- 从问题抽出的实体/key 锚点出发，沿已有图边扩展 n-hop,把“共现实体但语义不同”的语句拉进候选(补 RRF 的漏)。这是对**多跳**题的补强，对纯聚合题只是辅助

**⑥ 动态检索指引(Chronos dynamic prompting)—— 可选项**
- flash 模型每题生成 1-5 条检索指引 bullet 注入系统提示。便宜且对弱模型有效，但注意 Chronos 自己的消融：**强模型下该组件增益为零**。若你的答题模型已经不错，跳过；若用 flash 级模型答题，值得加

**不建议**：完整 Microsoft GraphRAG 管线(索引 $50-200/百万 token、静态语料假设、增量更新无解，与本地个人记忆场景全面错配)；Mem0 式“纯向量碰聚合题”(其自身数据显示 multi-hop/时间类是短板，LoCoMo temporal J 仅 ~58)。

**验证路径**：你当前分支 `benchmark/longmemeval` 正好能测 —— LongMemEval 的 multi-session aggregation 与 temporal-reasoning 两类就是①-③的直接靶标；先跑 baseline,逐项开①②③,看分类别增益(Chronos 消融方法论可直接抄：116 题分层抽样做组件消融)。

---

# 第二部分：IR 理论（全集检索/查询路由/置信度估计）

# 全集型检索（Set/Total Recall Retrieval）与查询路由（Query Routing）调研报告

## 0. 问题定义

相似度 top-k 检索输出的是一个**排名列表**，隐含假设是“少量高度相关的文档就够回答”。而“找出所有 X”类问题要求**完整集合**，评价指标从 precision@k / nDCG 变成 **recall / completeness / count accuracy**——这在结构上是另一种检索形态。学术界对这一区分有明确的 track 和 benchmark（TREC Total Recall Track 2015–2016；SIGIR 2026 的 Total Recall QA），核心结论是：**高召回系统靠“受控词表/约束+全量遍历+主动学习补漏”，而不是靠更聪明的排序器**。

---

## 1. 传统 IR 的 solution：布尔检索、分面检索、数据库类目索引

### 1.1 布尔检索（Boolean retrieval）——完备性“按构造成立”

**机制**：倒排索引里每个词一个 posting list（有序 doc-id 列表）。“所有包含 X 的文档”= 遍历 X 的 posting list，AND/OR/NOT 就是 list 的交/并/差。这是 IR 里唯一**天然保证完备性**的检索模型——它不是“找相似的”，而是“精确划分集合”。

**优劣**：完备性和可组合性极强（任意多条件 AND/OR），但零排名能力（无“更相关”概念）、对普通用户的查询表述能力要求高。这正是 vector search 要解决的问题，但反过来 vector search 丢掉了完备性。

- Tunkelang《Faceted Search》对布尔模型与分面的关系有系统论述：https://www.iro.umontreal.ca/~nie/IFT6255/Books/FacetedSearch.pdf
- ParadeDB 对 faceting 的实现解释（倒排索引上做 category 计数与过滤）：https://www.paradedb.com/learn/search-concepts/faceting

### 1.2 分面检索 / 类目浏览（Faceted search / category browsing）

**机制**：把文档空间按多个正交维度（facet：类目、价格、年份……）预划分。用户“浏览+过滤”而非“搜索”：AND 跨 facet、OR 同 facet 内。每个 facet 值有精确计数（结果集 cardinality 是**准确数字**，不是估计）。电商左栏“品牌： Apple (128) / Samsung (95)”就是这个模式——注意它永远显示真实总数，因为计数来自倒排/列存索引而非采样。

**优劣**：完备性由索引保证；但 facet 必须在**写入时**打好（受控词表），开放域文本自动 facet 化仍是难题（MDPI facet ranking survey：https://www.mdpi.com/2078-2489/14/7/387 ；JWE 综述：https://journals.riverpublishers.com/index.php/JWE/article/download/4177/2941/12245 ）。

### 1.3 数据库的类目索引设计模式：bitmap index

**机制**：低基数（low-cardinality）类别列（性别、状态、类目）每 个 distinct 值存一个 bit 向量，多条件查询 = 按位 AND/OR，代价与集合大小无关。这是 OLAP/数仓的标准答案；高基数场景用压缩位图（Roaring Bitmaps）扩展。

**关键启示**：**“完整性保证”的正确数据结构是 posting list / bitmap，不是向量**。类别过滤用 B-tree/bitmap 拿到精确 id 集，向量检索只在集合内做排序。

- StarRocks bitmap index 文档：https://docs.starrocks.io/docs/table_design/indexes/Bitmap_index
- Bitmap 索引原理与 AND/OR 组合查询：https://medium.com/@narengowda/bitmap-indexing-a-high-performance-approach-to-data-retrieval-49942198e7c9
- 注意 OLTP 高并发写下的锁问题：https://stackoverflow.com/questions/35557102/

---

## 2. Total recall / 完备性研究：“找齐了没有”怎么判断

### 2.1 TREC Total Recall Track（2015–2016）：高召回的官方赛道

目标就是“找到**几乎全部**相关文档，且人力代价可控”（eDiscovery、系统性综述场景）。框架是**主动学习仿真**：模型排序→人工审→反馈→重排，度量“达到 target recall（如 80%/95%）所需审阅量”。结论：active learning（如 Continuous Active Learning, CAL）能以合理代价逼近全部相关。

- Track 数据与目标（NIST）：https://trec.nist.gov/data/total-recall ；https://data.nist.gov/od/id/mds2-3126
- TREC 2016 Total Recall Overview（Grossman & Cormack）：https://grossman.uwaterloo.ca/grossman-publications/trec-total-recall-2016
- 句级 relevance feedback 高召回实验（IR Journal 2020）：https://link.springer.com/article/10.1007/s10791-019-09361-0

### 2.2 最前沿：Total Recall QA（SIGIR 2026）

把“必须取回**全部**相关文档才能答对”做成了可验证 QA benchmark（答案 = 结构化知识库上的精确计数/枚举，可机器判分）。这正是你说的“结构上不同”的最新版本：检索目标从“找到那几条”变为“枚举完备集合”，用知识库结构保证 ground truth。

- https://arxiv.org/abs/2603.18516 （TRQA：Wikidata-Wikipedia + 合成电商库）

### 2.3 置信度/覆盖率估计：判断“找齐了没有”的四类方法

1. **Capture-Mark-Recapture（CMR，双通道捕获-再捕获）**：两条独立检索通道各“捕获”一次，用重叠量估计总体总量 `N ≈ n1 × n2 / n1∩n2`。Kastner et al. 2009（J Clin Epidemiology）将其形式化为系统性综述的**停止规则**；2024 年后有工作用 Chao's estimator 改进。**这是不用 ground truth 就能估 recall 的核心统计工具**，且对“双通道混合检索”（vector + lexical）是天然适配的。
2. **Elusion / ei-Recall（eDiscovery 行业标准）**：对“丢弃堆”（被判不相关的部分）做**随机抽样**人工复核，估计其中残余相关率 → 反推 recall 置信区间。Duke Law TAR 指南要求预先声明 target recall 并给出“有 95% 把握实际 recall ≥ X”式陈述；Losey 的 ei-Recall 是金标准实现（https://zeroerrornumerics.com ）；Roitblat 2020（"Is there something I'm missing?"）论证 80% recall 在多数场景已合理。学术前沿是 Lewis 2023（SIGIR）的 **confidence sequences**：统计上保证达到 target recall 才停。
3. **Query Performance Prediction（QPP）**：无 relevance judgment 时预测单次检索质量。经典 post-retrieval 信号：**Clarity**（结果集语言模型 vs 全库语言模型的 KL 散度——结果集“聚焦”则质量高）、**WIG/NQC**（检索分数分布的均值/方差形态）。对“这次 top-k 覆盖了多大比例”给出低成本信号，但估的是 ranking quality 不是 set completeness。综述：https://github.com/chauff/QPP-Overview ；Meng et al. TOIS 2024（https://dl.acm.org ）；神经 IR 上的迁移性检验（Faggioli et al.）。
4. **Sufficient Context（Google, ICLR 2025 方向）**：训一个分类器判断“已取回的 context 是否**足以**回答该问题”，把 RAG 失败归因从“检索烂”细化到“context 不足”。对“找齐了没有”是**答案侧**的判据（与上面的检索侧判据互补）。https://arxiv.org/abs/2411.06037 ；Google Research 博客：https://research.google/blog/deeper-insights-into-retrieval-augmented-generation/ ；代码：https://github.com/google-deepmind/sufficient_context

配套的**自纠错**模式是 CRAG（Corrective RAG）：轻量 retrieval evaluator 给取回结果打 Correct/Incorrect/Ambiguous + 置信度，低置信触发补救动作（重查/换通道/扩召回）。https://arxiv.org/abs/2401.15884

---

## 3. 查询分类 → 路由：主流做法、误分类代价、兜底

### 3.1 四种实现（从快到慢）

| 做法 | 机制 | 代表 |
|---|---|---|
| 关键词/规则 | 正则触发词（“列出所有”“how many”）；零成本、可审计，但召回低 | 生产系统普遍的第一层 |
| NLI 零样本分类 | 把每个候选标签写成 hypothesis，文本做 premise，取蕴含概率最高的标签。无需训练数据，换标签集即换分类器 | Yin, Hay & Roth 2019：https://arxiv.org/abs/1909.00161 |
| 小分类器 | SetFit/FastFit 少样本微调，或 embedding + 线性头；延迟最低（~ms 级）、置信度可校准 | SetFit/FastFit 基准：https://pub.towardsai.net/few-shot-nlp-intent-classification-d29bf85548aa ；LatentGate（ACL 2026 Industry，指出 LLM 零样本 router 缺 in-domain 置信度）：https://aclanthology.org/2026.acl-industry.153.pdf |
| LLM prompt 分类 | 几个 few-shot 例子 + 枚举标签让 LLM 输出 JSON；最灵活但慢、校准差 | RAG 系统常用；系统性比较见 https://openreview.net/forum?id=UMuVvvIEvA |

**业界共识（多篇一致）**：纯零样本 LLM 路由**没有可校准的置信度分数**，无法可靠检测自己分错了（LatentGate 论文的动机）；**embedding 语义路由**（query 向量 vs 各 route 的示例 utterance 向量比相似度）在 OOD 查询上会静默误路由，必须加相似度阈值 + fallback route（https://gist.github.com/mkbctrl/a35764e99fe0c8e8c00b2358f55cd7fa ；Zep 实操：https://blog.getzep.com/building-an-intent-router-with-langchain-and-zep ）。NVIDIA 等生产蓝图用“小意图分类器（~1.7B）+ 置信度阈值”两段式：https://www.guild.ai/glossary/query-routing-ai

### 3.2 误分类的代价与兜底

- **代价不对称**：把 set 问题误路由到 top-k → 答案**错误但看起来流畅**（列举不全无任何信号），这是最贵的一类；把 lookup 误路由到 set 通道 → 只是浪费（全量拉取+多花 token），结果仍正确。**因此路由器应该 bias 向“贵但完备”的通道**（宁可误入 set/summary 通道，不可漏）。
- **兜底模式**：(a) 阈值 + fallback 默认通道；(b) **双通道并跑取并集**（低置信时），只在分发成本 << 重新提问成本时值得；(c) 路由决策随 prompt 上下文可被用户显式覆盖（“给我列全”直接强制 set 通道）；(d) 把路由日志化，用真实误路由样例反喂小分类器（零样本 LLM 路由“不随时间改进”的解法，见 https://tianpan.co/blog/2026/04/16/intent-classification-agent-routers ）。

---

## 4. 混合架构：结构化过滤 + 非结构化检索

### 4.1 三条成熟管线（LangChain/LlamaIndex 生态的标准分工）

1. **text-to-metadata-filter（self-query retriever）**：LLM 把自然语言查询拆成 `语义查询串 + 结构化过滤条件`（`category="movie" AND year>2020`），过滤条件下推到向量库。这是 RAG 里最轻量的结构化通道。https://www.langchain.com/blog/query-construction
2. **text2SQL**：分析聚合类问题（count/avg/group by）直接落到关系库；与语义检索组合（“结合 text2SQL 与语义检索”的经典 LlamaIndex 博客：https://www.llamaindex.ai/blog/combining-text-to-sql-with-semantic-search-for-retrieval-augmented-generation-c60af30ec3b ）。
3. **路由器**：按意图分发到 SQL / 图查询（Cypher）/ 元数据过滤 / 纯向量（"Deconstructing RAG"中的 logical routing + query construction：https://www.langchain.com/blog/deconstructing-rag ）。

### 4.2 Metadata filtering 的最佳实践（完备性视角的关键细节）

- **post-filter 是完备性杀手**：先向量搜 k 条再过滤，选择性强的过滤器会让结果 < k 甚至为 0——**你永远不知道被过滤掉的宇宙有多大**。Pinecone 的奠基文（"The Missing WHERE Clause in Vector Search"）：https://www.pinecone.io/learn/vector-db-filtering/
- **pre-filter 才保召回**，但选择性过强时 ANN 图导航会退化 → 各家解法：Qdrant **filterable HNSW**（在建图时给共享过滤值的点加专用边，保证过滤子图连通）+ 按 filter cardinality 自适应选择“精确扫描 / 过滤 HNSW”的 query planner。https://qdrant.tech/articles/vector-search-filtering ；https://qdrant.tech/documentation/manage-data/indexing
- **推论**：当过滤器是**低基数字段**（类目、维度 key）时，正确做法是**放弃 ANN，直接走倒排/bitmask 拿精确 id 集合**——向量只负责在集合内排序，或者集合小到根本不需要排序。

---

## 5. 分层摘要/索引：RAPTOR 与 GraphRAG——解决的是“汇总”，不是“全集”

### 5.1 RAPTOR（arXiv 2401.18059）机制

叶子 = 原文 chunk → embed → **GMM 软聚类（UMAP 降维，允许一个 chunk 属多簇）** → 每簇 LLM 摘要成父节点 → 递归到根。查询时**collapse the tree**：全树节点平铺在一个索引里做相似度检索，于是 query 既能命中细节层也能命中概要层。官方仓库：https://github.com/parthsarthi03/raptor

**有效性**：在需要跨文档、多步整合的任务上显著有效——QuALITY（长文档多选 QA）上配合 GPT-4 把当时最佳绝对准确率提升 20%；QASPER、NarrativeQA 同步提升。https://arxiv.org/abs/2401.18059

### 5.2 对“聚合问题”有效吗？——要区分两种聚合

- **汇总型聚合**（“这些文档的核心主题是什么？”“大家对接口的整体评价如何？”）：**有效**。这正是 RAPTOR/GraphRAG 的设计目标。Microsoft GraphRAG 更进一步：实体图 + Leiden 社区发现 + 分层社区摘要 + **map-reduce 全局归约**，专门回答“全库层面”的问题（comprehensiveness/diversity 显著超 baseline RAG）。https://arxiv.org/abs/2404.16130 ；https://graphrag.com
- **枚举型聚合**（“列出所有 X”“一共几条 Y？”）：**无效**。摘要树在层层压缩时**主动丢弃实例细节**，树越往上越不可数；而且相似度检索永远不会“全量遍历”。枚举型必须走第 1/4 节的结构化通道（受控词表 + 精确集合运算），摘要层只适合做答案的“导语/总结”部分。

**结论：分层摘要树和类目索引是互补的两层——摘要层答“意味着什么”，索引层答“有哪些/有几个”。**

---

## 6. 对 edgelore 的建议

（代码依据：`c:\Users\SZU1\Desktop\edgelore\src\model\types.ts`、`c:\Users\SZU1\Desktop\edgelore\src\agent\retrieval.ts`——当前 `retrieveRelevant` 对全部 statement 做 vector+lexical+RRF top-k，`k` 默认 8；`statementText` 已把 `dimension.key + description` 拼进索引文本。）

### 6.1 类别/主题索引：不要加新字段，dimension 本身就是类目

edgelore 的 `core:dimension`（`key` 稳定受控 + `attributes.description` 自然语言 + `cardinality`）**恰好就是一个已经在维护的受控词表**——这比任何自动聚类都强。建议：

1. **维度级倒排索引（posting list）**：新增一个 `dimension_index` 表：`term → dimensionIds`，term 来自三处——`dimension.key`（精确 token）、`description` 分词（复用 `bigrams()`，CJK 安全）、`dimension.tags`（受控标签）。SQLite 上这就是普通索引列 + join，等价于 bitmap index（维度数量级小，无需 Roaring）。查询“所有关于 X 的维度”= 倒排并集，**完备性按构造成立**。
2. **statement 侧补一个组合索引**：`statements(dimension_id, state)`。聚合通道就是 `SELECT ... WHERE dimension_id IN (...) AND state IN (...)`——一条 SQL 拿全集，不走任何相似度。当前 `retrieveRelevant` 的全量 scan（`retrieval.ts:149`）在 8.4k 条时靠内存 cache 扛着，走维度索引后聚合通道是 O(命中集)，与库大小解耦。
3. **主题归组（可选第二期）**：若“类别”横跨多个维度（如“所有成本类”= design_cost + build_cost + ...），用 `dimension.tags` 做一层受控主题词表（写入时由 extract 阶段打标，参照 knownDimensions 的“优先复用已有标签”策略），避免自由文本标签漂移——这与你们的维度 anti-drift 原则一致。
4. **cardinality 已含集合语义**：`cardinality: "single"` 的维度答“最新 accepted 值”；`"multi"` 的维度答全集。聚合通道可据此自动决定返回形态。

### 6.2 聚合问题路由：四路 router + 偏向完备通道

在 `ask.ts` 前加一层 router，输出四类意图：`lookup`（单点）/ `set`（枚举：列出/所有/哪些/几个/how many）/ `summary`（汇总：整体怎么样/主题是什么）/ `open`。实现按 3.1 的组合拳：

- **第一层规则**：中英触发词（“所有、列出、哪些、几个、一共、多少 / list all、every、how many、what are all”）→ 强制 `set`。零成本、可审计。
- **第二层小分类器或 NLI 零样本**（标签集就四个，SetFit 几十条例子就能训；或直接用 embedding 对四组示例 utterance 做语义路由），带相似度阈值。
- **兜底（关键）**：置信度不足时**双通道并跑**——top-k 检索 + 命中维度的全量拉取，结果取并集再让 answer 层判断。误入 set 通道只浪费 token，漏入才是正确性事故（见 3.2 的代价不对称）。
- `set` 通道返回时**必须带 count**（“共 N 条，来自 M 个维度”），`summary` 通道才走 RAPTOR/GraphRAG 式分层摘要（可用维度 description 作为最 cheap 的“单层摘要树”起步）。

### 6.3 置信度估计：三层，从“按构造”到“统计”

1. **结构完备性（免费且确定）**：凡是从维度倒排索引拉的全集，recall = 100%（完备性由索引构造保证）。此时报 confidence 高、且报的是**精确 count** 而非“相似度分数”。这是路由到结构化通道的最大红利——把“找齐了没有”从统计问题变成数据结构问题。
2. **路由置信度**：router 输出的分类分数（阈值 ~0.7，低于则双通道并跑）。规则层命中触发词时给满分。
3. **标签覆盖率 / 残余漏检估计（统计层，两条低成本技术）**：
   - **CMR 捕获-再捕获**：vector 通道和 lexical 通道各自独立命中一批维度，用两通道交集估总维度数 `N̂ ≈ n_vec × n_lex / n_∩`，`N̂` 与实际命中的差就是漏检期望；
   - **Elusion 抽样**：对**未被任何关键词/主题匹配的维度**，按 description embedding 与 query 的相似度排个序，抽最高分几个给 LLM 判“这个维度是否其实属于查询范围”——残余命中率高则降 confidence 并扩召回（CRAG 式自纠错：https://arxiv.org/abs/2401.15884 ）。停止条件借系统性综述的规则：当补充通道连续产生的新维度数低于阈值即停（Kastner CMR stop rule 思路）。
   - 答案侧再叠一个 **Sufficient Context** 式检查（“这些语句足以回答吗？”）作为最后闸门（https://arxiv.org/abs/2411.06037 ）。

### 6.4 落地顺序建议

1. `statements(dimension_id, state)` SQL 索引 + `queryStatementsByDimensions()`（半天）；
2. 触发词规则 router + `set` 通道 + count 字段（一天，立刻消灭 LongMemEval 类 benchmark 里“列出/计数”题的结构性失分）；
3. 维度倒排索引（key/description/tags）；
4. 小分类器替换规则层 + 阈值双通道兜底；
5. CMR/elusion 置信度上报（依赖双通道已存在，边际成本低）。

### 来源汇总

- Tunkelang, *Faceted Search*: https://www.iro.umontreal.ca/~nie/IFT6255/Books/FacetedSearch.pdf ；faceting 实现：https://www.paradedb.com/learn/search-concepts/faceting ；facet 综述：https://www.mdpi.com/2078-2489/14/7/387
- Bitmap index: https://docs.starrocks.io/docs/table_design/indexes/Bitmap_index ；https://medium.com/@narengowda/bitmap-indexing-a-high-performance-approach-to-data-retrieval-49942198e7c9
- TREC Total Recall Track: https://trec.nist.gov/data/total-recall ；https://grossman.uwaterloo.ca/grossman-publications/trec-total-recall-2016 ；高召回 relevance feedback：https://link.springer.com/article/10.1007/s10791-019-09361-0
- Total Recall QA（SIGIR 2026）: https://arxiv.org/abs/2603.18516
- CMR 停止规则： Kastner et al. 2009, *J Clinical Epidemiology* 62(2):149-157（"The capture-mark-recapture technique can be used as a stopping rule when searching in systematic reviews"）
- TAR/eDiscovery recall 估计： Duke Law TAR Guidelines（scholarship.law.duke.edu）；ei-Recall: https://zeroerrornumerics.com ；Roitblat, "Is there something I'm missing?"（arXiv 2020）
- QPP: https://github.com/chauff/QPP-Overview ；Meng et al. TOIS 2024（ACM DL）
- Sufficient Context: https://arxiv.org/abs/2411.06037 ；https://research.google/blog/deeper-insights-into-retrieval-augmented-generation/
- CRAG: https://arxiv.org/abs/2401.15884
- 零样本分类（NLI）: https://arxiv.org/abs/1909.00161
- 路由： https://aclanthology.org/2026.acl-industry.153.pdf （LatentGate）；https://openreview.net/forum?id=UMuVvvIEvA ；https://www.guild.ai/glossary/query-routing-ai ；https://blog.getzep.com/building-an-intent-router-with-langchain-and-zep ；https://tianpan.co/blog/2026/04/16/intent-classification-agent-routers ；误路由兜底： https://gist.github.com/mkbctrl/a35764e99fe0c8e8c00b2358f55cd7fa
- 混合架构： https://www.langchain.com/blog/query-construction ；https://www.langchain.com/blog/deconstructing-rag ；https://www.llamaindex.ai/blog/combining-text-to-sql-with-semantic-search-for-retrieval-augmented-generation-c60af30ec3b
- Metadata filtering: https://www.pinecone.io/learn/vector-db-filtering/ ；https://qdrant.tech/articles/vector-search-filtering ；https://qdrant.tech/documentation/manage-data/indexing
- RAPTOR: https://arxiv.org/abs/2401.18059 ；https://github.com/parthsarthi03/raptor ；GraphRAG: https://arxiv.org/abs/2404.16130 ；https://graphrag.com

---

# 第三部分：本地数据反推（41 道多会话错题验证类别路由设计）

# 类别路由层设计反推报告（基于 41 道多会话错题 × memory.db 全量数据）

数据基准：`judge-result-full500.json` 口径（multi-session n=121, correct=80 → **41 错**）。错题清单已逐题比对 oracle `answer_session_ids` 与 `memory.db`（6456 维度 / 7160 语句，语句平均 1.11 条/维度）。

---

## 1. 逐题分析（41 题）

**每题金标语句高度集中在一个语义簇**——问题问的类别词、金标 key 的共同词根、能否靠“类别→全量拉取”答对，逐题如下（key 为金标事实所在维度，全部人工核对到 value 级）：

| # | qid | 问题类别（人工判定） | 金标 key（共同词根） | 类别拉取可救？ |
|---|---|---|---|---|
| 1 | 09ba9854 | 旅行-交通 | friendClaimed**TrainFare** / taxi**Cost**Consideration（机场交通） | ✅ |
| 2 | 0a995998 | 购物-衣物 | **zaraBoot**Exchange / **zaraBoots**Exchange / dryCleaning**Pickup**（衣物待取/退） | ✅（含孪生 key，见 §2.3） |
| 3 | 21d02d0d | 运动-跑步 | weekly**5kFunRun**Attendance / missed**5KFunRun**（趣味跑） | ✅ |
| 4 | 2318644b | 旅行-住宿 | **mauiTrip**Planning / **tokyoHostel**Experience（住宿价格） | ✅ |
| 5 | 2ce6a0f2 | 艺术-观展 | art**Museum**Interest / streetArt**Lecture**Attendance / childrensMuseum**Volunteering** / localArtist**RachelLee**（艺术活动） | ✅（8 个金标 key 全 art 簇） |
| 6 | 36b9f61e | 购物-奢侈品 | **luxury**EveningGownPurchase / **italianLeather**BootsPurchase / **gucciHandbag**Purchase（奢侈品购买） | ✅ |
| 7 | 37f165cf | 阅读-书籍 | nightingale**Read** / book**Reading**Pace；**另 1 本 416 页小说从未入库** | ⚠️ 部分（抽取缺失） |
| 8 | 3a704032 | 园艺-植物 | **plant**Acquisition / snake**Plant**Repotting（购植物） | ✅ |
| 9 | 3c1045c8 | 职业-年龄 | skincareRoutineInterest(32岁)；**部门平均 29.5 岁从未入库**（DB 全文搜 29.5 = 0 命中） | ❌ 抽取缺失 |
| 10 | 3fdac837 | 旅行-行程天数 | **japan**PreviousVisit；**芝加哥 4 天未入库**（chicagoPreviousTrip 有事件无天数） | ⚠️ 部分 |
| 11 | 46a3abf7 | 爱好-水族 | **aquarium**Experience / **amazoniaTank**Setup / small**Tank**Setup / bettaFish**Finley**（鱼缸） | ✅ |
| 12 | 60159905 | 餐饮-赴宴 | bbqExperience**MikePlace** / lowKeyDinnerParty**AlexPlace**；**Sarah 家意式晚宴未入库** | ⚠️ 部分 |
| 13 | 61f8c8f8 | 运动-跑步 | running**5KTime**；**去年 45 分钟成绩未入库**（DB 搜 45 min 无关命中） | ❌ 抽取缺失 |
| 14 | 7024f17c | 健身 | **fitnessRoutine**Tracking（周六 30 分钟慢跑，中文语句） | ✅ |
| 15 | 80ec1f4f | 艺术-观展 | **artCube**GalleryVisit / naturalHistory**MuseumVisit**（2 月看展） | ✅ |
| 16 | 81507db6 | 社交-典礼 | **cousinEmmaPreschoolGraduation** / **rachelGraduation** / **colleagueAlexGraduation**（毕业典礼） | ✅ |
| 17 | 88432d0a | 烹饪-烘焙 | convectionOven**FirstUse**(饼干) / **sourdough**BreadIssue / **chocolateCake**Success / wholeWheat**Baguette**Baking（4 次烘焙） | ✅ |
| 18 | 9aaed6a3 | 购物-杂货/返现 | **groceryExpense**Tracking($75) / **saveMartMembership**(1% cashback) | ✅ |
| 19 | 9d25d4e0 | 购物-珠宝 | engagement**Ring**Resize / emerald**Earrings**Acquisition / silver**Necklace**Acquisition（珠宝购入） | ✅ |
| 20 | a11281a2 | 社媒 | **instagram**FollowerGrowth / **instagram**FollowerCount（粉丝数） | ✅ |
| 21 | aae3761f | 旅行-自驾 | **outerBanksTrip**Experience(4h) / drivingDistance**OuterBanksToTybee**(7-8h) / **topsailIsland**TravelDetails(2h/4-5h) | ✅ |
| 22 | bf659f65 | 音乐-专辑 | whiskeyWanderers**EP** / tameImpala**Vinyl**Signed；**Billie Eilish 专辑“已购买”语义丢失**（value 只剩“喜欢”） | ⚠️ 部分 |
| 23 | c4a1ceb8 | 餐饮-调酒 | homemade**Orange**Bitters(橙) / mixology**Class**Learning(青柠) / spanishDinnerParty**Planning**(柠檬)（3 种柑橘，分居 3 key） | ✅ |
| 24 | d23cf73b | 烹饪-菜系 | chicken**TikkaMasala**Skill(印) / fermentation**Workshop**Attendance(韩式发酵) / vegan**Lasagna**(意) / plantBased**Eating**(素食课) | ✅ |
| 25 | d851d5ba | 公益-筹款 | **charity**FundraisingAnimalShelter($2000) / **charity**EventParticipation($250) / **charity**BakeSaleFundraising($1000) / **charity**FitnessChallengeCompleted($500)——词根最工整的一题 | ✅ |
| 26 | dd2973ad | 健康-就医 | lateNight**Sleep**Struggle(2AM) / **doctorAppointment** | ✅ |
| 27 | e3038f8c | 收藏 | rare**Figurine**Collection(12) / rare**Record**Collection(57) / rare**Coins**Storage(25) / rare**Book**Collection(5)（99=12+57+25+5） | ✅ |
| 28 | e6041065 | 旅行-打包 | **packing**Habits(带 5 双鞋) / **packing**Light5DayTrip(只穿 2 双) | ✅ |
| 29 | e831120c | 影视 | **mcuMarathon**(2 周) / **starWarsMarathon**(1.5 周)（movieBingeMarvel 是同一事件的第三个孪生 key） | ✅（需去重） |
| 30 | edced276 | 旅行-天数 | **soloTripNYC**(5 天) / **familyHawaiiTrip**(10 天) | ✅ |
| 31 | ef66a6e5 | 运动-竞技史 | lap**Swimming**PoolSearch(大学竞技游泳) / competitive**Tennis**Background | ✅ |
| 32 | gpt4_15e38248 | 家具/居家 | **westElmCoffeeTable**Purchase / ikea**Bookshelf**Assembled / casper**Mattress**Order / kitchen**TableLeg**Fix（买/装/修各一） | ✅ |
| 33 | gpt4_194be4b3 | 音乐-乐器 | **guitar**Ownership / **acousticGuitar**Ownership / **drumSet**Selling / **korgB1**Ownership（4 件乐器 4 个 key） | ✅ |
| 34 | gpt4_2ba83207 | 购物-杂货 | **traderJoes**ShoppingTrip($80) / **thriveMarket**Order+$150 / **groceryShoppingWalmart**($120)（比大小） | ✅ |
| 35 | gpt4_2f8be40d | 社交-婚礼 | friend**JenWedding** / friend**EmilyWedding** / wedding**CousinInspiration**(表姐婚礼) | ✅ |
| 36 | gpt4_59c863d7 | 爱好-模型 | model**Building**Interest(F-15) / model**KitPainting**Advice(Spitfire) / model**KitAcquisitions**(B-29+Camaro)；**Tiger I 坦克未入库**（搜 Tiger=0） | ⚠️ 部分 |
| 37 | gpt4_731e37d7 | 教育-工作坊费 | **digitalMarketingWorkshop** / **writingWorkshop** / **entrepreneurshipWorkshop** / **mindfulnessWorkshop**Attendance（$300+$250+$150+$20=$720） | ✅ |
| 38 | gpt4_7fce9456 | 房产 | **housePurchaseBrookside**Townhouse / **cedarCreek**PropertyBudget / **rejectedCondo**Offer / kitchen**Renovation**Interest(Oakwood 看房)（看了 4 处） | ✅ |
| 39 | gpt4_ab202e7f | 厨房-换修 | **kitchenFaucet**Replacement / kitchen**Mat**Ikea / **toasterOven**Replacement(Upgrade) / espresso**Machine**Gift；**修厨房架子未入库** | ⚠️ 部分 |
| 40 | gpt4_d84a3211 | 骑行-开销 | **helmet**Purchase($120) / **bikeLights**Purchase($40) / **bikeTuneUp**April20($25) | ✅ |
| 41 | gpt4_f2262a51 | 健康-就医 | chronic**Sinusitis**Diagnosis(Patel/ENT) / **primaryCarePhysician**(Dr.Smith) / benign**MoleBiopsy**(Dr.Lee/皮肤科) | ✅ |

**结论 A（可救率上限）**：33/41（80%）的金标事实**完整在库**，失败纯在检索/聚合层——“类别→全量拉取”机制上可救；8 题（37f165cf、3c1045c8、3fdac837、60159905、61f8c8f8、bf659f65、gpt4_59c863d7、gpt4_ab202e7f）有金标事实**从未被抽取入库**（数字/时长/购买动作被丢，与 HANDOFF 记录的“新抽取丢数字 27%”同根），类别层救不了，需修写路径。
**结论 B（单簇性）**：41 题中 40 题的金标 key 全部落在**一个**语义簇内（唯一例外 3c1045c8 需跨“美容+职业”，且它本就是抽取缺失题）。
**结论 C（语言混杂）**：金标会话语句 63% 是中文（633/997；DB 全库同为此比例），30/41 题金标池中英混杂——而问题全是英文。12/41 题（29%）问题词与金标语句 value **零词面重叠**，这是当前检索饿死的直接原因之一，也是类别标签（语言无关）最大的价值点。

---

## 2. 类别粒度统计

**2.1 粗粒度（top taxonomy）**：41 题落在 **16 个类别**——travel 6、shopping 6、sports/fitness 5、food/cooking 4、hobby/collecting 3、art 2、music 2、health 2、social-events 2、career/edu 2、books/movies/plants/social-media/charity/real-estate 各 1。平均每类 2.6 题。**约 20 个类别即可全覆盖**（与 LongMemEval 的生活域模板基本重合）。

**2.2 体积实测（全库按 21 类正则打标）**：food 656 key/729 语句、sports 468/526、travel 404/467、social 280、books 268、career 251、music 232、art 227、education 199、home 141、social-media 134、tech 128、finance 125、health 106、plants 103、hobby 96、movies 92、pets 67、charity 50、real-estate 44。⇒ **DB 级“类别全量拉取”不可行**（旅行一拉 467 条，跨几百个 persona）；**用户（persona）级拉取完全可行**：单题金标会话平均 23.5 key / 24.3 语句（min 9 / max 44），折合 1–2K token，远小于上下文预算。**类别必须以“用户”为第一作用域**（生产环境天然单用户；benchmark 中=会话组）。

**2.3 碎片化（拉取后去重是前置条件）**：6456 个 key 零重名，但**760 对 key 名 token-Jaccard≥0.6 的近亲**（zaraBootExchange↔zaraBootsExchange、mcuMarathon↔movieBingeMarvel、toasterOvenReplacement↔toasterOvenUpgrade、westElmCoffeeTable↔westElmCoffeeTablePurchase、digitalMarketingWorkshop↔…Attendance）。同一事件常落 2–3 个 key——类别聚合计数前**必须按事件去重**（即 M5 别名合并），否则“3 件衣物”会数成 4。

**2.4 类别间重叠**：真实边界案例集中在“钱”和“人”上——花钱类问题（36b9f61e 奢侈品、gpt4_d84a3211 骑行开销、9aaed6a3 返现、gpt4_731e37d7 工作坊费）需要“域类别+金额属性”而非独立 finance 类；属性（金额/日期/人数）应结构化存在语句上（如 value 附 amount 字段），类别只管“域”。当前 schema 已有 `unit`/`event_time` 位置可放。

---

## 3. 路由可行性（问题词面 → 类别）

| 信号 | 实测 | 含义 |
|---|---|---|
| 问题 token ∩ **金标 key 名** | 平均重叠 **14%**；**18/41 题为零**（jewelry/bake/wedding/instruments/tanks/doctors 等类别词在 key 名中根本不出现） | 纯关键词表路由（对 key 名）**不可行**；现有 F1 词面检索饿死同源 |
| 问题 token ∩ 金标语句 **value** | 平均 **34%**；12/41 题为零（多为中英语言差） | 词面路由天花板 ~2/3 |
| **BM25 路由**（问题 → 21 类别档案，档案=key 名+描述） | **top1 78% (32/41)，top3 85% (35/41)**——且这还是在我的正则打标有 15% 错标、类别词表有洞（jewelry/bake 无归属）的情况下 | 词面路由**够用但不到顶**；主要失误模式：钱词→finance 抢走（36b9f61e、gpt4_731e37d7）、社交词抢走（46a3abf7 "friend"、gpt4_2f8be40d "attended"）、词表洞（jewelry） |
| 嵌入路由（未本地跑，dogrouter 有 qwen3.7-text-embedding 1024 维，与库内语句 embedding 同源） | 未测，但 12 个零词面题全是语义题（synonym+跨语言），恰是嵌入的赢面 | 作为主路由有明确依据 |

---

## 4. 设计建议

**4.1 类别从哪来 —— 抽取时 LLM 打标签（推荐），事后聚类只用于存量回填**
- 数据依据：正则/关键词打标在金标 key 上错标率 15%（jewelry、clothing、zaraBoot 无词面签名，“买”的动词有 bought/ordered/got/exchanged/acquired 无数变体）；而金标 key 语义单簇率 40/41，说明 LLM 打标极易做对。
- 具体：`dimension.attributes.category` = 固定 ~20 槽 taxonomy（travel、shopping、sports-fitness、food-dining、health、home、music、art、entertainment(影视)、books、hobby-collecting、plants-garden、pets、social-events、work-career、education-learning、finance、tech、community-charity、real-estate）。抽取 prompt 在铸 key 时一并输出，零额外调用。
- 存量 6456 维度：一次性 LLM 回填（key+description+样例 value → category），顺手把 760 对近亲 key 做别名合并（M5）。不要走“维度 key 命名规范”（如 `travel.flights.*`）——等于重命名 6456 个 key 且约束未来命名，收益低于一个属性字段。
- 键名规范只加一条软规则：**同类事实复用已有 key**（写时先查同 category 相似 key），治本零复用。

**4.2 粒度建议：~20 个生活域类别（粗），不设第三层硬层级**
- 按 §2.1，16 类已覆盖 41 题；20 类留余量。**不需要**细到 travel.flights/taxi/hotel 分开——聚合问题（count/sum）要求的“实例类型”（婚礼 vs 派对、奢侈品 vs 全部消费）在拉取后的 24 条语句里由回答层现场分辨即可，粒度成本趋零。
- 收益口径：33 题事实完整题 × 路由命中率。BM25 top1 路由 ≈ 26 题；top2 路由（按 top3=85% 折算）≈ 28 题；嵌入主路由预计 30–33 题（未本地实测，建议把“12 个零词面题”当路由器验收集）。另 8 题需修抽取（保数字/时长/购买动作），与类别层正交、叠加生效。

**4.3 路由器实现：嵌入最近邻为主 + BM25 为辅 + 聚合问句自动升档**
- 主：问题 embedding → 各 category 质心（用该类全部 key 描述+语句 embedding 离线算好缓存）cosine，取 **top-2 类别**。
- 辅：BM25（问题 → 类别档案）兜词汇硬命中；与嵌入取并集。
- 触发条件：问题呈聚合形态（how many/total/how much…combined/in the past N months）才启用类别拉取——41 题全部是此形态；普通事实问句走现有混合检索即可。
- **拉取实现**：同 category AND 同用户（生产=单用户库；benchmark=source_refs 会话组）的全部维度语句，按 §2.2 实测 ≤44 key/25 条，直接全拉；再叠加现有混合检索的 top-k 结果。
- 前置依赖：事件去重（M5 别名合并），否则计数翻倍（zaraBootExchange/zaraBootsExchange、mcuMarathon/movieBingeMarvel 实测在库）。

**4.4 兜底（路由错怎么办）**
1. **类别拉取是增量通道，不是替换**：现有向量+词面+RRF 照跑，拉错的类别只是多了一路无效召回，不挤占（k=8 屏幕内混合去重）。
2. **top-2 类别 + 置信门限**：嵌入余弦低于阈值（或两类别得分接近）时降级为“不路由、纯混合检索”——宁缺勿错。
3. **预算护栏**：类别拉取设上限（如 60 语句/48 行渲染，复用 maxContextLines 旋钮），超限按 event_time 新近度+state=accepted 截断。
4. **钱词分流**：问句含金额/开销意图时，附加“amount 属性非空”的语句过滤而非路由到 finance 类（36b9f61e/gpt4_731e37d7 实证 finance 是路由黑洞）。
5. **写路径同修**（8/41 题的死因）：抽取契约强制保留数量、时长、价格、“买了/装了/修了”类完成动作——否则类别层命中也无料可拉。

附：错题清单重建依据 `judge-result-full500.json` by_type（multi-session 121 中错 41，其中 30 个 oracle multi-session 题被 `_abs` 拒答变体替换计入 abstention）；分析中产生的临时文件已清理，项目目录无写入残留。