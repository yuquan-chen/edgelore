# edgelore — AI 接手交接文档

> 写给下一个接手本项目的 AI。这份文档自包含，读完即可继续干活，不必翻聊天记录。
> 最后更新：2026-09-17（北京时间）。

## 0. 一句话目标

edgelore 是一个 **AI agent 的共享记忆图**项目。最终目标是做成 **Memory Agent**——系统能**自动从对话里长出记忆**（自己判断要不要存、自动落库），**而不是手喂库**。

当前进度：M0–M3 已完成"存储层"（能正确、不丢、不重复、能冲突标记地把一段结构化记忆存进库）。下一步做 **Agent Memory 层**（抽取端：把人话转成结构化记忆 JSON）。

## 1. 核心架构概念（必读，否则会跑偏）

- **三族图模型**：`GraphNode` / `GraphEdge` / `Constraint`（节点、边、约束）。节点分 `core:dimension`（问题槽位，如"作者是谁"）和 `core:statement`（答案，如"charles"），二者都 `extends BaseNode`，**地位平等**，不是分级。
- **open-world 类型**：维度/事实的类型不预定义死，按需新建。
- **约束表达式引擎（M1，护城河）**：白名单 AST 求值器，四态：`satisfied` / `violated` / `indeterminate`（缺数据）/ `error`（畸形）。**这是我们的差异化王牌**——竞品只做"存事实+检索"，无声明式约束自检。
- **capture 存储原语（M3）**：`capture(graph, content, ctx)` 把结构化 JSON 落库。
- **字段三分法（关键约定，必须遵守）**：
  - `provenance`（created_by / source_refs / created_at）= 系统读取/注入，**不传参、Agent 绝不手填**
  - 内容字段（dimensionKey / value / cardinality / unit）= Agent 操作
  - 机制字段（状态机状态、冲突标记）= 系统生成
- **状态机**：`tentative` / `accepted` / `conflict` 三态可互转（见 `src/model/state-machine.ts`）。

## 2. 里程碑进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 形状 scaffold | ✅ push |
| M1 | 约束表达式引擎（四态） | ✅ push |
| M2 | SQLite 持久化 + CLI 桥 | ✅ push |
| M3 | capture 存储原语（结构化 JSON → 落库） | ✅ push |
| **M4** | **MCP server（生态硬门槛，行业标配）** | ⬜ 未做 |
| 未来 | 触发机制 / 取(RAG 语义召回) / 冲突裁决 / 可视化 / 时间维(valid_from/valid_to) | ⬜ 未做 |

主线：M0 形状 → M1 自检 → M2 存得住 → M3 自己长(capture) → M4 MCP → 未来(Agent Memory 抽取端 / 取 / 裁决)。

## 3. 当前阶段：Agent Memory 层设计（已 frozen）

设计文档：**`docs/agent-memory-design.md`**（status: **frozen**）。
**边界已锁定，不要重开会吵的议题**，直接按它实现即可。

### 3.1 整条链路三段（Agent Memory 层定位中间）

1. **触发层（未来，本层不碰）**：决定"这句话要不要进记忆系统"。
2. **Agent Memory 层（本次要做）**：拿已确定要处理的人话 → 输出结构化 capture 候选。
3. **存储层（M3 已实现）**：capture 落库。

### 3.2 用户已确认的 5 项决策（frozen，勿改）

1. **Prompt 拆两道**：门控 `gate`（判值不值得存）+ 抽取 `extract`（映射到维度）。
2. **新建维度直接 accepted**（不进 tentative）。
3. **允许多事实**：输出 `contents: CaptureContent[]` 数组。
4. **contextMemories 要喂**：先用 `queryNodes` 简单查，未来换向量检索。
5. **LLM 先写 MockDriver**：接口定死，模型可换。

### 3.3 frozen 的关键边界

- Agent Memory 层**只产 `CaptureContent`（数组）**，**不产 provenance**（CaptureContext 系统注入）。
- **不直接调 capture**，由上层 runtime 编排（这样测试可独立，不依赖数据库）。
- 触发机制归未来，本层不碰。

## 4. "值得存"判据（已调研，直接照办）

调研笔记：**`docs/notes/agent-memory-write-policy.md`**

- **行业四阶段管线共识**（Mem0/LangMem/Letta/A-MEM）：`Triage`(启发式跳客套,不调LLM) → `Extract/Distill`(→结构化fact) → `Dedupe/Resolve`(写时标新不删,旧打back-ref,读时/后台reconcile) → `Persist/Index`(分层hot/warm/cold)。
- **Mem0 官方白名单**：
  - 值得存：稳定身份 / 持久偏好 / 目标项目 / 过去决策 / 表达的约束（预算/SLA/合规）
  - 不值存：客套话 / 瞬时状态（"我今天累"）/ 被新信息推翻的旧记忆 / 已存在的等价记忆
