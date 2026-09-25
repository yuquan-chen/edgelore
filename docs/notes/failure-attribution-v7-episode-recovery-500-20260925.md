# v7 Episode 恢复版：500 题剩余错误归因

对象：`v7-episode-recovery-500-20260925` 的 24 道 judge 错题。可信成绩为 476/500（95.2%），裁判为 `deepseek/deepseek-v4.1-flash` 且关闭 thinking。审计使用同一份 v7 数据库，重新生成每题实际的 MemoryCapsule，并人工核对标准答案所在原始回合、Claim、召回内容和最终回答。没有重新摄入，也没有修改数据库。

## 结论

| 根因 | 数量 | 占 24 道错题 | 占 500 题 |
| --- | ---: | ---: | ---: |
| 真正的摄入丢失 | 0 | 0.0% | 0.0% |
| 召回层失败 | 6 | 25.0% | 1.2% |
| 回答层失败 | 15 | 62.5% | 3.0% |
| 题目、标准答案或裁判边界问题 | 3 | 12.5% | 0.6% |

这次最重要的结论不是 95.2%，而是摄入职责已经基本站稳：24 道错题所需的原始内容都仍在 Episode 中。两个看似“Claim 没抽全”的长载荷案例（100 项参数列表、HAMT 实验结果）也不是信息丢失；Claim 已经提供了回到对应 Episode 的语义索引，失败发生在 Episode 内部没有选中正确的 assistant 列表项或段落。因此不应把完整长列表复制进 Claim，也不需要新增 EvidenceSpan 节点。

## 召回层：6 题

| ID | 子类 | 具体失败 |
| --- | --- | --- |
| `8752c811` | Episode 内列表项选择 | 原始 assistant 回答完整保存了第 27 项 `Sound effects`，但 MemoryCapsule 只返回用户的请求和概括 Claim。当前算法没有把 `27th` 与列表编号 `27.` 对齐，并且 Claim 的 user 角色压过了 assistant 原文。 |
| `352ab8bd` | Episode 内 assistant 段落选择 | 原始 assistant 回答明确写有 HAMT 平均帧率提升约 20%，但 MemoryCapsule 只选择了用户提交评审指令的回合。 |
| `gpt4_7f6b06db` | 多事件完整性 | Muir Woods、Big Sur/Monterey、Yosemite 三个事件 Claim 都存在；MemoryCapsule 漏掉 Muir Woods，却重复提供两个 Yosemite 表述，导致顺序错误。 |
| `gpt4_d6585ce9` | 事件参与者遗漏 | `Queen with Adam Lambert ... with parents` 已入 Claim，但召回被 Brooklyn 音乐节和 friends 吸走。 |
| `92a0aa75` | 计算操作数遗漏 | “在公司共 3 年 9 个月”和“2 年 4 个月后晋升”均已入库，MemoryCapsule 只给出后者，无法求差。 |
| `1a8a66a6` | 作用域噪声 | 正确范围内只有 The New Yorker 和 Architectural Digest。范围外的 `peopleMagazineSubscription` 来自不在本题允许 session 中的 `answer_e22d6aef_1`；它退化成 `1 entries (omitted — context budget)` 时丢失了 `non-user-account` 标记，回答模型因此把它计入。 |

这里暴露了三个通用问题。第一，Episode 局部排序把“与 Claim 说话者相同”放在分数之前，导致 user 请求压过真正包含答案的 assistant 回合。第二，序号、列表编号和数值载荷还没有统一归一化。第三，多事件/多操作数问题仍可能被单一 Episode 或重复表述占满预算。

## 回答层：15 题

其中 12 题的 MemoryCapsule 已经包含充分证据，但模型没有完成计数、去重、比较、时间对齐、状态选择或算术：

| ID | 失败动作 |
| --- | --- |
| `0a995998` | 漏计一次到店取货。 |
| `3a704032` | 错误解释 `last month`，排除蛇纹兰。 |
| `dd2973ad` | 已拿到周三 2 AM 与周四预约，却没有完成相对日期对齐。 |
| `46a3abf7` | 把仍持有的旧 5 加仑鱼缸排除。 |
| `88432d0a` | 把同一次酸面包经历重复计数。 |
| `7024f17c` | 错误解释 `last week` 的边界。 |
| `gpt4_2ba83207` | Capsule 已包含 Thrive Market 约 150 美元，回答却只比较 Walmart 与 Publix。 |
| `gpt4_ab202e7f` | 错误排除被捐赠的咖啡机。 |
| `a2f3aa27` | 没有采用最新的“接近 1300”状态。 |
| `9ee3ecd6` | 已知当前 200、目标总数 300，却回答总门槛 300，没有计算还需赚取 100。 |
| `73d42213` | 已拿到 7 AM 出门与两小时路程，却没有推导 9 AM 到达。 |
| `37f165cf` | 已拿到 416 页与 440 页，却没有相加得到 856。 |

另外 3 题是拒答/provenance 纪律失败，而不是记忆缺失：

| ID | 失败动作 |
| --- | --- |
| `031748ae_abs` | 把 Senior Software Engineer 的团队人数迁移到未出现的 Software Engineer Manager 职位。 |
| `a96c20ee_abs` | 把“在 Harvard 参加会议并展示论文海报”拼接成“本科课程研究项目”。 |
| `09ba9854_abs` | 用户只给出出租车约 60 美元；回答使用明确标记为 assistant/tentative 的通用公交价格补齐缺失事实。 |

这些错误不应该驱动摄入层继续扩张。MemoryCapsule 已经提供了时间、状态、saidBy 和原文证据；后续应由宿主 Agent 遵守一个薄的回答契约：计算题显式使用 Capsule 中的操作数，优先最新用户事实，不把 assistant 建议冒充用户经历，不在缺少关键操作数时自行拼接。

## 题目或标准答案边界：3 题

| ID | 问题 |
| --- | --- |
| `07741c45` | 原文说旧鞋目前占据 closet 空间，并计划放入 shoe rack；回答忠实区分了“当前在 closet”和“计划进 shoe rack”，而标准答案把计划当成当前状态。 |
| `51a45a95` | 用户只说兑换了咖啡伴侣优惠券、优惠券来自邮箱，没有说兑换地点是 Target；标准答案缺少原文支持。 |
| `370a8ff4` | 2023-01-19 到 2023-04-10 是 81 天，即 11 周 4 天；模型答案正确，标准答案 15 周与日期矛盾。 |

这 3 题不应反向用于修改 EdgeLore。

## 对架构的直接结论

暂不修改摄入，不重新跑 940 条，不增加节点类型，也不把长载荷复制进 Claim。`Claim = 语义索引`、`Episode = 原始信息` 的职责划分经这轮审计继续成立。

下一步只修召回层的 6 题，优先顺序是：先修作用域摘要丢标签的问题；再修 assistant 长载荷、序号与列表项的 Episode 局部选择；最后修多事件和多操作数的有界完整性。修复后先只回归这 24 题，不立即重跑 500 题。回答层的 15 题另归宿主 Agent/MemoryCapsule contract，不用摄入规则去补。
