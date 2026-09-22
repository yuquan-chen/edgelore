# M0 · 数据模型与状态机（mini-spec v0.1）

> 配套：《多 Agent 共享记忆：模型与关键决策 v0.1》+ `shared-memory-schema-draft.md`
> 范围：只定 M0（数据模型与状态机）。约束求值（M1）、检查三分离（M2）等不在本文件落地。
> 状态：可评审草稿。本文件是 M0 小循环的第①步（mini-spec），跑完 M1 后再回头汇成总规格。

---

## 0. 定位：开源的多 agent 共享记忆协议与存储

用户明确两点：
1. 这个记忆图不只是给人用，还要能作为 **codex / claude code / openclaw 等 AI coding agent 的共享记忆后端**。
2. **本项目计划开源**——它不是一个内部工具，而是一份社区可共建、可自托管的"记忆协议 + 参考实现"。

开源把定位从"自己用的后端"升级为"社区共建的标准 / 协议"。但先划清一条关键边界：

> **开源 ≠ 把你的数据库开放给外人写。** 开源只是把代码发出去，别人 `git clone` 后部署的是**他们自己的实例、连他们自己的数据库**，与你物理隔离。你自己的库、自己的代码，永远不会被别人的部署碰到——所以"别人伪造身份污染我的记忆"在跨实例层面根本不成立。

真正决定"要不要做身份校验"的，不是开不开源，而是**部署拓扑 / 信任边界**：
- **默认形态（你描述的）**：你自己跑一份，你的 codex / claude code / openclaw 连你这一份——单租户、全可信。此时 `created_by` 自报即可，价值是**审计 / debug**，不是防伪造。
- **多租户 / 联邦形态**（以后给别人共用、或跨实例写）：那时才需要可验证身份。

所以开源带来的根本变化只有两个——注意**身份防伪造不在其中**（它只跟部署拓扑相关）：
- **扩展治理去中心化**：类型扩展不能靠中心审批，要靠命名空间约定 + 稳定核心，让社区自由生长而不碎片化。
- **分发即契约**：代码公开后，`schema.json` / `types.ts` 必须成为跨实例、跨 agent 的开放契约（严格版本化）。

这直接决定下面三条硬约束的设计（其中 provenance 的"校验"部分按部署拓扑做成可插拔、默认关，见 §1.2）。

---

## 1. 三条硬设计约束（拓展性全部来自这里）

### 1.1 Open-world typing（开放类型，不写死枚举）
- `node_type` / `edge_type` / `constraint.kind` **不是封闭 enum**，而是带命名空间的字符串。
- 核心类型用 `core:` 前缀（`core:actor`、`core:dimension`、`core:constraint` …）。
- 各 agent 可注册自己的命名空间（`codex:`、`claude:`、`openclaw:` …），新增类型不会和他人冲突，也不用改核心 schema。
- 好处：codex 加一个 `codex:task` 节点，claude code 加一个 `claude:decision` 节点，彼此互不破坏。
- **开源治理**：`core:` 命名空间由项目维护者控制（语义稳定、明确）；第三方扩展用反向域名或自身 agent 名作 scope（如 `com.acme:invoice`、`codex:task`），**不要求中心审批**——开源社区不接受写入需经上游批准。核心只保证 `core:` 语义稳定，其余靠约定共存。

### 1.2 Provenance 是一等公民（审计与追溯的基石，校验可插拔、默认关）
- 每条对象（节点 / 边 / 约束）都带 `created_by`、`created_at`、`schema_version`、`source_refs`。
- 多 agent 往同一份图写，来源归属不清就等于埋雷——所以**署名从"可选"升为"强制"**：谁写的必须留痕，用于事后审计与 debug（"这条记忆是谁、何时、凭什么写的"）。
- `created_by` 取值：`agent:<name>:<id>` 或 `human:<id>`。
- **身份"校验"是可插拔、默认关的 auth 层，不是 M0 硬要求。** 默认（单租户自托管）下，`created_by` 由写入方自报即可——你的机器、你的 agent，本就互信，校验纯属多余。只有当部署升级为**多租户 / 联邦**（见 §0）时，才需要开启实例级身份校验（API key → OIDC → 对象签名，由轻到重）。M0 把"记录"做成强制、"校验"做成可选，不强迫每个自托管者去架 OIDC，契合 SQLite 零配置上手。

