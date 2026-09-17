# Agent Memory 范式调研补充：Claude Code / Codex 轻量方案

> 来源：微信公众号《Claude Code 与 Codex Memory 机制详解》（haoran 独立开发，2026-09-07）。
> 补充到 `docs/notes/agent-memory-write-policy.md`。**重要：edgelore 坚持图数据库路线不变**；这篇文章的价值**仅在于它的提取思路——到底哪些东西值得记**。以下提炼其"值得记"的判据，供校准我们的门控 gate，不借其存储范式。

## 1. 核心范式

两套设计共同思路：**Markdown 组织记忆 + 渐进式披露（Progressive Disclosure）**。每次对话不把全部历史塞进上下文，而是先给索引/摘要，按需加载详细文件。

作者本人结论偏向轻量范式，但**对我们仅作"值得记什么"的参考**。渐进式披露（不全塞上下文、先索引后按需）的思想可借鉴；我们的存储与检索仍是图谱，不在此讨论范围内。

## 2. Codex 的做法（开源，学习价值高）

记忆根目录 `~/.codex/memories/`：
- `memory_summary.md`：高层摘要/偏好/导航，**自动进上下文**（裁到 ~2500 token）
- `MEMORY.md`：按任务组组织的知识+经验+来源，主 Agent 先搜索这里
- `rollout_summaries/*.md`：历史会话的任务/结果/证据摘要，需细节时打开
- `skills/*`：可复用操作流程
- `raw_memories.md`：Phase 1 提取结果合集
- `extensions/ad_hoc/notes/*`：用户明确要求的内存增删改（临时笔记）

**两阶段写入**：
- Phase 1 提取：考虑最近 10 天更新 + 空闲 6h 的历史会话，无工具结构化提取，返回 `{raw_memory, rollout_summary, rollout_slug}`，进 SQLite 的 `stage1_outputs`。
- Phase 2 整合：从 SQLite 读 Phase 1 产物 → 存文件 → 用 Git 记录算 diff（新增/更新/来源消失）→ 交给内部 Agent 更新 `MEMORY.md`/`memory_summary.md`，必要时整理成 skill。**不重读原始会话全文**，只处理 Phase 1 产物。默认冷却 6h。

**读取**：渐进式披露 + **Agentic Search**。检索预算约 4–6 步，通常只开 1–2 文件，没命中就停；简单任务（翻译/改一行）可跳过记忆。

**引用与遗忘**：模型引用记忆后生成 `<oai-mem-citation>`（文件:行号 + 用途 + rollout_ids），程序读取后更新 SQLite 的 `usage_count`。保留逻辑：保留最近 30 天被引用的来源；引用多者优先；长期不引用则过期。**这是轻量版"记忆衰减"**（对应 Mem0 的 Memory Decay，但更简单、无需向量）。

## 3. Claude Code 的做法

- `CLAUDE.md` / `rules`：人维护的明确指令，分层（组织/用户/项目/子目录），`rules` 可带 `paths` 限定只在匹配文件时加载。
- `auto-memory`（狭义 agent memory）：`~/.claude/projects/<项目>/memory/` 下 `MEMORY.md`（索引）+ 单独事实文件。
- **记忆四类**：`user`（身份/经验/偏好）、`project`（目标/背景约束）、`feedback`（对 Agent 的纠正/认可）、`reference`（外部资源入口）。
- **事实文件格式**（带 why / how-to-apply）：
  ```
  ---
  name: integration-tests-use-real-db
  description: 数据库集成测试使用真实数据库
  metadata: {type: feedback}
  ---
  数据库集成测试应连接真实数据库。
  Why：曾出现 mock 测试通过，但真实数据库迁移失败。
  How to apply：涉及数据库行为时，使用真实实例验证。
  ```
  **记"为什么"和"何时适用"**——避免局部经验被无限推广。极有价值。
