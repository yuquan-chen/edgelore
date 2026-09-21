# 现有强势产品的记忆检索方案调研（生产机制，非论文）

> 2026-09-21 · ChatGPT / Gemini / Claude / Cursor / Memobase / Supermemory / Zep / Mem0 / Hindsight 的 shipped 机制
> 跨产品反膨胀机制 8 分类 + 零依赖可实现性标注

## 1. ChatGPT Memory（OpenAI）

**存什么**：两层。① "Saved memories"——用户明确让它记住的短句列表（"I'm vegetarian"式一行一条），存在独立的"记事本"里，与聊天记录分离；② "Reference chat history"——从历史对话提取的信息。

**怎么找**：逆向工程（Manthan Gupta、LLMrefs）证实：**saved memories 不走向量/RAG**。每次请求把全部记忆条目（实测 33 条全量注入）+ session 元数据 + ~15 条历史对话摘要 + 滑动窗口直接塞进 context，总预算约 1 万 token。聊天历史层则是"相关片段被加入新对话"（有检索行为），官方 FAQ 明确"无存储上限"。

**规模化手段**（本题最直接的产品答案）：
- **自动记忆管理**（官方 FAQ）：Plus/Pro 已上线——ChatGPT 按"新近度 + 提及频率"把最相关的记忆保持为 "top of mind"，不重要的**移入后台（置灰），而不是删除**，官方原话是"防止 saved memories 达到容量上限、避免 memory full 状态"。用户可手动调优先级。
- **模型自主合并**：ChatGPT 自己"更新、合并、删除"记忆条目，防止条目碎片化膨胀。
- 上限内全量注入 + 超限靠优先级分层 = 不需要检索也能找得到。