### 1.3 状态闭环 + 元数据扩展（不在 M0 堆状态）★ 开源友好的关键
- **状态是少量、精确的核心语义闭环**（见 §3）。业务细节、临时标记、agent 私有注解，一律放进 `attributes: object` 和 `tags: string[]`，不新增状态位。
- 这条对开源尤其重要：社区一定会想加自己的标记（"高优先级""和某 bug 相关""草稿"……）。如果每次都往 `state` 加，状态会爆炸，且不同分支互不兼容、生态碎片化。**解法：稳定核心语义留在 `state`（5 个），五花八门的私有标记放进开放 `attributes` / `tags`**——核心稳、扩展自由、不影响他人。
- 这是开源项目的经典套路：**窄状态 + 宽元数据**。类比 git（commit 状态就几种，但你能随便打 tag、加 metadata）、HTTP（状态码有限，header 无限）。
- 这样状态机保持小而稳，拓展性交给开放元数据，不会被"再加一个状态"慢慢腐蚀。

---

## 2. 三族类型（在 schema 草案基础上演化）

### 2.1 GraphNode（实体节点）

基础字段（所有节点共用）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `node:<type>:<uuid>`（全局唯一） |
| `type` | namespaced string | `core:actor` / `core:dimension` / `codex:task` …（open-world，§1.1） |
| `created_by` | string | `agent:claude:<id>` / `human:<id>`（§1.2） |
| `created_at` / `updated_at` | ts | 时间戳 |
| `schema_version` | string | 本对象遵循的 schema 版本 |
| `source_refs` | [id] | 引入它的消息 / 来源 |
| `scope` | {project_id?, phase_id?} | 适用边界（Q06） |
| `state` | enum | 见 §3（事实节点采信状态） |
| `attributes` | object | 开放元数据（扩展点） |
| `tags` | string[] | 开放标签（扩展点） |

`core:` 节点类型建议起步集（可扩展）：

| type | 含义 | 典型 attributes |
| --- | --- | --- |
| `core:actor` | 我 / 人 / 客户 | `name`, `role` |
| `core:project` | 项目 | `name` |
| `core:deliverable` | 交付物 / 阶段 | `name`, `project_id` |
| `core:message` | 被捕获的对话消息 | `text`, `ts` |
| `core:source` | 出处 | `ref` |
| `core:statement` | 某维度的一个候选值 | `value`, `dimension_id` |
| `core:dimension` | 维度身份（如"项目 P 的设计费"） | `key`, `project_id`, `phase_id` |
| `core:relation` | 有状态、可追溯的 N 元关系声明 | `predicate`, `bindings` |

> 维度身份唯一（同 project+phase+key 只有一个 dimension）；其下可有多个来源不同的 `core:statement`（D02）。

### 2.2 GraphEdge（实体边）

| edge_type | 起点 → 终点 | 含义 |
| --- | --- | --- |
| `core:said_by` | statement → actor | 谁说的 |
| `core:about` | statement → (project \| deliverable \| dimension) | 关于什么 |
| `core:has_source` | statement → source | 出处 |
| `core:belongs_to` | dimension → (project \| deliverable) | 维度归属 |
| `core:branch` | node → node | 类 Git 分支 / 版本（D04） |
| `core:equivalent_to` | statement → statement | 语义等价 / 重复事实（保留各自 provenance） |
| `core:refines` | statement → statement | 为已有事实补充兼容细节 |
| `core:contradicts` | statement → statement | 两条事实在同一语境下不能同时成立 |
| `core:supersedes` | node → node | 被纠正 / 取代 |
| `core:supports` | statement → relation | Statement 为关系声明提供证据 |
| `core:participates_in` | dimension → constraint | 超边成员（与 `constraint.participants` 互为索引） |

边的基础字段同样含 `created_by` / `created_at` / `schema_version`。

