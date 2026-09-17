# Agent Memory 层设计草案（NLU → capture JSON）

> Status: **frozen（边界已确认，待实现）** —— 用户确认了 5 项关键决策 + "值得存"判据 + 可扩展要求。

## 1. 定位：它在整条链路哪一层

整条链路三段：

1. **触发层（未来）**：决定"这句话要不要进记忆系统"。本层不碰。
2. **Agent Memory 层（本次设计）**：拿到一段**已经确定要处理**的自然语言，输出结构化 capture 候选。拆两道：
   - **门控 prompt**：判这句话值不值得存（NOOP / 候选）。
   - **抽取 prompt**：把候选句子映射到维度、抽值、看与上下文的关系。
3. **存储层（M3 已实现）**：`capture(graph, content, ctx)` 把 JSON 落库，处理去重、状态、冲突标记。

**关键边界**：Agent Memory 层只产出 `CaptureContent`（允许多条），不产 `CaptureContext`（provenance 由调用方/系统注入）。**不直接调 capture**，由上层 runtime 决定。

## 2. 输入 / 输出契约

### 2.1 输入

```ts
interface ExtractInput {
  /** 当前要处理的自然语言句子或对话回合 */
  text: string;
  /** 说话人标识（可选，默认 agent 可配默认值） */
  speaker?: string;
  /** 已有维度清单，供 LLM 选择或新建（由系统从库里拉） */
  knownDimensions: KnownDimension[];
  /** 相关历史记忆摘要（用户确认"要喂"；现用 queryNodes 简单查，未来换向量检索） */
  contextMemories: MemorySummary[];
}

interface KnownDimension {
  key: string;
  description: string;
  cardinality: "single" | "multi";
  unit?: string;
}
```

### 2.2 输出

```ts
interface ExtractResult {
  /** NOOP = 不值得存；STORE = 产出若干 CaptureContent */
  action: "NOOP" | "STORE";
  /** STORE 时，允许一条或多条（用户确认允许多事实） */
  contents?: CaptureContent[];
  /** 简短理由，方便调试 */
  reason?: string;
}

interface CaptureContent {
  dimensionKey: string;          // 必填
  value: unknown;                // 必填
  cardinality?: "single" | "multi"; // 可选，默认 multi
  unit?: string;                 // 可选
}
```

## 3. 已确认的设计决策

| 问题 | 决策 |
|---|---|
| 1. Prompt 拆不拆 | **拆两道**（门控 + 抽取），参考 Mem0 两段式 |
| 2. 新建维度权限 | **直接 accepted**（奔放，用户拍板） |
| 3. 多事实 | **允许返回数组**（一次存多条） |
| 4. contextMemories | **要喂**（用 queryNodes 简单查，未来换向量） |
| 5. LLM 驱动器 | **先写 mock driver**，接口定死，模型可换 |

### 3.1 维度绑定策略（新建直接 accepted）

- **优先复用**：prompt 里塞 `knownDimensions`，LLM 先映射到已有 key。
- **新建即 accepted**：无匹配时用 `NEW:xxx`（camelCase）输出，**直接 accepted**，不进 tentative（用户决策 2）。
- **不要自由文本**：维度 key 必须从清单选或 `NEW:` 前缀，防编造。

### 3.2 「什么叫值得存」—— 核心判据（参考 Mem0 / Graphiti / 行业共识）

这是用户强调的**最关键**一点。结论：**不逐字转录，只抽"高信号"信息**。深入调研见 `docs/notes/agent-memory-write-policy.md`。

#### 3.2.1 Mem0 官方分类（权威依据）

**值得记住（STORE）：**
- 稳定身份事实：name / location / profession / language / org（变更少、几乎任何未来会话都用得上）
- 持久偏好：沟通风格、技术选择、饮食限制、格式偏好、工作时间
- 目标与活跃项目："在做 HR SaaS""备考 AWS"（稳定直到显式改）
- 有下游影响的过去决策："选了 PostgreSQL 而非 MongoDB""决定不用 TypeScript"
- 表达的约束："预算<$500/月""须 HIPAA 合规""团队无 ML 经验"（作为推荐常驻过滤器）

