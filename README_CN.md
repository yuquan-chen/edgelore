# edgelore

> 给 AI Agent 用的**共享记忆图** —— 一个以"图谱 + 约束自检"为核心的长期记忆系统。

edgelore 把 Agent 的记忆存成一张**知识图谱**（节点 / 边 / 约束），并且内置一个**声明式约束引擎**：你可以用表达式写规则（如"预算 ≤ 5000""SLA < 200ms"），系统自动检查记忆有没有违反。这是我们和 Mem0 / Zep 等主流方案最大的差异点——它们都在"存事实 + 检索"，几乎没有"规则自检"这一层。

- 本地优先，零云依赖：用 Node 内置的 `node:sqlite` 落库，一个 `.db` 文件就是全部记忆。
- 结构化存储原语 `capture`：喂一段结构化 JSON（维度 + 值），系统自动建维度、去重、落库、标冲突。
- 阶段化演进：M0–M4 全线贯通 + Agent 记忆管线（gate→extract→capture）+ 混合检索 + 冲突裁决 + MCP server。**LongMemEval-ORACLE（固定 100 题对照）：71.0%**（deepseek-v4-flash 同时担任抽取与判卷；三轮取证验证 38.0% → 53.0% → 71.0%）。当前状态见 [HANDOFF-v2.md](HANDOFF-v2.md)，优化路线图见 [docs/notes/optimization-roadmap.md](docs/notes/optimization-roadmap.md)。

---

## 快速开始（Quick Start）

> 需要 **Node.js ≥ 22**（用内置 `node:sqlite`，无需额外装数据库）。

```bash
# 1. 拿到代码
git clone <你的仓库地址> edgelore
cd edgelore

# 2. 安装依赖（仅 TypeScript 等开发依赖，运行时靠 Node 内置 sqlite）
npm install

# 3. 编译 TypeScript
npm run build

# 4. 跑测试（178 个用例，全绿即通过）
npm test
```

跑通后，用命令行把一段记忆存进去：

```bash
# 存一笔记忆：维度 author 的值是 charles（自动建维度 + 存成 accepted）
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"author","value":"charles"}' \
  --created-by agent:demo:1

# 单值维度 owner 先存 alice，再存 bob → 第二笔会被标成冲突（conflict）
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"owner","value":"alice","cardinality":"single"}' \
  --created-by agent:demo:1
node dist/src/cli.js --db ./edgelore.db capture \
  --content '{"dimensionKey":"owner","value":"bob","cardinality":"single"}' \
  --created-by agent:demo:1

# 看看库里现在有什么
node dist/src/cli.js --db ./edgelore.db node list
```

`capture` 返回示例（JSON 一行输出）：

```json
{"dimensionId":"node:core:dimension:...","statementId":"node:core:statement:...","created":true,"deduplicated":false,"conflict":false}
```

第三笔单值冲突会返回 `"conflict":true`，并自动把维度置为 `conflict`、新人置为 `tentative`。

---

## 命令行（CLI）

CLI 是 **JSON 进 / JSON 出**，专门给 Agent 调用（人也看得懂）。默认库是 `./edgelore.db`，用 `--db <路径>` 指定。

| 命令 | 说明 |
|---|---|
| `capture --content '<json>' --created-by <who>` | **核心**：存一段记忆（维度 + 值），系统处理去重 / 冲突 |
| `node add --type <t> --created-by <who> [--key ..] [--value ..]` | 手工加节点 |
| `node list [--type <t>] [--state <s>]` | 列出节点 |
| `edge add --type <t> --from <id> --to <id> --created-by <who>` | 加一条边 |
| `edge list` | 列出所有边 |
| `constraint add --participants a,b --bindings '<json>' --created-by <who>` | 加约束规则 |
| `constraint activate <id> --approved-by human:x` | 人工批准约束（Q01 闸门） |
| `constraint list` | 列出约束 |
| `evaluate <constraint-id>` | 跑约束自检，返回四态结果 |
| `get <id>` | 按 ID 查节点 / 边 / 约束 |

更完整的规格见 [docs/shared-memory-m2-spec.md](docs/shared-memory-m2-spec.md) 与 [docs/shared-memory-m3-spec.md](docs/shared-memory-m3-spec.md)。

---

## 项目结构

```
src/
  model/        # 类型定义 + 图存储（MemoryGraph，后端无关）
  store/        # SqliteGraph：用 node:sqlite 持久化
  engine/       # 约束表达式求值器（四态：satisfied/violated/indeterminate/error）
  agent/        # capture 存储原语（M3）+ 未来 Agent Memory 层
  cli.ts        # 命令行桥（Agent 调用入口）
test/           # 测试（内存 + SQLite 两个后端）
docs/           # 里程碑 spec、技术 Note、竞品分析、设计文档、交接文档
```

---

## 开发

```bash
npm run build      # 编译（tsc）
npm run typecheck  # 只类型检查
npm test           # 编译 + 跑测试
npm run lint       # ESLint
npm run format     # Prettier 格式化
```

---

## 文档导航

- [docs/HANDOFF.md](docs/HANDOFF.md) —— 新接手的人 / AI 先看这个（目标、边界、文件地图、git 状态）
- [docs/agent-memory-design.md](docs/agent-memory-design.md) —— Agent Memory 层（把一句话变结构化 JSON）设计
- [docs/competitor-analysis.md](docs/competitor-analysis.md) —— 竞品调研（Mem0 / Zep / Letta / OMEGA）
- [docs/notes/agent-memory-write-policy.md](docs/notes/agent-memory-write-policy.md) —— "哪些值得记"怎么定
- [docs/notes/agent-memory-paradigms.md](docs/notes/agent-memory-paradigms.md) —— 从 Claude Code / Codex 学提取思路

---

## License

MIT