### 2.3 RelationAssertion（有状态的关系超边）

语义关系不能只是一条裸边。裸边没有独立状态，无法表达“助手提出、用户确认、出现冲突、后来被取代”，也无法让一条关系参与另一条关系。因此结构关系被具体化为 `core:relation` 节点：

```text
RelationAssertion {
  type:       "core:relation"
  predicate:  "core:part_of"             // open-world namespaced type
  bindings:   { part: node_id,
                whole: node_id }          // open role -> participant
  state:      accepted | tentative | conflict | superseded | rejected
  provenance: ...
}
```

`bindings` 的角色名是开放的，不预先声明业务属性。二元关系、多元关系以及“关系之间的关系”使用同一个结构；因为 RelationAssertion 自己也是节点，它可以成为另一条 RelationAssertion 的参与者。

例如“这辆车的内饰”允许多重归属，而不是被迫放进一棵树：

```text
core:part_of
  { part: 当前车辆的内饰, whole: 当前车辆 }

core:instance_of
  { instance: 当前车辆的内饰, class: 装饰 }

core:dimension_of
  { dimension: carInteriorProtectionTips, subject: 当前车辆的内饰 }
```

每条关系至少由一个 Statement 通过 `core:supports` 提供证据。关系状态由支持它的 Statement 的信任状态导出：只有 tentative 支持时关系保持 tentative；出现 accepted 支持后才可转为 accepted。这样实体结构不会绕开 Statement 的 provenance 和信任边界。

GraphEdge 仍然保留，用于 `core:about`、`core:supports` 等索引/证据连接；需要独立判断真假的领域语义使用 RelationAssertion。

### 2.4 Constraint（规则超边 / 约束节点）★ 核心

```
Constraint {
  id:               "constraint:<uuid>"
  kind:             "core:constraint"          // open-world
  revision_id:      "constraint-revision:<n>"
  name:             "预算不超批准额"            // 人工可读，可选
  scope:            { project_id, phase_id }    // 何时适用（Q06）
  participants:     [ dimension_id, ... ]       // ★ N 元：超边成员
  bindings:         { x1: dimension_id, ... }   // 参数名 → 参与者
  parameter_types:  { x1: "money:CNY", ... }    // 类型 / 单位
  expression:       AST { op, args }            // 公式（D09 白名单，M1 实现）
  source_refs:      [ message | statement id ]
  activation_state: "proposed" | "active" | "retired"  // §3 约束状态
  created_by:       agent | human id            // §1.2 提议者
  approved_by:      human id | null             // ★ Q01 治理点
  approved_at:      ts | null
  created_at, retired_at
  attributes, tags                                // 扩展点
}
```

> `participants` 是诚实超边：可视化既可画成包络，也可渲染成"约束节点 + 辐条"（`core:participates_in` 边），不被存储锁死。

---

## 3. 节点状态要定义多少？（直接回答）

**原则：不在 M0 堆状态。** 状态是"共识语义"的最小闭环，不是"所有业务细节"。细节放 `attributes` / `tags`（§1.3）。

### 3.1 事实节点采信状态（推荐最小完备集 5 个）

| 状态 | 含义 | 谁触发 |
| --- | --- | --- |
| `tentative` | 暂存 / 未确认（**默认初始态**） | 任意 agent / 人刚写入 |
| `accepted` | 已确认，可无保留使用 | 人工或共识确认 |
| `conflict` | 存在互不相容的说法，待裁决 | 检测到 ≥2 个冲突 statement |
| `superseded` | 被新版本取代（保留历史，不再作当前事实） | 新 statement 经 `core:supersedes` 取代它 |
| `rejected` | 被明确判为假 / 错 | 人工或编排 agent 否决 |

**对比原文档的 `unknown / accepted / conflict`：**
- `unknown` ≈ `tentative`（只是改名更直白）。
- 多出 `superseded` 和 `rejected`——这是多 agent 长期记忆场景的刚需：一个 agent 写了旧值，另一个写了新值，旧值必须标 `superseded` 而不是删（保留审计链）；被判假的值标 `rejected` 而非默默消失。原 D07 的"保留历史"由此落地。

