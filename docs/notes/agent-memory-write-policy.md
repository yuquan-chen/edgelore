# Agent Memory 写入策略调研（"值得存"的判据）

> 调研时间：2026-09-17。目的：深入看 Mem0 / Letta / LangMem / A-MEM / Graphiti 怎么定义"值得存"，校准我们的门控 gate 判据。
> 结论已回流到 `docs/agent-memory-design.md` §3.2。

## 1. 行业共识：四阶段写入管线

来源：blog.jatinbansal.com《Memory Write Policies》。Mem0 / LangMem / Letta / A-MEM 收敛到的模式，按名字记清各阶段，设计决策才清晰：

- **Stage 1 Triage（分诊）**：最便宜的过滤。跳过系统消息、空 assistant 回复、纯客套（"Got it""Thanks"）。**不用模型调用**，regex / 启发式。成本关键——跳过这步直接 LLM 抽取是常见生产 bug（每活跃用户每天 $5 抽"ok"回合）。
- **Stage 2 Extract / Distill（抽取/蒸馏）**：清过流的回合 → 变成要存的形状。三种形状：原始 episode（journal-only）、结构化 fact `{type, subject, value, confidence}`（checkpoint-only）、或混合。小模型调用（Mem0 默认 GPT-5-mini / Haiku / Llama-3-8B）。这一步区分"记忆"和"转录"。
- **Stage 3 Dedupe / Resolve（去重/解决）**：检查重复或矛盾。混合查找：精确匹配（稳定 ID，如归一化实体名）+ embedding 相似度阈值。冲突处理 **2026 生产答案**：不在同步路径删，写新事实、旧打 back-reference，读时 rerank 或后台 reconcile。
- **Stage 4 Persist / Index（持久化/索引）**：嵌入、写存储、建索引。最便宜物理操作。分层：高置信 durable 偏好 → hot/core；中 → warm；低置信原始 → cold。

## 2. Mem0 官方的"值得记住 vs 该忘"判据（权威）

来源：mem0.ai 官方博客《What should AI agent remember vs forget》。

**值得记住：**
- 稳定身份事实：name, location, profession, primary language, organization（变更少、几乎任何未来会话都高价值）
- 持久偏好：沟通风格、技术选择、饮食限制、格式偏好、工作时间
- 目标与活跃项目："building a SaaS for HR teams""studying for AWS cert"（稳定直到显式改）
- 有下游影响的过去决策："chose PostgreSQL over MongoDB""decided not to use TypeScript"
- 表达的约束："budget is under $500/month""must stay HIPAA compliant""team has no ML expertise"（作为推荐常驻过滤器）

**该丢弃：**
- 对话填充：问候、肯定、客套（"Thanks!" 不值存）
- 瞬时状态："I'm tired today""my internet is slow right now"（下次会话就 stale）
- 被矛盾的信息：用户说了和已存记忆冲突的 → 旧条目应**更新**，而非并列保留

**四种写操作**（LLM function calling 决定）：ADD（无等价新建）/ UPDATE（同主题补细节合并）/ DELETE（新信息矛盾旧 → 删旧的）/ NOOP（已存在或不值存）。

## 3. 关键坑（生产经验）

- **提取过度**：每句话都提取 → 库膨胀 → 检索精度下降 **15-20%**（Mem0 经验）。直接印证我们的 NOOP 保守策略正确。
- **向量库 ≠ 完整记忆系统**：只解决检索，还需要冲突检测、压缩、清理、访问控制。
- **多租户隔离**：百万用户记忆混一起 → 检索慢 / 信息泄露。我们 M3 全局不分项目，生产需 scope 隔离（未来）。

## 3.x Claude/Codex 补充的"值得记"维度（用户要求重点学习）

来源：《Claude Code 与 Codex Memory 机制详解》。在 Mem0 白名单之外，这两套生产方案额外强调：

- **失败教训 / 踩过的坑**：Codex 提取字段 `raw_memory` 明确含"失败教训"。高复用价值，避免重蹈覆辙。**应补入我们的 STORE 白名单**（Mem0 未单列）。
- **feedback（对 Agent 工作方式的纠正/认可）**：区别于一般偏好，是"这次做对/做错"的反馈。
- **reference（外部资源入口）**：工单/看板/文档链接，作为检索入口，而非事实本身。
- **why / how-to-apply 元信息**：不只记"是什么"，还记"为什么、何时适用"，防局部经验被无限推广。
- **会话成果摘要**：高信号的"做了什么/结果/证据"，便于追溯，非逐字转录。

> 结论：范式讨论的本质 = 到底哪些值得记。edgelore **坚持图谱路线**，仅借其提取思路校准 gate。详见 `docs/notes/agent-memory-paradigms.md`。

## 4. 对我们设计的影响（校准 gate 判据）

- gate 前加**廉价 Triage 启发式层**（regex 跳客套），再调 LLM 做精细判断。省钱、降噪。
- 我们的"门控 gate + 抽取 extract + capture（去重/冲突标 conflict）"完美对齐四阶段：
  - gate ≈ Triage（是否值存）+ Extract 的"是否结构化"
  - extract ≈ Extract/Distill（→ 结构化 fact）
  - capture（M3 已实现）≈ Dedupe/Resolve + Persist
- **capture 的"单值冲突标 conflict 不裁决"正是 2026 生产答案**（写时标新不删，读时/后台 reconcile）。我们领先于"同步删"旧做法。
- "瞬时状态"类信息（如今日状态）M3 暂不特殊处理，未来可加 TTL（时间敏感记忆过期清理）。
- 抽取输出可加 `confidence`（Mem0 用 confidence scale），MVP 先不加，保持简单。

## 5. 引用来源

- Mem0 官方博客：What should AI agent remember vs forget / Memory eviction and forgetting
- Mem0 论文：arXiv:2504.19413（LOCOMO benchmark，比全上下文快 91%、省 90% token）
- blog.jatinbansal.com：Memory Write Policies / Long-Term Memory（四阶段管线）
- CSDN 译文：上下文工程的演进（Letta/LangMem/Mem0 对比）
- 面试笔记：记忆四步法 + LOCOMA benchmark（Letta 74% / Mem0g 68.5% / OpenAI 54%）