- **四种写操作**：ADD / UPDATE / DELETE / NOOP（LLM function calling 决定）。
- **坑**：提取过度 → 检索精度降 15–20%（印证我们 NOOP 保守策略正确）。向量库 ≠ 完整记忆系统。
- **实现增强建议**：gate 前加一层**廉价正则 Triage**（跳"你好/谢谢/好的"），省 LLM 调用、降噪。
- **另见范式笔记** `docs/notes/agent-memory-paradigms.md`：Claude Code / Codex 的提取思路（**重点学"哪些值得记"：失败教训 / feedback / reference / why**，edgelore **坚持图谱路线不变**，文章仅作提取思路参考，不借其 Markdown 存储范式）。

## 5. 下一步具体任务（任务 #17）

按 `docs/agent-memory-design.md` §7 实现 Agent Memory 层：

- `src/agent/gate.ts`：门控（值不值得存）
- `src/agent/extract.ts`：抽取（→ `CaptureContent[]`）
- `src/agent/prompt.ts`：两套可扩展 prompt 模板（基础片段 + 场景片段，可插拔）
- `src/agent/llm-driver.ts`：`LlmDriver` 接口 + `MockDriver`（默认，返回预设 JSON，使测试不花钱）
- `src/agent/index.ts`：导出 capture + gate + extract + 编排函数
- `test/agent/gate.test.ts`、`test/agent/extract.test.ts`
- 参考现有 `test/capture.test.ts`、`test/sqlite.test.ts` 的写法（项目用 **vitest**）。
- **不要动 `src/agent/capture.ts`**（存储层已完成并测试通过）。

实现前务必先 `npm run build && npm test` 确认 M3 全绿（当前 46 个测试），再动手。

## 6. 文件地图（关键）

| 文件 | 作用 |
|---|---|
| `src/model/types.ts` | BaseNode(含 cardinality) / DimensionNode / StatementNode / 状态枚举 |
| `src/model/store.ts` | MemoryGraph + GraphStore 接口 + addNode/getNode/queryNodes/transitionNodeState |
| `src/model/state-machine.ts` | 状态转移规则 |
| `src/agent/capture.ts` | capture(graph, content, ctx) + CaptureContent/CaptureContext/CaptureResult |
| `src/store/sqlite.ts` | SqliteGraph（node:sqlite，零依赖） |
| `src/cli.ts` | edgelore CLI（含 capture 子命令，JSON 进出） |
| `docs/shared-memory-m3-spec.md` | M3 定稿 spec |
| `docs/competitor-analysis.md` | 竞品分析（未提交） |
| `docs/agent-memory-design.md` | Agent Memory 层设计（未提交，frozen） |
| `docs/notes/*.md` | 各里程碑技术 Note + 写入策略调研（部分未提交） |

## 7. git 状态

- `main` 与 `origin/main` **同步**（无 ahead/behind）。
- 已 push：M0–M3 全部（最近一笔 `4e6918e docs(M3)`）。
- **未提交**（3 个文档，untracked，等用户授权）：
  - `docs/agent-memory-design.md`
  - `docs/competitor-analysis.md`
  - `docs/notes/agent-memory-write-policy.md`
- 作者配置：`user.email=yuquan-chen@users.noreply.github.com`，`user.name="charles chen"`（**禁止用 dogpay**）。

## 8. 协作硬规矩（用户明确要求，务必遵守）

1. **绝不擅自 commit / push**。涉及提交、推送、建库、force push 等外部副作用，必须先问用户，用户点头才做。
2. **先对齐、再写码**：每个模块先给 mini-spec / 方案过目，拍板后再实现。不要跳过"设计对齐"直接产出大量实现文件。
3. **用大白话，别说黑话**：用户反感术语堆砌（曾怒斥"你这些排版的小问题全都不是人话"）。解释概念用通俗语言。
4. **不要过度设计**：MCP 那次教训——用户要 CLI 桥，不要自作主张加 MCP。
5. 提交信息用 **Conventional Commits**（feat/fix/docs 等），注释/版权人用 charles chen。
6. 项目采用"模块化 + 逐步验证"节奏：mini-spec → 确认 → 实现 → 跑验收，不预先写全量需求文档。

## 9. 用户原始初衷（反复强调，是验收标准）

"做成 **Memory Agent**，而不是手喂库"。系统应该**自动长记忆**——Agent 自判、自加节点、直接 accepted、仅冲突升级。不要做成"每句话都手动喂 JSON"的玩具。当前 Agent Memory 层（#17）就是朝"自动长"补的第一块拼图（抽取端），做完后能吃人话、吐 JSON，再由 capture 落库。

---

**给接手 AI 的第一句建议**：先 `cd ~/Desktop/edgelore && npm run build && npm test` 看现状，然后读 `docs/agent-memory-design.md` 和 `src/agent/capture.ts`，再按 §5 实现 #17。别一上来就 commit。