> **已定：保留 5 个。** `rejected`（明确判假）与 `superseded`（被新版本取代）语义不同、对 agent 决策与审计链都有用，不合并。

### 3.2 约束节点生效状态（保持文档 3 个 + 可选 1 个）

| 状态 | 含义 |
| --- | --- |
| `proposed` | 草案，未获准 |
| `active` | 获准参与正式检查 |
| `retired` | 已废止 |
| `deprecated`（可选） | 标记过时但暂不强制退役 |

### 3.3 单次检查状态（M1 实现，M0 预留接口）

`satisfied` / `violated` / `indeterminate` / `error`。
`indeterminate`（信息不足）/ `error`（除零、类型不兼容）都**不能**偷偷当"通过"，也**不能**都映射成"冲突"。

### 3.4 状态 vs 类型解耦
- **类型**决定"这是什么"（open-world，可无限扩展）。
- **状态**决定"它现在算不算数"（closed 小闭环，精确稳定）。
- 两者正交：一个 `core:dimension` 可以是 `accepted` 也可以是 `conflict`；一个 `core:constraint` 可以是 `proposed` 或 `active`。

---

## 4. Provenance 模型（多 agent 协作的命脉）

```
created_by: "agent:claude:<id>" | "agent:codex:<id>" | "human:<id>"
created_at: <iso8601>
schema_version: "m0.1"
source_refs: [ "node:core:message:<uuid>" ]
```

- 各 agent 写入**必须署名**。
- 多 agent 写同一维度 → 产生多个 `core:statement`，各自带 `created_by`；冲突由 `state: conflict` 标记，由 human-in-the-loop 或编排 agent 裁决，**绝不自动覆盖**。
- 这条直接服务你的目标：codex 和 claude code 同时往图里写，事后能追溯"这条记忆是谁、何时、凭什么写的"。

---

## 5. 互操作 API 设想（让各 agent 能直接挂载）

**主接口：MCP server（强烈建议）。**
claude code / codex / openclaw 这类 agent 都支持 MCP 工具挂载。把记忆图暴露成一组 MCP tools，各 agent 把它当"共享记忆工具"接上即可：

- `memory_read(node_id)` / `memory_query(filter)`
- `memory_write(type, attributes, source_refs)` → 返回带 `created_by` 的节点
- `statement_add(dimension_id, value, source_refs)`
- `constraint_add(...)` / `constraint_approve(id, human_id)`（Q01 闸门）
- `constraint_evaluate(...)`（M1 实现）

**次级接口：REST + JSON**（给非 MCP 环境 / 脚本 / 调试 UI 用）。

**交付物（M0 必出）：**
- `schema.json` —— JSON Schema，机器可读、各 agent 可本地校验。
- `types.ts` —— TypeScript 类型定义，agent 生成代码时直接 import。

> ID 一律全局 UUID，跨 agent 可引用；不强依赖某个图数据库（属性图 / 关系表都能映射，见 schema 草案 §6）。

---

## 6. JSON 实例（多 agent 写入示例）

```json
{
  "nodes": [
    {
      "id": "node:core:dimension:9f1a",
      "type": "core:dimension",
      "key": "design_cost", "project_id": "P1",
      "state": "tentative",
      "created_by": "agent:claude:abc", "created_at": "2026-09-16T10:00:00Z",
      "schema_version": "m0.1"
    },
    {
      "id": "node:core:statement:a2b3",
      "type": "core:statement",
      "dimension_id": "node:core:dimension:9f1a", "value": 5000, "unit": "CNY",
      "state": "accepted",
      "created_by": "human:owner", "created_at": "2026-09-16T10:05:00Z",
      "schema_version": "m0.1"
    },
    {
      "id": "node:core:statement:c4d5",
      "type": "core:statement",
      "dimension_id": "node:core:dimension:9f1a", "value": 8000, "unit": "CNY",
      "state": "conflict",
      "created_by": "agent:codex:xyz", "created_at": "2026-09-16T11:00:00Z",
      "schema_version": "m0.1"
    }
  ],
  "constraints": [
    {
      "id": "constraint:e7f8", "kind": "core:constraint",
      "participants": ["node:core:dimension:9f1a", "..."],
      "bindings": {"x1": "node:core:dimension:9f1a", "x3": "..."},
      "expression": {"op": "le", "args": [{"op":"add","args":[{"ref":"x1"},{"ref":"x2"}]}, {"ref":"x3"}]},
      "activation_state": "active",
      "created_by": "agent:claude:abc", "approved_by": "human:owner",
      "approved_at": "2026-09-16T09:00:00Z",
      "schema_version": "m0.1"
    }
  ]
}
```

