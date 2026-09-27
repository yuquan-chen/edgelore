# edgelore

> 给 AI Agent 用的**共享记忆图** —— 一个以“图谱 + 显式约束求值”组织长期记忆的后端。

edgelore 把 Agent 的记忆组织为图（节点、边和 N 元约束），并内置声明式约束引擎：可用表达式定义规则（如“预算 ≤ 5000”或“SLA < 200ms”），由系统检查已接受的记忆是否满足规则。EdgeLore 的重点差异是显式的约束求值、冲突状态和人工治理；Mem0、Zep 等也提供图记忆能力，因此不应简单概括为“只有事实存储和检索”。参见 [Mem0 Graph Memory](https://docs.mem0.ai/open-source/features/graph-memory) 与 [Zep Context Graph](https://help.getzep.com/graph-overview)。

- 本地优先：核心记忆图和 Episode 存入 SQLite；Node 内置 `node:sqlite`，无需另装数据库。使用 LLM 或 embedding 时仍可配置外部服务。
- 结构化存储原语 `capture`：喂一段结构化 JSON（维度 + 值），系统自动建维度、去重、落库、标冲突。
- 当前能力：M0–M4、Agent 记忆管线（gate→extract→capture）、图增强摄入、混合检索、冲突裁决和 MCP server 均已实现。LongMemEval-ORACLE v7 的当前最佳记录为 **476/500（95.2%）**；错题归因见 [v7 错题分析](docs/notes/failure-attribution-v7-episode-recovery-500-20260925.md)。

---

## 快速开始（Quick Start）

> 需要 **Node.js ≥ 22**（用内置 `node:sqlite`，无需额外装数据库）。

```bash
# 1. 拿到代码
git clone <你的仓库地址> edgelore
cd edgelore

# 2. 安装运行时与开发依赖（MCP SDK、图浏览器和 TypeScript 工具）
npm install

# 3. 编译 TypeScript
npm run build

# 4. 运行完整测试套件
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

更完整的规格见 [M2](docs/shared-memory-m2-spec.md)、[M3](docs/shared-memory-m3-spec.md) 和 [Agent 记忆层设计](docs/agent-memory-design.md)。

### 接入 Hermes 或 OpenClaw

EdgeLore 通过本地 stdio MCP server 暴露记忆工具。要求 Node.js ≥ 22；先在仓库目录执行 `npm install` 和 `npm run build`。下面的数据库路径请改成绝对路径，并确保它的父目录已经存在。`--created-by` 是写入 provenance 身份，必须使用 `human:<id>` 格式。

#### 配置模型 API

先查看仓库里的 [`.env.example`](.env.example)，里面列出了支持的变量。直接运行 CLI 时，可复制为进程工作目录下的 `.env.local` 并填写；该文件已被 Git 忽略，不能提交真实密钥。MCP server 是宿主启动的子进程，工作目录不一定是 EdgeLore 仓库，因此建议在 Hermes/OpenClaw 对应 server 配置的 `env` 中设置变量，示例见下方。也可以使用宿主提供的本地密钥管理方式。

| 用途 | 必填变量 | 可选变量与说明 |
|---|---|---|
| 记忆抽取（`memory_remember`） | `OPENAI_API_KEY`、`EDGELORE_MODEL` | `OPENAI_BASE_URL` 默认为 `https://api.openai.com/v1`；使用其他 OpenAI-compatible provider 时填它提供的 API base URL，并将模型 ID 填为该 provider 认可的名称。 |
| 向量检索 | `EDGELORE_EMBEDDING_MODEL`、`EDGELORE_EMBEDDING_DIMENSIONS` | 独立 provider 可设置 `OPENAI_EMBEDDING_API_KEY`、`OPENAI_EMBEDDING_BASE_URL`；未设置时回退到 chat 的 key/base URL。维度必须匹配模型输出。未配置 embedding 时，检索使用 lexical 路径。 |
| 决策层（可选） | `TYPESAFE_API_KEY` | `TYPESAFE_BASE_URL` 默认为 `https://api.typesafe.ai`，`TYPESAFE_MODEL` 默认为 `jev-latest`。 |

仅连接 MCP、追加 Episode 和使用 lexical `memory_search` 不需要模型 API；抽取需要 chat provider，向量检索需要 embedding provider。请使用本地密钥存储，不要把真实 API key 提交到仓库。

Hermes：把下列内容合并到 `~/.hermes/config.yaml` 的 `mcp_servers` 中，保留原有配置：

```yaml
mcp_servers:
  edgelore:
    command: "node"
    args:
      - "/absolute/path/to/edgelore/dist/src/mcp/main.js"
      - "--db"
      - "/absolute/path/to/edgelore-data/edgelore.db"
      - "--created-by"
      - "human:your-name"
    timeout: 60
    connect_timeout: 10
    # 可选：只填写要启用的 provider
    env:
      OPENAI_API_KEY: "你的兼容 API key"
      OPENAI_BASE_URL: "https://api.openai.com/v1"
      EDGELORE_MODEL: "你的 chat 模型 ID"
      # 可选向量检索：维度必须与模型输出一致
      EDGELORE_EMBEDDING_MODEL: "你的 embedding 模型 ID"
      EDGELORE_EMBEDDING_DIMENSIONS: "1024"
    tools:
      include: [memory_append_episode, memory_search, memory_remember]
```

保存后重启 Hermes；用 `hermes mcp list` 查看配置，用 `hermes mcp test edgelore` 实际连接并检查工具发现。Hermes 中的工具名会加上 `mcp_edgelore_` 前缀。

OpenClaw：把这项合并到 OpenClaw 当前配置的 `mcp.servers`（JSON5 格式），不要覆盖其他 server：

```js
{
  mcp: {
    servers: {
      edgelore: {
        command: "node",
        args: [
          "/absolute/path/to/edgelore/dist/src/mcp/main.js",
          "--db",
          "/absolute/path/to/edgelore-data/edgelore.db",
          "--created-by",
          "human:your-name",
        ],
        requestTimeoutMs: 60000,
        connectionTimeoutMs: 10000,
        // 可选：只填写要启用的 provider
        env: {
          OPENAI_API_KEY: "你的兼容 API key",
          OPENAI_BASE_URL: "https://api.openai.com/v1",
          EDGELORE_MODEL: "你的 chat 模型 ID",
          // 可选向量检索：维度必须与模型输出一致
          EDGELORE_EMBEDDING_MODEL: "你的 embedding 模型 ID",
          EDGELORE_EMBEDDING_DIMENSIONS: "1024",
        },
        toolFilter: { include: ["memory_append_episode", "memory_search", "memory_remember"] },
      },
    },
  },
}
```

用 `openclaw mcp status --verbose` 检查已保存的配置，再用 `openclaw mcp probe edgelore` 实际连接并列出工具。OpenClaw 的 MCP registry 让配置好的运行时能够使用 server，但不会自动在任务开始时 recall 或任务结束时摄入。

端到端验证：在任一宿主里让 Agent 调用 `memory_append_episode`，写入一条包含唯一标记（例如 `amber-kite-731`）的 user turn，并设置 `scope` 为 `owner_id=demo`、`project_id=smoke-test`、`phase_id=setup`；再用同一 scope 调用 `memory_search`，查询该标记并指定 `mode=lexical`，确认返回的 evidence 中包含原文。这样验证工具发现、MCP 调用、SQLite 持久化和证据召回，不需要 chat LLM 或 embedding API。

注意：`memory_append_episode` 只保存不可变的原始 Episode，不抽取 Claim，也不启动摄入管线；`memory_remember` 才会同步运行抽取，且需要配置 EdgeLore 的 LLM。任务开始自动 recall 和任务结束异步摄入仍需宿主 lifecycle adapter，目前尚未实现。官方配置参考：[Hermes MCP](https://github.com/hermes-agent-org/hermes/blob/main/website/docs/user-guide/features/mcp.md)、[OpenClaw MCP](https://docs.openclaw.ai/cli/mcp)、[OpenClaw MCP 配置](https://docs.openclaw.ai/gateway/config-extensions)。

### Memory Explorer（本地图谱浏览器）

对已有 SQLite 记忆库启动只读图谱浏览器：

```bash
npm run build
node dist/src/cli.js ui --db ./edgelore.db
# 可选：指定端口（默认 4173）
node dist/src/cli.js ui --db ./edgelore.db --port 4180
```

`--db` 必须指向已经存在的数据库。若已安装或链接 `edgelore` 命令，也可以运行 `edgelore ui --db ./edgelore.db`。

首次打开页面时，会提示创建本机 `root` 账号口令（至少 6 位）。程序只会把加盐后的 scrypt 哈希写入**启动命令时的工作目录**下的 `.env.local`，不会保存明文口令。后续启动请保留该文件，并从同一工作目录运行；`.env.local` 是本地配置文件，不要提交到版本库。

浏览器登录会话通过 HttpOnly、SameSite Cookie 维护，有效期为 12 小时；服务重启也会使当前会话失效。可以在页面中登出。浏览器只绑定 `127.0.0.1`，SQLite 以只读模式打开；此工具面向本机查看，不用于开放到网络或多用户认证。

---

## 项目结构

```
src/
  model/        # 类型定义 + 图存储（MemoryGraph，后端无关）
  store/        # SqliteGraph：用 node:sqlite 持久化
  engine/       # 约束表达式求值器（四态：satisfied/violated/indeterminate/error）
  agent/        # capture、gate/extract、图增强摄入、检索与冲突治理
  cli.ts        # 命令行桥（Agent 调用入口）
test/           # 测试（内存 + SQLite 两个后端）
docs/           # 架构规格与维护中的技术记录
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

- [docs/notes/](docs/notes/) —— 检索、冲突、摄入错题归因等技术记录
- [docs/agent-memory-design.md](docs/agent-memory-design.md) —— Agent Memory 层（把一句话变结构化 JSON）设计
- [docs/notes/agent-memory-write-policy.md](docs/notes/agent-memory-write-policy.md) —— "哪些值得记"怎么定
- [docs/notes/host-runtime-collaboration.md](docs/notes/host-runtime-collaboration.md) —— 宿主 Agent 集成边界
- [docs/notes/retrieval.md](docs/notes/retrieval.md) —— 记忆检索机制

---

## License

MIT
