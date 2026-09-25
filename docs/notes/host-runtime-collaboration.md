# EdgeLore 与宿主 Agent 的协作边界（Deferred Part）

> 状态：公共读写边界已开始落地；宿主 lifecycle hooks、异步摄入队列仍待实现。

## 定位

EdgeLore 的部署形态是 plugin / local sidecar，运行形态是内部可调用 LLM 的
Agentic Memory Runtime。它异步维护项目记忆，但不取代宿主 Agent 完成最终任务。

```text
Claude / Codex
  ├─ lifecycle hooks：自动 recall / capture
  ├─ MCP tools：主动 search / expand / resolve
  └─ 使用 EdgeLore 返回的 Memory Capsule 继续推理和执行

EdgeLore Runtime
  ├─ Episode source log
  ├─ gate → extract → capture → graph enrichment → embedding
  ├─ state / conflict / provenance
  └─ graph retrieval → evidence hydration → Memory Capsule
```

## 上下文注入原则

System/developer prompt 只放稳定的 EdgeLore 使用协议，以及经过治理、完全可信的
Project Kernel。动态检索出的用户消息、文档、工具输出和原文证据属于数据，不属于
指令；默认通过宿主的普通上下文或真实 tool result 注入，不能提升为高权限指令。

```text
SessionStart
  → 注入很小的 Project Kernel

UserPromptSubmit / pre-turn
  → 快速 recall
  → 注入本轮 Memory Capsule

Stop / turn-end
  → 立即追加 Episode
  → 后台启动语义摄入

PreCompact / SessionEnd
  → flush 尚未持久化的项目经历
```

自动注入是 Push 路径；`memory_search`、`memory_get_evidence`、
`memory_expand` 等工具是宿主按需使用的 Pull 路径。两者需要同时存在。

## 异步一致性

Episode 必须先快速、可靠地追加，再由后台队列完成抽取、图组织和 embedding。读取时
合并已完成的 Capability Graph 与尚未完成摄入的近期 Episode，保证 read-your-writes：
用户刚刚作出的决定即使仍在队列中，下一轮也可以被召回。

同一 project/scope 的写入应有稳定顺序和 ingestion watermark；后台失败不得丢失
Episode，也不能阻断宿主当前回合。

## 当前项目已经具备的基础

- `src/agent/runtime.ts` 已编排 gate、extract、capture、graph enrichment 和 embedding。
- `EpisodeRecord` 与 SQLite Episode 持久化已经存在。
- retrieval 已有向量、词法、图扩展、状态/冲突上下文和冷 Episode 证据恢复。
- MCP 已提供 remember、search、conflicts、resolve、autoresolve、capture、get、evaluate。
- `appendEpisode()` 已成为宿主可调用的不可变原文追加接口；`recall()` 返回结构化
  `MemoryCapsule`，MCP `memory_search` 复用这条完整召回链路。
- `Scope` 可显式指定 `owner_id`、`project_id`、`phase_id`。指定后召回按精确 scope
  隔离 Claims、关系扩展、约束和 Episode 证据；省略 scope 仍是单租户全库语义。
- LongMemEval v7 的 476/500（95.2%）记录证明
  `Claim + graph + Episode evidence` 能形成有效上下文。

因此核心语义模型和存储模型不需要为宿主集成重写。

## 尚未完成的宿主协作层

1. MCP `memory_remember` 目前同步等待完整 `processTurn`，还不是
   “append Episode immediately, process asynchronously”；`memory_append_episode` 目前只负责
   幂等、不可变地保存 Episode，不负责启动摄入。
2. MCP 写入可传 `sourceRef` 和显式 `Scope`，但还没有 Claude/Codex 的 thread/turn 身份映射。
3. MCP `memory_search` 已走 `recall()` → `retrievalContext`，返回结构化 Capsule 与
   v7 Episode evidence recovery；显式 owner/project/phase scope 为硬隔离。
4. 当前没有 SessionStart、UserPromptSubmit、PostToolUse、Stop、PreCompact、
   SessionEnd 等宿主 lifecycle adapters。
5. 当前没有持久队列、pending Episode overlay、watermark 和自动重试协议。
6. `MemoryCapsule` 基础契约已定义；trusted Project Kernel 与 untrusted retrieved evidence
   的宿主注入权限策略仍需在具体 adapter 中实现。

## 后续 Part 的最小目标

后续实现不改 Capability Graph 的核心模型，而是在现有 runtime 外增加：

```text
Host Adapter
  → appendEpisode(event)       // 快速、幂等
  → enqueueIngestion(eventId)  // 异步
  → recall(query, scope)       // graph + pending Episode
  → MemoryCapsule              // claims / relations / conflicts / evidence
```

第一阶段只需要一个宿主适配器和一个正式 `MemoryCapsule` 接口；Claude/Codex 的具体
Hook 配置、daemon 生命周期与安全注入策略在该 Part 内实现和验证。