> 注意：同维度下 `claude` 写了 5000（accepted），`codex` 写了 8000（conflict）——两条都留着，署名清晰，等裁决。

---

## 开源特有考量（本定位新增）

1. **部署 / 自托管故事**：存储后端可插拔——默认提供 SQLite / 文件后端（零配置上手），生产可换图数据库（Neo4j 等）。降低社区试用门槛。
2. **Schema 作为开放契约**：`schema.json` + `types.ts` 是跨 agent、跨部署的"协议契约"，必须严格版本化（`schema_version`）、向前兼容。破坏性变更走 deprecation 周期。
3. **许可协议（已定：MIT）**：用户最终选 MIT——极简宽松许可，允许商用、修改、再分发，只需保留版权与许可声明。属 OSI 认证开源，与项目"公开分发、社区共建"定位一致。注意 MIT **无明示专利授权**（若日后有外部贡献者且顾虑专利，可升级为 Apache-2.0）。单独 LICENSE 文件 + 仓库顶部声明。项目层决策，不阻塞 M0 数据模型。
4. **安全基线（始终必需，与部署拓扑无关）**：expression 白名单（D09）、约束求值沙箱、输入校验——这些是底线而非优化项。注意它的防护对象是**坏输入**，不是"恶意外人"：哪怕单租户全可信，你自己的 agent 也可能被 prompt injection 骗去写一条炸库的表达式。**provenance 身份校验（§1.2）不在此列**——它只在多租户 / 联邦部署时才需开启，默认关。
5. **扩展文档化**：社区新增 `core:` 以外的类型，项目应提供"如何注册 / 文档化你的命名空间类型"的指南，而非代码强制。

## 7. 待确认 / 开放问题

1. 状态集：~~保留 `rejected` 还是并入 `superseded`？~~ **已定：保留 5 个（含 `rejected`）**。
2. 命名空间注册：各 agent 的 `codex:` / `claude:` 前缀要不要一个轻量注册表防撞名？
3. API 优先级：MCP 优先是否 OK？还是你的 agent 生态更偏 REST？
4. 冲突合并：多 agent 写同一事实，除了"标记 conflict 等裁"，要不要允许"高置信 agent 自动 supersede 低置信"这类策略？（建议默认不自动，守 D03）
5. `schema_version` 演进策略：破坏性变更如何兼容旧 agent 写入的对象？

---

## 8. 实现语言（已定：TypeScript / Node.js）

用户采纳推荐：**TypeScript + Node.js** 作为 M0 参考实现语言。理由：
- 本项目 schema 优先、强类型，`node_type` / `edge_type` / `constraint` 结构用 TS 类型直接映射，且 M0 必交付 `types.ts` 给各 agent import 校验。
- MCP SDK（`@modelcontextprotocol/sdk`）一等支持，记忆图暴露为 MCP tools 最顺；claude code / openclaw 等 agent 生态偏 TS。
- 可视化层（V，超边渲染）可用同一语言一把梭，避免跨语言。
- 存储默认 SQLite（`better-sqlite3` 零配置），生产可换图库——存储后端可插拔（见开源特有考量）。

参考运行时：Node.js 22 LTS。核心保持轻依赖，避免把社区实现锁死在重型框架上。

## 9. 下一步（冻结 M0 后接 M1）

M0 冻结 → 交付 `schema.json` + `types.ts`（TypeScript）→ M1 实现 expression AST 求值 + 四类检查结果 → 并联 V 可视化把超边画出来 → 跑核心验收场景。