- **写入**：主 Agent 自己能写（Write/Edit + 维护索引）；另有回合结束后台提取（stopHooks → fork Agent）。
- **读取**：渐进式披露，先 `MEMORY.md` 索引 → 判断相关 → Read 正文。带新鲜度提示（文件修改时间），提醒可能过时。
- **Dream**（后台整理）：合并重复、修正矛盾、相对日期变明确日期、精简索引。类似 Codex Phase 2。

## 4. 对我们 edgelore 的启示

- **渐进式披露思想可借鉴（存储不变）**：图大不能全塞上下文，应先用索引/摘要（`knownDimensions` / `queryNodes`）再按需拉节点。但**edgelore 的存储与检索仍基于图谱**，取层具体实现后续再定，本文不决定，也不动摇图谱路线。
- **模型理解 + 程序写格式** ≒ 我们的**字段三分法**：Agent 操作内容字段（dimensionKey/value），系统生成机制字段（状态/冲突/索引）。与文章"模型负责理解，程序/工具负责把文件和索引写对"英雄所见略同。
- **记忆类型四分法**（user/project/feedback/reference）：可映射到我们的 dimension 分类，或作为 dimension 的"类型标签"。尤其 **feedback 带 why/how-to-apply** 的思路——未来 `statement` 可加 optional 元字段（为何/何时适用），避免误推广。
- **引用计数 + 衰减**：比 TTL 更优雅的遗忘机制。我们未来做"忘/淘汰"（M3 暂留，原排期归未来）时可参考 `usage_count` + `last_usage`，而非简单过期。
- **Dream / Phase 2 整理 = 冲突裁决的参考实现**：合并重复、修正矛盾。我们的 capture 当前"标 conflict 不裁决"，未来裁决可借鉴这个**后台整理 Agent** 模式（不在同步写路径删，后台调和）。
- **护城河与路线不变**：edgelore **坚持图数据库**，不切换 Markdown 方案。Claude/Codex 用 Markdown 无约束自检；Mem0/Zep 用向量无声明式约束。我们**图谱 + 约束引擎（M1 四态）**仍是独特差异点。本文**仅借其"值得记"的提取思路**，不借其存储/检索范式。

## 4.x 文章对"值得记什么"的独特补充（相对 Mem0 白名单）

除 Mem0 已覆盖的稳定身份 / 持久偏好 / 目标 / 决策 / 约束外，本文额外强调这些**值得记**的维度——这正是用户要我们"学习"的核心（范式讨论的本质 = 到底哪些值得记）：

- **失败教训 / 踩过的坑**（Codex `raw_memory` 明确含"失败教训"）：高复用价值，避免重蹈覆辙。Mem0 白名单未单列，应补入我们的 STORE 白名单。
- **feedback（对 Agent 工作方式的纠正/认可）**：区别于一般"偏好"，是"这次你做对/做错了"的反馈，常带 why。
- **reference（外部资源入口）**：工单 / 看板 / 文档链接，作为后续检索入口，而非事实本身。
- **why / how-to-apply 元信息**：不只记"是什么"，还记"为什么"和"何时适用"，防止局部经验被无限推广（feedback 类型最典型）。
- **会话成果摘要（做了什么 / 结果 / 证据）**：高信号的"这次干了啥、成了没、证据在哪"，便于追溯，而非逐字转录。

> 已回流进 `docs/notes/agent-memory-write-policy.md` 的判据表（§"Claude/Codex 补充的'值得记'维度"）。

## 5. 对设计文档的影响（待用户/接手 AI 决策）

- **存储与检索坚持图谱路线不变**；取层具体实现（向量 / 遍历 / Agentic Search）后续再定，本文不决定。
- 未来 `statement` 可加 optional 元字段 `why` / `applicable_when`（借鉴 feedback 类型），增强记忆可用性——属于"值得记什么"的细化，非路线变更。
- 遗忘/淘汰策略：优先用 `usage_count`/`last_usage` 衰减，而非 TTL。

## 6. 引用

- 微信公众号《Claude Code 与 Codex Memory 机制详解》（haoran，2026-09-07）
- 文中提到的 dsh-memory 插件（DeepSeek Harness，Markdown + Agentic Search，LoCoMo-10 eval）：https://github.com/hr98w/dsh-memory