**该丢弃（NOOP）：**
- 对话填充：问候、肯定、客套（"Thanks!" 不值存）
- 瞬时状态："我今天累""网现在慢"（下次会话就 stale）
- 被矛盾的信息：用户说了和已存记忆冲突的 → 旧条目应更新，而非并列保留
- 已存在等价记忆（交给 capture 去重）

#### 3.2.2 我们的 STORE / NOOP 白名单（落到维度模型）

| 值得存（STORE） | 不值得存（NOOP） |
|---|---|
| **决策/结论**：拍板了什么 | 闲聊、问候、寒暄、客套 |
| **偏好**：明确喜欢/讨厌的做法 | 已存在等价记忆（去重） |
| **约束/规则**：预算、SLA、禁止项 | 纯过程对话（"帮我看看""好的"） |
| **事实/身份**：负责人、技术栈、截止日 | 一次性中间状态（易过期） |
| **数字度量**：带单位的值 | 公开常识、无需记忆的上下文 |
| **关系**：归属、依赖 | 不确定/猜测（除非用户确认） |

**门控 prompt 的灵魂**：只存"未来对话可能用得上、且不在上下文里能立刻推出来的"信息。**宁可少存，别污染库**——Mem0 经验：提取过度会让检索精度下降 15-20%。

> 更细的"值得记"补充维度（失败教训 / feedback / reference / why / 会话成果摘要）见 `docs/notes/agent-memory-write-policy.md` §3.x 与 `docs/notes/agent-memory-paradigms.md` §4.x。edgelore **坚持图谱路线**不变，这些仅用于校准 gate 判据。

#### 3.2.3 行业四阶段管线对标（实现增强建议，不改冻结边界）

Mem0 / LangMem / Letta / A-MEM 收敛到四阶段：**Triage → Extract → Dedupe/Resolve → Persist**。

- 我们的 gate ≈ Triage（是否值存）+ Extract 的"是否结构化"
- 我们的 extract ≈ Extract/Distill（→ 结构化 fact）
- 我们的 capture（M3 已实现去重 + 冲突标 conflict）≈ Dedupe/Resolve + Persist
- **capture 的"单值冲突标 conflict 不裁决"正是 2026 生产答案**（写时标新不删，读时/后台 reconcile），我们领先于"同步删"旧做法

**实现增强**：gate 前加一层**廉价启发式 Triage**（regex 跳客套"你好/谢谢/好的"），不调 LLM，省钱降噪；LLM 只处理清过流的回合。

### 3.3 基数（cardinality）谁定

- 已有维度自带 `cardinality`，LLM 优先遵循。
- 新建维度时，LLM 按 value 语义判断单值/多值。
- 系统用维度已存在的 cardinality 校验（冲突标 conflict，沿用 M3）。

### 3.4 单位（unit）

- 句子自动抽（"5000 元"→RMB，"3 天"→天）。
- 已有维度有 unit 时优先复用。
- 数字 value 尽量标准化（数字或规整字符串）。

### 3.5 多事实数组

一句含多个独立事实时，抽取 prompt 输出 `contents: [...]` 多条；上层 runtime 逐条调 capture。

## 4. Prompt 设计（两道，可扩展）

### 4.1 门控 Prompt（值得存吗）

```text
你是记忆守门人。判断一句话是否值得长期记忆。

输入 text（用户的话）。

值得存的类型（命中任一 → 候选继续；否则 NOOP）：
- 决策/结论：拍板了什么
- 偏好：明确喜欢/讨厌的做法
- 约束/规则：预算、SLA、禁止项
- 事实/身份：负责人、技术栈、截止日
- 数字度量：带单位的值
- 关系：归属、依赖

不值得存：闲聊、问候、已存在等价信息、纯过程对话、一次性中间状态、公开常识、猜测。

输出 JSON：
{ "store": true|false, "candidates?": [ "<值得存的独立事实原文片段>" ], "reason": string }
若 store=false，candidates 留空。
```

