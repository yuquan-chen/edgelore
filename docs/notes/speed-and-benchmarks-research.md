# 速度对标 + 评测基准全景调研

> 2026-09-20 · 两路并行：检索速度/索引方案对标 + LongMemEval 之外基准全景

---

# 第一部分：检索速度对标（Zep/Mem0/Letta/Hindsight/通用方案）

# 主流 AI 记忆系统检索速度/索引方案调研

## 1. Zep（Graphiti）

**索引方案**
- 检索 = 三路混合：cosine 语义相似（Lucene 向量索引）+ Okapi BM25 全文（Lucene）+ BFS 图遍历，检索路径**零 LLM 调用**；重排用 RRF/MMR/episode-mentions/node-distance/cross-encoder（其中 cross-encoder 成本最高）。来源：[Zep 论文 arXiv 2501.13956](https://arxiv.org/abs/2501.13956)
- 官方称向量 + BM25 索引提供“与图规模无关的近常数时间访问”，两种索引均由 Neo4j 原生支持；2026 年新后端是自研图数据库 Konig（Context Lake），此前是 Neo4j/FalkorDB。来源：[Neo4j 博客](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)

**延迟数字（官方自报）**
- 首页基准卡：**LoCoMo 检索 155ms**（94.7% 准确率，5,760 tokens）/ **LongMemEval 检索 162ms**（90.2%，4,408 tokens）；更早版本首页为 **p50 104ms / p95 162ms**。来源：[getzep.com](https://www.getzep.com/)
- 规模化曲线（首页 Context Lake 图，检索 p95）：**10K 图 148ms → 100K 152ms → 1M 156ms → 10M 161ms → 100M 168ms**，近乎水平，是“索引化近常数检索”的最直接证据
- Graphiti 博客报 **P95 300ms**；论文中 LongMemEval 端到端总延迟（含 LLM）：Zep+gpt-4o 2.58s vs full-context 28.9s（~90% 降），上下文 1.6k vs 115k tokens。注意论文自己注明：延迟是从波士顿家用笔记本打到 AWS us-west-2 测的，**含公网 RTT**
- 争议：Mem0 论文测得 Zep search p50 513ms / p95 778ms；Zep 反驳称自测 p95 632ms。厂商数字互不认账

## 2. Mem0

**索引方案**
- 默认向量库 **Qdrant**（无配置时落 `/tmp/qdrant` 本地），history DB 默认 SQLite；Mem0g 图变体用 **Neo4j**，检索为“实体锚点子图扩展 + 语义三元组匹配”双路。来源：[docs.mem0.ai](https://docs.mem0.ai)、[arXiv 2504.19413](https://arxiv.org/abs/2504.19413)

**延迟数字（官方论文 LoCoMo Table 2，单位秒）**
- **Mem0 search p50 0.148 / p95 0.200**（全场最低）；total p50 0.708 / p95 1.440 —— 即官方口径 **148ms / 200ms**
- **Mem0g search p50 0.476 / p95 0.657**（加图后检索慢 ~3 倍，直接量化了图开销）
- 对照组：A-Mem search p50 0.668s；LangMem p50 **17.99s**（反例：检索型记忆不优化可以慢到不可用）；RAG 最优配置 p50 ~0.24-0.29s；full-context total p95 17.12s（Mem0 称比它低 91%）
- Qdrant 本体（非 Mem0 特定）：通用基准 **100K 向量 HNSW ~1-5ms**；学术评测中 Qdrant 中位延迟 ~4.55ms（专用向量库最佳）。即 Mem0 的 148ms 中 Qdrant 只占个位数 ms，大头在其编排链路

## 3. Letta (MemGPT)

**索引方案**
- Archival memory = **pgvector** 语义检索；核心记忆（in-context blocks）不检索、常驻 prompt —— 本质是“少检索”路线

**延迟数字**
- **未找到任何官方 archival 检索 ms 数字**（文档/博客只讲准确率）
- Sleep-time compute 论文（[arXiv 2504.13171](https://arxiv.org/abs/2504.13171)，Letta+UC Berkeley）：同等准确率下 test-time 计算量降 **~5x**（Stateful GSM-Symbolic）；闲时预热 KV cache 换 **TTFT 最高 ~5x 降低**。但量的是 LLM 推理延迟，**不是检索通道**。来源：[Letta 博客](https://www.letta.com/blog/sleep-time-compute)

## 4. Hindsight（Vectorize.io）

**索引方案**（[arXiv 2512.12818](https://arxiv.org/abs/2512.12818)，2025-12）
- 四网络（world/experience/opinion/observation）+ **四路并行检索**：语义（**pgvector HNSW**）+ 关键词（Postgres **BM25 全文 + GIN 索引**）+ 图（spreading-activation BFS）+ 时间（规则日期解析器 + flan-t5-small 兜底）→ RRF 融合 → **cross-encoder 重排**（ms-marco-MiniLM-L-6-v2）→ token 预算裁剪

**延迟数字**
- 论文本身**只报准确率，零延迟数据**（LongMemEval 83.6→91.4%，LoCoMo 83.18→89.61%）
- 第三方 PrecisionMemBench 论文（"Structured Belief State"，[arXiv 2605.11325](https://arxiv.org/abs/2605.11325)，2026-05）实测：**Hindsight 单轮检索均值 672.15ms，p50 589.86ms，p95 1,185.33ms**。四通道并行救不了总延迟，**cross-encoder 重排是百毫秒级大头**——这点对 edgelore 是利好（词面 F1 + 余弦无重排路线天然占优）

## 5. 通用方案

**sqlite-vec**（作者自测，Mac M1 mini，来源：[v0.1.0 发布博客](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)、[GitHub](https://github.com/asg017/sqlite-vec)）
- 纯 C 单文件、零依赖、可加载扩展 —— 与 edgelore 路线完全同构；**当前仅暴力全扫，无 ANN**
- **100K 向量落盘（vec0 虚表）：1024/768/384/192 维全部 <75ms**；1536 维 105ms；3072 维 214ms。**bit 二值量化后 3072 维仅 11ms**（OpenAI text-embedding-3-large 实测量化后保 ~95% 精度）
- 1M 向量：float 3072d 8.52s、192d 192ms，二值量化 124ms；1M×128d（sift1m）vec0 33-35ms / static 17ms / faiss 10ms；500K×960d（GIST1M）vec0 87-89ms。作者的金标准线：**<100ms**
- 结论：**edgelore 规模（8K）到 10 万级向量，sqlite-vec 是唯一同时满足“单文件+零依赖”的升级路径**；二值量化可把 10 万级压到 ~10ms

**HNSW @ 10 万级**
- 100K 向量 ~**1.5ms/query**（HNSW）vs 2.4ms（IVFFlat）vs **650ms（顺序扫描）**；recall 0.8→0.95 延迟 +~31%；参数不随规模调整时 10K→200K 延迟可恶化 12x。来源：[BigData Boutique](https://bigdataboutique.com/blog/hnsw-vs-ivfflat-how-to-choose-the-right-vector-index)、[Redis 生产基准](https://ranjankumar.in)
- 即 10 万级下 HNSW 比暴力扫快 ~400 倍，但这是服务型/嵌入式库（vectorlite=SQLite+hnswlib，可到百万级）的能力，sqlite-vec 本体暂无 ANN（[vectorlite](https://1yefuwang1.github.io/vectorlite-ann-benchmarks/)）

**SQLite FTS5 (BM25)**
- 内建 `bm25()` 排序 + 倒排索引（查询亚线性）；官方文档不发性能数字（[sqlite.org/fts5](https://www.sqlite.org/fts5.html)）
- 实测参考：**10K 文件代码库 ~10ms/query**（[ffts-grep](https://github.com/mneves75/ffts-grep)）；Drupal 站点语料平均 ~57ms 无缓存（[jaspersmet.be](https://www.jaspersmet.be)）；极端规模下 Turso 2026 年弃 FTS5 换 Tantivy（[turso.tech](https://turso.tech)）——但那是海量语料场景，10 万级语句远未到

## 6. 关键发现：延迟基准是行业空白（edgelore 可立的旗）

- Zep 论文原话承认："**Current literature on LLM memory and RAG systems insufficiently addresses production system scalability in terms of cost and latency. We have included latency benchmarks for our retrieval mechanisms to begin addressing this gap.**"（[arXiv 2501.13956 §5](https://arxiv.org/abs/2501.13956)）
- 盘点：**只有 Zep 和 Mem0 公开报检索延迟**，且两家数字互相打架（Mem0 测 Zep 778ms p95，Zep 自报 162ms p95）；**Letta、Hindsight 的论文/文档只有准确率、零延迟**（Hindsight 的 672ms 是第三方 2026 年才补测的）。2026 年才出现第三方延迟评测苗头（PrecisionMemBench 等）
- 结论成立：**“延迟+质量双报”仍是空白位**——同一管线同页报 p50/p95 + LongMemEval 准确率 + 上下文 token 数（Zep 三元组），本地可复现、无网络 RTT 干扰，edgelore 的 55ms 有天然公信力优势

## 7. 对 edgelore 的速度路线图建议

**当前定位**：8k 语句、~55ms。**已经快过所有对标对象**：Zep Cloud 官方 p50 104ms（含网络 RTT）/ LoCoMo 检索 155ms，Mem0 search p50 148ms，Hindsight p50 ~590ms——而且 edgelore 是零依赖本地进程。8K 规模下无需任何索引升级，这个数字可直接写进 README 旗帜。

**线性外推与触发条件**（按 ~6.9µs/语句）：

| 规模 | 暴力扫预期延迟 | 动作 |
|---|---|---|
| ≤50K（现 8K） | ~55-345ms | **不动**。先做剖析：确认 55ms 里余弦/F1/缓存各占多少；常数优化（Float32Array 批量点积、缓存命中率）优先于上索引 |
| 50K-150K | 350ms-1s，越过警戒线 | **上 sqlite-vec vec0**（余弦通道走 C）+ int8/bit 量化（1024 维 10 万级 <75ms float、二值量化 ~10ms）；**上 FTS5 替代全表 F1**（词面通道从 O(N) 降亚线性，10K 行 ~10ms 量级），F1 降级为 top-K 候选上的精排。两者都是可加载扩展，**单文件+零依赖约束不破** |
| >200K-1M | 暴力已不可行 | sqlite-vec 二值量化 + partition key（按会话/用户分片扫描）；或 vectorlite（hnswlib，1-2ms@100K）——但此时已破“纯 SQLite"底线，需权衡 |
| 任何规模 | — | **不引入 cross-encoder 重排**：那是 Hindsight 672ms→1185ms p95 的直接来源；RRF 融合余弦+FTS5 两路已是零成本的质量增益 |

**发布动作**：每次跑 LongMemEval/ORACLE 时同页报 p50/p95 + 准确率 + context tokens，注明“本地进程、无网络 RTT、可复现”，直接对位 Zep 的三连卡——这是目前只有 Zep 在做且 vendor 数字互不服的空白。

**主要来源**：[getzep.com](https://www.getzep.com/) · [arXiv 2501.13956](https://arxiv.org/abs/2501.13956) · [Neo4j/Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/) · [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) · [docs.mem0.ai](https://docs.mem0.ai) · [arXiv 2504.13171](https://arxiv.org/abs/2504.13171) · [arXiv 2512.12818](https://arxiv.org/abs/2512.12818) · [arXiv 2605.11325](https://arxiv.org/abs/2605.11325) · [sqlite-vec v0.1.0](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html) · [bigdataboutique.com](https://bigdataboutique.com) · [sqlite.org/fts5](https://www.sqlite.org/fts5.html)

---

# 第二部分：评测基准全景（LoCoMo 之外）

# LongMemEval 之外的记忆/长对话评测基准全景菜单

先给一句话结论：**LoCoMo 是老考场（已饱和+口碑破产），LongMemEval 是现行主考场，MemoryAgentBench 是与 edgelore 四大能力（事实抽取/时间推理/矛盾治理/遗忘）对位最好的补考，而“多用户共享记忆”已有 3 个 2026 年新考场（EverMemBench / GroupMemBench / GateMem）——这正是 edgelore 终局愿景的先声。** 注意：所有分数均为各家在自己 harness 下自测，跨系统数字不可直接比较（LoCoMo 分数战就是教训）。

---

## 一、点名基准详解

### 1. LoCoMo（ACL 2024，Snap Research，arXiv 2402.17753）
- **考什么**：超长多 session 对话理解。~1,986 个 QA，5 类问题（单跳/多跳/**时间推理**/开放域/**对抗性**），另设事件摘要与多模态（图片）任务。
- **规模/格式**：50 组真人自述长期对话（每条约 300 轮、~9K token、最多 35 个 session）；**公开版只有 10 组对话**。
- **谁提出**：Maharana et al.（Snap + UNC）。
- **谁跑过/分数战**（务必了解这段历史）：
  - 2025.4 Mem0 论文自称 SOTA 66.9%（LLM-judge），同时把 Zep 测成 37%；
  - 2025.5 Zep 发博客《Lies, Damn Lies, & Statistics》反击，指 LoCoMo 本身有缺陷（样本小、金标噪声大、judge 方差），自测 Zep 84.61%（自家 J-score harness），并称“在 Mem0 的评测口径下 Zep 高 ~10%，在 Zep 口径下高 ~24%”；
  - 2025.8 Letta 加入混战：纯**文件系统**记忆拿 74.0%，质疑专用记忆层的必要性；
  - 2026 第三方复盘（arXiv 2608.21690 等）认为修正评测后 Zep 实际约 58.44%；Mem0 营销口径则已刷到 92.5。
  - **教训**：结论完全取决于检索 prompt、judge 模型和分数口径——社区公认 LoCoMo 已饱和且方法学有硬伤，但仍是每家必跑的“入场券”。
- **公开性**：公开（github.com/snap-research/locomo + HF）。

### 2. LongMemEval-V2（2026.5，UCLA Di Wu / Kai-Wei Chang 组，arXiv 2605.12493，ICML 2026）
- **考什么**：你猜的“积累环境经验”基本正确，但场景不是聊天而是**定制化 web/企业 agent 环境**。新标准是“记忆系统应帮 agent 成为有经验的同事（experienced colleague）”，考 5 种记忆能力：**静态状态回忆、动态状态追踪、工作流知识、环境 gotchas（坑）、前提觉察**。
- **规模/格式**：451 道人工策展题；历史轨迹最多 500 条轨迹 / **115M token**；采用"context gathering"式：记忆系统消费历史轨迹、为下游 QA 返回紧凑证据。
- **谁跑过/分数**：论文提出 AgentRunbook-C（轨迹存文件+coding agent 取证）72.5% > 现成 coding agent 69.3% > 最强 RAG 基线 48.5%；但 coding agent 法延迟极高。
- **公开性**：公开（GitHub xiaowu0162/LongMemEval-V2 + HF xiaowu0162/longmemeval-v2）。
- **对 edgelore**：与 V1 同族但考察对象从“用户历史”变成“环境经验”——第一期（个人聊天助理）不匹配，但它是“记忆要服务行动而非背诵”这一新范式的旗手，值得跟踪。

### 3. MemBench（ACL 2025 Findings，人大+华为诺亚，arXiv 2506.21605）
- **考什么**：更全面的记忆评测：**事实记忆 + 反思记忆**两个层级 × **参与 + 旁观**两种交互场景；指标三维：**有效性、效率、容量**。设单 session 答不出的跨 session 问题。
- **规模**：多 session 对话数据集 + QA（论文 Table 有精确统计；社区引用 ~110 次）。注意与一个更早的 ICRL 2025 "MemBench"（记忆机制训练方法）重名，搜的时候别混。
- **谁跑过**：论文内基线（RAG/MemGPT 系）+ 后续记忆论文引用；Letta 宣布将其纳入标准评测套件。
- **公开性**：公开（github.com/import-myself/Membench）。
- **对 edgelore**：中。反思记忆、效率/容量指标与 edgelore 关心点重合，但数据是构造性对话。

### 4. PerLTQA（SIGHAN @ ACL 2024，Yiming Du et al.，arXiv 2402.11777）
- **考什么**：**个人长期记忆**的利用：社交关系 + 事件两类个人记忆；三子任务 = **记忆分类、记忆检索、记忆融合**。
- **规模/格式**：8,593 个 QA、30 个人设（persona）；记忆库 + 配对 QA。
- **谁跑过**：主要是学术系统（GPT-4 融合等），未成为商业系统标准考场（~100 引用）。
- **公开性**：公开但**仅限非商业研究**（github.com/Elvin-Yiming-Du/PerLTQA）。
- **对 edgelore**：中。题材对口（个人事实+社交关系），但数据质量一般、静态、且授权限制商用。

### 5. DialSim（arXiv 2406.13144，2024，KAIST，~23 引用）
- **考什么**：**实时**长期多方对话理解：agent 扮演《老友记/生活大爆炸/办公室》角色，被随机提问，需从过去对话找答案并**区分知道/不知道**（含 v1.1 不可答多跳题）；另有名字打乱对抗测试。
- **规模/格式**：3 部剧脚本 + 自建 LongDialQA；模拟器形态（history 存 entire/summary、可插 bm25/emb/oracle 检索）。
- **谁跑过**：论文内 LLaMA/Qwen/GPT-4o 等在多检索组合下的对比。
- **公开性**：公开（github.com/jiho283/DialSim，数据可下载）。
- **对 edgelore**：低。影视多方剧本域，娱乐性强，不是个人事实记忆。

### 6. MemoryAgentBench（2025.7，UCSD Hu/Wang/McAuley，arXiv 2507.05257，231+ 引用——当前最火的记忆基准之一）
- **考什么**：基于记忆科学的**四大能力**：**准确检索、测试时学习（test-time learning）、长程理解、选择性遗忘（selective forgetting）**。以“增量多轮对话”形态喂信息，模拟记忆 agent 真实工作方式。
- **规模/格式**：改造现有长上下文数据集 + 自建数据集为多轮格式，覆盖四能力；评测 context / RAG / MemGPT / Mem0 / A-Mem 等外部记忆模块——结论是**没有一个系统同时做好四项**。
- **公开性**：公开（HF ai-hyz/MemoryAgentBench + GitHub）。
- **对 edgelore**：**高**。四能力与 edgelore 的抽取/时间推理/矛盾治理几乎一一对应（选择性遗忘≈矛盾治理，测试时学习≈在线事实更新），且是 UCSD 同一门（Julian McAuley 组）的“静态场”，与交互式的 LongMemEval 互补。

---

## 二、2025-2026 新基准（含多智能体/共享记忆，重点标出）

### A. 多用户/多 agent 共享记忆类 —— edgelore 终局愿景的直接对标（★）
- **★ EverMemBench**（2026.2，arXiv；ACM 2026.8）：**首个长程协作记忆基准**。多方、多群组对话，>1M token，流式多群组协议：5 个项目各模拟**一整年的每日对话**。最强系统仅 **46.0%**，知识更新（knowledge updates）项崩得最惨。→ 已有系统在“多人+长期+更新”下全部失效，这就是 edgelore 要打的空地。
- **★ GroupMemBench**（2026.5，Microsoft 系）：多用户对话记忆。图基合成管线生成群聊 + 结构化/对抗 QA，考**群组动态、说话人锚定的信念追踪**（谁说了什么/谁知道什么）。SOTA 记忆系统峰值仅 **46.01%**，主要死在张冠李戴。
- **★ GateMem**（2026，Ren et al.，arXiv，引用尚少）：**多主体（multi-principal）共享记忆治理**：在共享记忆下同时保证**效用、访问控制（谁有权看/存什么）、主动遗忘（删除请求/被遗忘权）**。有项目页 + GitHub 工具包。→ 记忆的“权限与合规”维度，目前唯一考场。
- **Collaborative Memory**（2025.5，arXiv）：跨用户共享知识但满足各用户隐私约束的框架（方法论文，非基准，可作参考）。

### B. 个人助理向（edgelore 第一期直接相关）
- **RHELM**（Microsoft，2026）：个人 AI 助理的**真实、异构、演化**长期记忆：动态演化用户画像 + 非纯对话的异构信息源。概念上与 edgelore 最贴近；项目页/GitHub 已放出。
- **STALE**（2026，~20 引用）：专考“**agent 知不知道自己的记忆过期了**"：~1,200 条查询，三维探测（状态解决/前提阻抗/冲突处理），最强前沿模型仅 **55.2%**；附 CUPMEM 原型系统。→ 与 edgelore 的时间推理/矛盾治理直接对位。
- **RealMem**（2026.1，Bian et al.，GitHub+HF）：首个真实**项目场景**长期记忆基准：11 个场景、2,000+ 跨 session 对话，项目状态持续演化，多 agent 仿真管线合成。诊断性质，现有系统全线挣扎。
- **PAL-Bench / Mem-PAL**（AAAI 2026）：个性化服务型助理长期对话，17 个用户、多 session 日常场景 + **用户行为日志/画像**（不只对话文本）。

### C. 能力/规模压力类
- **BEAM**（ICLR 2026，Tavakoli et al.，arXiv 2510.27246）：把对话推到 **128K/500K/1M/10M token**，~2,000 题分 10 类任务（事实检索/时间/多跳聚合…）。像 Mem0 这类记忆系统比裸长上下文 +155%。Mem0 将其列为三大考场之一。GitHub 开源。
- **MemoryArena**（2026.2，UCSD+MIT+UW，arXiv 2602.16313，~67 引用；与 MemoryAgentBench 同门）：**统一评测 gym**，多 session“记忆-代理-环境”回环，子任务**相互依赖**（web 导航/偏好约束规划/渐进信息检索/序贯形式推理）。核心发现：在 LoCoMo 上接近饱和的系统到 agentic 场景**表现很差**——“背下来”≠“用得上”。
- **STATE-Bench**（Microsoft，2026.5，GitHub microsoft/STATE-Bench）：企业任务（差旅/客服/购物）中 agent 是否**随经验变强**（跨有序任务的经验积累）。

---

## 三、对照表

| 基准 | 考什么 | 规模 | 公开性 | 代表系统分数（各家自测，不可横比） | 对 edgelore 第一期（个人助理）适配度 |
|---|---|---|---|---|---|
| LoCoMo | 长对话 QA（时间/对抗/多跳）+摘要 | 50 组对话（公开 10），~9K token/组，~2K QA | 公开（GitHub/HF） | Mem0 92.5；Letta 文件系统 74.0；Zep 自测 84.6（被三方修正为 ~58）；分数口径混战 | **中**：必跑的入场券，但已饱和、评测方法学有争议；可作烟雾测试不宜作主 KPI |
| LongMemEval-V2 | web/企业 agent 的**环境经验**（工作流/坑/动态状态） | 451 题，最多 500 轨迹/115M token | 公开（GitHub/HF） | AgentRunbook-C 72.5；RAG 48.5 | **低**：场景是 web agent 非个人聊天；但其“记忆服务行动”范式值得吸收 |
| MemBench | 事实+反思记忆；有效/效率/容量三维 | 多 session 对话数据集（构造） | 公开（GitHub） | 论文基线 ~53-74%；Letta 拟纳入套件 | **中**：反思记忆+效率/容量指标契合，数据构造性强 |
| PerLTQA | 个人记忆分类/检索/融合（社交关系+事件） | 8,593 QA / 30 persona | 公开但**禁商用** | 学术系统为主，无商业 SOTA 榜 | **中**：题材对口但质量一般、授权受限 |
| DialSim | 实时多方长期对话，知道/不知道判断 | 3 部剧集脚本 + LongDialQA | 公开（GitHub） | 论文内多模型/多检索组合对比 | **低**：影视域、模拟器形态，非个人事实 |
| **MemoryAgentBench** | 准确检索/测试时学习/长程理解/**选择性遗忘** | 现有长上下文集改造+自建，多轮增量格式 | 公开（HF/GitHub） | 无系统四项全优（Mem0/MemGPT/A-Mem 等各有短板） | **高**：四能力与 edgelore 抽取/时间/矛盾治理一一对应，首选补考 |
| RHELM | 个人助理的异构、**演化**用户画像记忆 | 项目页+GitHub 已放出（微软） | 公开 | 新发，榜未成型 | **高**：个人助理+画像演化=edgelore 正面 |
| **STALE** | 识别记忆过期/拒绝过期前提 | ~1,200 查询 | 公开（HF） | 最强前沿模型仅 55.2% | **高**：正是时间推理+矛盾治理的显微镜 |
| RealMem | 项目制真实长期交互，演化项目状态 | 2,000+ 跨 session 对话 / 11 场景 | 公开（GitHub/HF） | 现有系统全线挣扎（诊断型） | **中高**：比聊天更真实的使用形态 |
| PAL-Bench | 个性化服务对话+行为日志 | 17 用户多 session | 公开（arXiv/AAAI） | 论文内基线 | **中**：个性化维度好，规模小 |
| BEAM | 超大规模记忆（10 类任务） | 128K-10M token，~2,000 题 | 公开（GitHub） | 记忆系统较裸长上下文 +155% | **中**：压力测试可选，跑一次成本高 |
| MemoryArena | 记忆的**功能效用**（记忆→行动） | 多 session 相互依赖 agentic 任务 gym | 论文+项目页（UCSD） | LoCoMo 饱和系统在此表现很差 | **低**（一期）：agentic 环境；但代表-field 方向 |
| STATE-Bench | 跨任务经验积累（企业） | 3 域企业工作流 | 公开（GitHub microsoft） | 新发 | **低**（一期）：企业任务向 |
| ★ **EverMemBench** | 多群组协作记忆、流式更新 | 5 项目×一年对话，>1M token | arXiv/ACM（代码随文放出中） | 最强系统仅 46.0%，知识更新项最差 | **中**（一期）/ **终局核心**：多人+更新=空白考场 |
| ★ **GroupMemBench** | 说话人信念追踪、群组动态 | 图基合成群聊+对抗 QA | 公开（arXiv） | SOTA 峰值 46.01% | **中**（一期）/ **终局核心**：多人张冠李戴是当前系统死穴 |
| ★ **GateMem** | 共享记忆治理：效用+访问控制+主动遗忘 | 项目页+工具包（早期，引用~4） | 公开（GitHub） | 尚无成熟榜 | **低**（一期）/ **终局唯一**：多用户记忆权限治理唯一考场 |

## 四、给 edgelore 的选考场建议（按优先级）
1. **MemoryAgentBench**（高）：四能力全覆盖，与 LongMemEval 正交互补，harness 成本低（HF 直接拉）。
2. **STALE + LongMemEval 的时间推理子集**（高）：直击矛盾治理/时间推理卖点。
3. **LoCoMo**（中）：只作对外沟通的“通用语言”，报告时写明 judge 与口径。
4. **RHELM / RealMem**（中高）：发布前拿来测真实演化画像场景。
5. **EverMemBench / GroupMemBench / GateMem**（终局）：多人共享记忆三件套，目前所有 SOTA 都在 46% 左右躺平——这是 edgelore 终局愿景最能讲故事的差异化战场，现在跟进还能占“首批被测系统”的位置。

Sources: [LoCoMo 论文](https://arxiv.org/abs/2402.17753) / [snap-research/locomo](https://github.com/snap-research/locomo) / [Zep 反击博客](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory) / [Letta 文件系统评测](https://www.letta.com) / [Mem0 三基准页](https://mem0.ai) / [LongMemEval-V2 (alphaXiv)](https://www.alphaxiv.org/abs/2605.12493) / [MemBench (arXiv)](https://arxiv.org/abs/2506.21605) / [MemoryAgentBench (arXiv)](https://arxiv.org/abs/2507.05257) / [MemoryArena (arXiv)](https://arxiv.org/abs/2602.16313) / [DialSim (GitHub)](https://github.com/jiho283/DialSim) / [PerLTQA (ACL)](https://aclanthology.org) / [BEAM (OpenReview)](https://openreview.net) / [STATE-Bench (Microsoft)](https://opensource.microsoft.com) / [EverMemBench (arXiv)](https://arxiv.org) / [GroupMemBench (arXiv)](https://arxiv.org) / [GateMem 项目页](https://rzhub.github.io) / [Zep LongMemEval SOTA 博客](https://blog.getzep.com)