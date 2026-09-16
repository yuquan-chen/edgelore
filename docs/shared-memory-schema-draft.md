# 共享记忆图 · 数据类型定义（草案 v0.1）

> 配套《多 Agent 共享记忆：模型与关键决策 v0.1》。
> 本文把文档里的概念落成可评审的数据类型：节点（GraphNode）、边（GraphEdge）、超边/约束（Constraint）。
> 状态枚举沿用 D10。这份草案不是已确认 API，待评审。

## 0. 三族类型一览

整张图由三族对象组成：

1. **GraphNode（实体节点）** —— 图里记录"事实 / 实体"的东西（我、人、项目、说法、来源、维度）。
2. **GraphEdge（实体边）** —— 节点之间的普通两两关系（谁说的、关于谁、属于哪）。
3. **Constraint（超边 / 约束节点）** —— 横跨多个维度节点的 N 元关系，表达"这些事实必须一起满足什么"。

> **关键决定：** Constraint 在 schema 里保留为"N 元关系"——`participants` 是一个维度节点 id 的集合，不预先塌缩成二部图。
> 这样数据模型是"诚实的超边"：可视化时既可以画成超边包络（把参与者圈在一起），也可以渲染成"约束节点 + 辐条"，
> 二选一或并存，由前端决定，且不被存储形式锁死。

## 1. GraphNode（实体节点）

所有节点共用基础字段，用 `node_type` 区分。

基础字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `node:<type>:<uuid>` |
| `node_type` | enum | 见下表 |
| `created_at` / `updated_at` | ts | 时间戳 |
| `source_refs` | [id] | 引入它的消息 / 来源 |
| `scope` | {project_id?, phase_id?} | 适用边界（Q06） |
| `revision_id` | string | 版本（D04 分支） |

`node_type` 取值：

| node_type | 含义 | 典型属性 |
| --- | --- | --- |
| `actor` | 我 / 人 / 客户 | `name`, `role` |
| `project` | 项目 | `name` |
| `deliverable` | 交付物 / 阶段 | `name`, `project_id` |
| `message` | 被捕获的对话消息 | `text`, `ts` |
| `source` | 出处（指向 message 或文档） | `ref` |
| `statement` | 候选说法（某维度的一个候选值） | `value`, `dimension_id`, `acceptance_state` |
| `dimension` | 维度身份（如"项目 P 的设计费"） | `key`, `project_id`, `phase_id` |

> `statement.acceptance_state` ∈ {`unknown`, `accepted`, `conflict`}（D10）。
> 维度节点本身的"当前判断"由它 accepted 的 statement(s) 推导，不单独存。
> 维度身份唯一（同一 project+phase+key 只有一个 dimension），但其下可有多个来源不同的 statement（D02）。

## 2. GraphEdge（实体边）

普通两两关系，`edge_type` 区分。起点 / 终点均为 GraphNode。

| edge_type | 起点 → 终点 | 含义 |
| --- | --- | --- |
| `said_by` | statement → actor | 谁说的 |
| `about` | statement → (project \| deliverable \| dimension) | 关于什么 |
| `has_source` | statement → source | 出处 |
| `belongs_to` | dimension → (project \| deliverable) | 维度归属 |
| `branch` | node → node | 类 Git 分支 / 版本（D04） |
| `supersedes` | node → node | 被纠正 / 取代 |

## 3. Constraint（超边 / 约束节点）★ 新增核心

这是 v0.1 的关键类型，本身就是一条超边。

```
Constraint {
  id:               "constraint:<uuid>"
  revision_id:      "constraint-revision:<n>"
  kind:             "constraint"
  name:             "预算不超批准额"          // 可选，人工可读
  scope:            { project_id, phase_id }  // 何时适用（Q06）
  participants:     [ dimension_id, ... ]     // ★ 超边成员：N 个维度节点
  bindings:         { x1: dimension_id, x2: ..., x3: ... } // 参数名 → 参与者
  parameter_types:  { x1: "money:CNY", ... }  // 类型 / 单位
  expression:       AST { op, args }          // 公式（D09 白名单）
  source_refs:      [ message | statement id ]// 规则出处（谁提议）
  activation_state: "proposed" | "active" | "retired"  // D10
  created_by:       agent | actor id          // 提议者
  approved_by:      actor id | null           // ★ Q01 治理点：谁让其生效
  approved_at:      ts | null
  created_at, retired_at
}
```

- `participants` 就是超边本身——它把 N 个维度节点绑成一组。
- `bindings` 给每个参与者一个参数名；`expression` 用这些参数写公式。
- 同一组参与者可有多条不同规则（如 `x1+x2<=x3` 与 `x1*x2<=x3`），不合并（文档 3.2）。
- 在"约束节点 + 辐条"渲染下，`participants` 等价于一组 `participates_in` 边。

### expression AST（D09 白名单运算）

```
op   ∈ { add, sub, mul, div, eq, ne, lt, le, gt, ge, in, subset, and, or, not }
args ∈ [ AST | { ref: "x1" } | { lit: <带类型的值> } ]
```

## 4. 状态枚举（沿用 D10）

| 对象 | 状态 | 含义 |
| --- | --- | --- |
| 节点采信 | `unknown` / `accepted` / `conflict` | 系统目前如何使用该维度的信息 |
| 约束生效 | `proposed` / `active` / `retired` | 规则是否获准参与正式检查 |
| 单次检查 | `satisfied` / `violated` / `indeterminate` / `error` | 对指定输入快照的计算结果 |

> `indeterminate` = 信息不足 / 范围不明 / 未选定输入；`error` = 除零、类型不兼容等。
> 二者都不能偷偷当成"通过"，也不能都映射成"冲突"。

## 5. 最小实例化例子（预算规则）

节点：

- `dimension:P.design_cost`（设计费）
- `dimension:P.production_cost`（制作费）
- `dimension:P.approved_budget`（批准预算）
- `statement:s1` { value: 5000 CNY, dimension: design_cost, acceptance_state: accepted }
- `statement:s2` { value: 5000 CNY, dimension: production_cost, acceptance_state: accepted }
- `statement:s3` { value: 10000 CNY, dimension: approved_budget, acceptance_state: accepted }

约束（超边）：

- `constraint:c1` {
    participants: [design_cost, production_cost, approved_budget],
    bindings: { x1: design_cost, x2: production_cost, x3: approved_budget },
    expression: { op: le, args: [ { op: add, args: [ {ref:x1}, {ref:x2} ] }, {ref:x3} ] },
    activation_state: active,
    approved_by: actor:owner
  }

检查（一次性动作，非节点）：

- `Check` { snapshot: [s1, s2, s3], constraint: c1, result: satisfied }

## 6. 落地路线建议

1. **先定类型（本文）** —— 节点 / 边 / 超边三族 + 状态枚举。
2. **选存储（schema 与存储解耦）** ——
   - 属性图（Neo4j 等）：constraint 存为节点，participants 存为 `participates_in` 边；
   - 关系表：nodes / edges / constraints 三张表。
   - 因为 schema 保留 N 元 `participants`，两种都能映射，且超边可视化不被存储形式锁死。
3. **最小引擎** —— 只实现 D09 白名单运算 + 表达式求值 + 四类检查结果，跑通文档第 9 节 10 个验收场景。
4. **接 NLU gate** —— 原定位的 A/B 双路径产出 statement 候选 → 绑定维度快照 → 触发相关 constraint 检查 → 违规则进联合审议。
5. **治理（Q01）** —— constraint 的 `approved_by` 字段先把"谁能 active 一条规则"落进数据模型。