### 4.2 抽取 Prompt（映射到维度）

```text
你是记忆抽取器。把候选事实转成结构化记忆。

已知维度 knownDimensions：[...key, description, cardinality, unit?]
相关记忆 contextMemories：[...已存的值，用于判断重复/补充/矛盾]

对每条候选事实，输出：
{
  "dimensionKey": "从 knownDimensions 选最接近的 key；无则用 NEW:camelCaseKey",
  "value": "具体值，数字/布尔尽量标准化",
  "cardinality": "single|multi（已有维度优先用它的）",
  "unit": "可选，如 RMB/天/ms；已有维度有 unit 优先复用"
}

规则：
1. 不输出 provenance（created_by/source_refs 系统填）。
2. 不编造 text 没有的信息。
3. 若 contextMemories 已有等价值 → 仍可输出（去重交给 capture）；若明显矛盾 → 照常输出，capture 会标 conflict。
4. 每条候选独立一条。

输出 JSON：{ "contents": [ {...}, ... ] }
```

### 4.3 可扩展设计（用户强调）

prompt 不写死，做成**可插拔模板**：

- **按场景加载不同规则片段**：如 `budget` 维度强调"数值+单位标准化"；`preference` 强调"保留原意不夸张"；`constraint` 强调"可被 M1 引擎检查"。
- **维度清单即上下文**：新增维度自动进 `knownDimensions`，prompt 不需改。
- **规则以"片段"拼接**：基础片段（4.1/4.2 通用） + 可选场景片段（从配置文件读），未来加新类型记忆只加片段。
- **结构固定、措辞可调**：JSON schema 锁死（保证 capture 能解析），自然语言指令可迭代优化。

## 5. 与 capture 的调用关系

```
收到 text
  ↓
[门控] gate(text) → {store:false} 结束
                  → {store:true, candidates}
  ↓
[抽取] extract(candidates, knownDimensions, contextMemories)
       → {contents: [...]}
  ↓
[上层 runtime] 逐条 capture(graph, content, {created_by, source_refs})
       → CaptureResult（deduplicated / accepted / conflict）
```

**Agent Memory 层不直接调 capture**；只产出 JSON，runtime 编排。门控和抽取都可在无数据库下用 mock driver 单测。

## 6. 测试策略

- **门控单测**：闲聊→false；决策→true+候选；偏好→true。
- **抽取单测**：已知维度精确匹配；新建 NEW:；数字+单位；单值/多值；多事实数组。
- **集成**：gate → extract → capture → 库状态正确（含冲突标记）。
- **mock driver**：定义 `LlmDriver` 接口，`MockDriver` 返回预设 JSON，使测试不依赖真实 API、不花钱。

## 7. 实现后的形态（预测）

新增：
- `src/agent/gate.ts`：门控（值得存判定）
- `src/agent/extract.ts`：抽取（→ CaptureContent[]）
- `src/agent/prompt.ts`：两套可扩展 prompt 模板 + 场景片段
- `src/agent/llm-driver.ts`：`LlmDriver` 接口 + `MockDriver`（默认）
- `src/agent/index.ts`：导出 capture + gate + extract + 编排函数
- `test/agent/gate.test.ts`、`test/agent/extract.test.ts`

不变：
- `src/agent/capture.ts`（存储层）保持不动。

## 8. 待实现后确认

- 真实 LLM 驱动（OpenAI / 本地）接 `LlmDriver` 接口。
- contextMemories 检索未来升级为向量（"取"层）。
- 触发器（何时跑这层）归未来。

---

边界已冻结，下一步按 §7 实现 `gate` + `extract` + `prompt` + `MockDriver`，并把测试跑绿。