来源：[Memory FAQ | OpenAI Help Center](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq)、[逆向工程](https://manthanguptaa.in/posts/chatgpt_memory/)、[LLMrefs 分析](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory)

## 2. Gemini Saved Info（Google）

**存什么**：用户显式保存的指令/偏好（职业、进行中的项目），用户可在 "Saved info" 页面查看、编辑、删除——本质是**用户可控的自然语言指令清单**，非黑盒。

**怎么找**：直接注入后续对话做个性化；无公开的向量检索细节。

**规模化手段**：靠"用户手动管理 + 显式小清单"控制规模；Temporary Chat 提供完全绕过记忆的逃生口。Google 未公开处理记忆增长的机制——它把规模问题留在了"清单保持短小"上。

来源：[Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961)

## 3. Claude（Anthropic）

**存什么**：**memory 文件**（`/memories` 目录），聊天版把记忆存为"边聊边记录的一个个独立主题"（不是对话结束后做摘要）；Claude Code 用 CLAUDE.md + auto memory 文件。

**怎么找**：Simon Willison 的经典对比：**每次对话从白板开始，零预注入**；Claude 按需调用 memory tool（read/write/search）自己去翻记忆文件，检索是显式 tool call（用户可见）。检索质量 = 模型自主决定何时查、查什么（agentic retrieval）。

**规模化手段**：
- **检索成本与记忆量解耦**：记忆再多也不占 context，只有查到的才进窗口——这是对"记忆膨胀"最彻底的架构回答。
- 文件即记忆 = 天然支持目录组织/按主题分文件。
- 第三方分析提到聊天版有"三个 memory pool、24 小时刷新周期"（非官方）。

来源：[Simon Willison 对比文](https://simonwillison.net/2025/Sep/12/claude-memory/)、[Claude 官方帮助](https://support.claude.com/en/articles/10515114-using-claude-s-memory)、[Anthropic memory tool 文档](https://platform.claude.com)

## 4. 编码智能体：Cursor / Windsurf / Copilot

### Cursor（codebase indexing）
- **存什么**：代码按 **AST 语法分块**（非定长切行），每块算 embedding，存服务端向量库（Turbopuffer）。
- **怎么找**：查询时 embedding 相似度检索。
- **规模化手段**：**Merkle 树增量同步**——客户端对每文件算 SHA-256 建 Merkle 树，先比根哈希，一致则零传输；不一致只把变化的叶子（chunk）重嵌入。10 万文件库里改 3 个文件，只重嵌入 3 个文件的块。**索引永远新鲜 + 同步成本只随变更量而非总量增长**。
- 来源：[逆向 Cursor 索引管线](http://archiesengupta.com/blog/cursor-index-pipeline)、[Pragmatic Engineer: Building Cursor](https://newsletter.pragmaticengineer.com/p/cursor)

### Windsurf Cascade
- 自动生成的 memories + 手动 memories；**按当前上下文选择性召回，不整体注入**；明确区分"记忆"（可变的观察）与"rules"（恒定规则）；超长上下文自动摘要滚动。
- 来源：[Windsurf 官方](https://windsurf.com)

### GitHub Copilot Memory
- 智能体自主"发现并存储"仓库事实 + 个人编码偏好；与 copilot-instructions.md 静态规则文件分开；2025-12 起对 Pro/Pro+ 默认开启。
- 来源：[GitHub Blog](https://github.blog)

## 5. Memobase（画像派代表）

**存什么**：**结构化 JSON 用户画像**（人口属性/偏好/特质等开发者定义的字段）+ 事件时间线。消息先进 buffer，flush 时 LLM 把新信息**合并进画像字段**（属性级 update），不是堆原始记忆。

**怎么找**：不用检索——把整份结构化画像注入 prompt 作为个性化上下文（官方定位就是 RAG-memory 的替代品）。

**规模化手段**：**记忆量有上界**——画像字段数固定，新信息覆盖/细化旧属性而非追加条目。规模增长被"结构性合并"消灭在写入时。分工：画像层管"用户是谁"（常驻），事件时间线管"发生过什么"（可检索）。

来源：[Memobase GitHub](https://github.com/memodb-io/memobase)、[MemoBase MCP 概览](https://skywork.ai/skypage/en/memobase-mcp-server-ai-memory/1980822291598192640)、[MemConflict 论文对它的定位](https://arxiv.org/html/2605.20926)

## 6. Supermemory

**存什么**：任意文档/对话，SuperRAG 托管管线：extraction → indexing → storing → retrieval。有 memory graph 记录记忆间关系。

**怎么找**：**混合检索（向量 + 全文并行）+ context-aware reranking**，两阶段：先快通道粗召回，只对 top candidates 重排。

**规模化手段**：两阶段检索把延迟控制在 40–80ms 量级；混合检索保证精确关键词（代码标识符、日期）不被语义检索漏掉。

来源：[supermemory.ai](https://supermemory.ai)、[Supermemory docs](https://docs.supermemory.ai)

## 7. Zep / Mem0 / Hindsight（记忆基础设施三家）

### Zep (Graphiti)
- **存什么**：时序知识图谱（实体/关系/事实边），**bi-temporal**（每条事实带 valid_at / invalid_at）。
- **怎么找**：三路混合——cosine 语义 + BM25 全文 + 图 BFS 遍历，RRF 融合后重排。
- **规模化手段**：**edge invalidation**——新事实到来时把矛盾的旧边标为失效（不删除，历史可查），矛盾处理不需要靠 LLM 重写摘要；图遍历随对话长度**亚线性**扩展；LongMemEval/DMR 上大幅超基线（[Zep 论文 arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)）。

### Mem0
- 两阶段管线：**extraction**（LLM 从对话抽候选事实）→ **update**（对每条事实取向量库查相似旧记忆，LLM 用 tool call 裁决 **ADD / UPDATE / DELETE / NOOP**，优先级 NOOP > DELETE > UPDATE > ADD）。
- 规模化手段：**写入时主动消解矛盾**（DELETE/UPDATE 让过时记忆退场），记忆条目数不随对话数线性膨胀；检索 = 语义 + BM25 多信号。
- 来源：[Mem0 论文 arXiv 2504.19413](https://www.alphaxiv.org/abs/2504.19413)、[Kunal Kushwaha 解析](https://medium.com/@kunalkushwahatg/mem0-bd7467fef9ba)、[mem0.ai](https://mem0.ai)

### Hindsight (Vectorize)
- **存什么**：四类记忆网络（world / experience / opinion / observation），三原语 **retain / recall / reflect**；跑在单个 PostgreSQL 上。
- **怎么找**：recall 并行跑**语义 + 关键词 + 图 + 时间**四种检索策略，取"刚刚好"的上下文；ZeroEntropy 非对称重排器收尾。
- **规模化手段**：单库多策略融合 + 重排，宣称 LongMemEval >90%。
- 来源：[Hindsight 论文 arXiv 2512.12818](https://arxiv.org/html/2512.12818v1)、[Vectorize 博客](https://vectorize.io/blog/hindsight-building-ai-agents-that-actually-learn)、[GitHub](https://github.com/vectorize-io/hindsight)

## 8. 有公开"规模增长数据"的产品

- **ChatGPT**：唯一一个把"记忆满了怎么办"做成官方 shipped 功能的（top-of-mind 优先级 + 后台降级）。
- **Zep**：论文给出 DMR/LongMemEval 对比数据 + 图遍历亚线性扩展论证。
- **Hindsight**：LongMemEval >90% 的公开声称。
- **Cursor**：Merkle 同步让"索引维护成本 = f(变更量) 而非 f(总量)"，是大规模可保新鲜度的工程证明。
- **Supermemory**：40–80ms 延迟预算的工程声称。

---

# 跨产品共性总结：反膨胀机制分类

| 机制 | 做法 | 用它的产品 |
|---|---|---|
| **结构化画像层**（写入时合并） | 记忆 = 固定 schema 的属性集，新信息 update 属性而非追加条目，总量有上界 | Memobase、ChatGPT saved memories（合并更新） |
| **常驻核心层 + 全量注入** | 小而稳的核心（<万 token）每轮必进 context，不检索、永不漏 | ChatGPT saved memories、Gemini Saved Info、Memobase 画像 |
| **按需检索（白板启动）** | 零预注入，模型用 tool 自主查记忆；记忆量与 context 占用解耦 | Claude（chat + memory tool）、Windsurf Cascade |
| **分层：常驻 + 可检索** | "是谁"常驻，"发生过什么"检索 | ChatGPT（memories + chat history）、Memobase（画像 + 事件）、Claude Code（CLAUDE.md + auto memory） |
| **混合检索 + 重排** | 向量 + BM25/全文并行粗召回，重排只跑 top-k | Zep、Supermemory、Mem0、Hindsight |
| **主动遗忘/失效** | 写入时 DELETE/UPDATE/NOOP 消解矛盾，或时态边标记失效 | Mem0、Zep（edge invalidation）、ChatGPT（自动合并删除） |
| **优先级降级而非删除** | 按新近度+频率分 "top of mind / 后台"，控容量不丢数据 | ChatGPT 自动记忆管理 |
| **增量同步/选择性重算** | 哈希树 diff，只重算变化部分 | Cursor（Merkle 树） |

## 零依赖本地单文件可实现标注

**✅ 可直接实现（纯文本 + 规则，无需外部服务）：**
- 结构化画像层（JSON 属性合并）—— Memobase 模式，LLM 中转即可做合并
- 常驻核心层 + 全量注入 + token 预算 —— ChatGPT 模式
- 优先级降级（新近度+频率排序）—— 纯统计，零 LLM 成本
- 主动遗忘（ADD/UPDATE/DELETE/NOOP 裁决）—— 一次 LLM 调用可做
- 分层摘要 / 滚动压缩
- 白板 + 按需文件检索（Claude 模式）—— 记忆按主题分文件，靠 prompt 让模型自己 grep/read

**⚠️ 需要额外组件但本地可做：**
- 混合检索（向量已有 qwen3.7-text-embedding；BM25 可用 SQLite FTS5 / 纯 Python 实现倒数排名融合）
- 重排—— 无重排模型时可用 LLM 对 top-20 粗排（dogrouter deepseek-v4-flash 可承担）

**❌ 单文件难做（不值得追）：**
- 时态知识图谱 + bi-temporal 边失效（Zep）—— 图遍历 + Neo4j/FalkorDB 依赖
- Merkle 增量同步的服务端架构（Cursor）—— 但"按文件哈希 diff 只重嵌入变化块"的**思想**可以单文件落地
- 托管式 memory graph

**对 edgelore 最有性价比的组合**（来自已上线产品的共识）：结构化画像层（有界）+ 小常驻核心 + 向量/BM25 混合召回 + 写入时 NOOP/DELETE 消解 + 新近度频率优先级降级——全部零外部依赖。

---

**Sources:**
- [Memory FAQ | OpenAI Help Center](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq)
- [I Reverse Engineered ChatGPT's Memory System — Manthan Gupta](https://manthanguptaa.in/posts/chatgpt_memory/)
- [How ChatGPT Memory Works, Reverse Engineered — LLMrefs](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory)
- [Comparing the memory implementations of Claude and ChatGPT — Simon Willison](https://simonwillison.net/2025/Sep/12/claude-memory/)
- [Use Claude's chat search and memory — support.claude.com](https://support.claude.com/en/articles/10515114-using-claude-s-memory)
- [Gemini Apps Privacy Hub — Google Support](https://support.google.com/gemini/answer/13594961)
- [Reverse-Engineering Cursor's Indexing Pipeline](http://archiesengupta.com/blog/cursor-index-pipeline)
- [Building Cursor — Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/cursor)
- [Memobase GitHub](https://github.com/memodb-io/memobase)
- [MemoBase MCP Server overview — skywork.ai](https://skywork.ai/skypage/en/memobase-mcp-server-ai-memory/1980822291598192640)
- [Supermemory](https://supermemory.ai)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory — arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- [Mem0 paper — arXiv 2504.19413](https://www.alphaxiv.org/abs/2504.19413)
- [Mem0 explainer — Kunal Kushwaha](https://medium.com/@kunalkushwahatg/mem0-bd7467fef9ba)
- [Hindsight paper — arXiv 2512.12818](https://arxiv.org/html/2512.12818v1)
- [Building AI Agents That Actually Learn — Vectorize](https://vectorize.io/blog/hindsight-building-ai-agents-that-actually-learn)
