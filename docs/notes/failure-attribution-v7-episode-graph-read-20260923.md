# v7 错题阶段归因

对象：48 道被 judge 判错的问题。人工同时核对了原始证据、Claim、实际召回上下文和最终回答。

| 根因 | 数量 | 占 48 道错题 |
| --- | ---: | ---: |
| 摄入损失 | 9 | 18.8% |
| 召回遗漏 | 6 | 12.5% |
| 作用域污染 | 2 | 4.2% |
| 回答阶段失败 | 25 | 52.1% |
| 题目/裁判问题 | 6 | 12.5% |

这说明 90.4% 之后的主要矛盾已经不全在摄入：真正明确的摄入损失是 9 题，明确召回遗漏是 6 题；25 题的所需证据已经交给回答模型，错误发生在计数、时间、状态、指代、拒答或 provenance 使用阶段。另有 6 题存在标准答案或 judge 问题，不应反向污染架构设计。

## 对主线二的直接结论

摄入层优先修复“不可压缩载荷”：数字、日期、颜色、专名、枚举、代码/和弦序列、实体属性必须以结构字段或 EvidenceSpan 保真，不能只留自然语言摘要。相对时间换算还必须保留原表达和锚点，避免把本来相邻的事件换算坏。

召回层优先修复集合完整性和多 Claim 计算依赖：先召回候选 Slot，再做同义 Slot 扩张，并为 count/max/sum/difference/order 等问题生成有界的 completeness plan。账户/项目 scope 必须在检索前硬过滤，不能靠回答模型忽略 foreign-account 结果。

回答层需要一个薄而明确的 MemoryCapsule contract：列出可用 Claim、状态、时间、saidBy/provenance 和证据；默认最新用户事实优先，不得拿 assistant 建议补用户事实，计算题必须显示所用操作数，证据不足才拒答。

## 明细

| ID | 归因 | 子类 | 说明 |
| --- | --- | --- | --- |
| a3838d2b | 召回遗漏 | set_completeness | Walk for Wildlife 已入库，但跨多个近义 Slot 聚合时没有召回。 |
| 0a995998 | 回答阶段失败 | counting | 西装干洗、靴子退换和新靴取件都在上下文中，回答只计了一项。 |
| 3a704032 | 回答阶段失败 | temporal_window | 三株植物的信息已召回，回答自行把蛇纹兰排除。 |
| dd2973ad | 摄入损失 | temporal_normalization | 相邻两天的相对时间被换算成互不相邻的绝对日期，破坏了‘预约前一天’关系。 |
| 46a3abf7 | 回答阶段失败 | state_interpretation | 三个鱼缸均已召回，回答把旧 5 加仑缸误判为不再持有。 |
| gpt4_2f8be40d | 题目/裁判问题 | judge_false_negative | 回答给出的婚礼数量 3 正确，并列出了三场；主要缺少第一对新人的 Mike，不应归因于摄入或召回。 |
| 88432d0a | 回答阶段失败 | deduplication | 同一次酸面包经历被重复计数。 |
| d23cf73b | 回答阶段失败 | classification | 已召回的饮食经历没有按题目口径正确归类为四种 cuisine。 |
| 7024f17c | 回答阶段失败 | temporal_window | 证据已在上下文，回答采用了与标准答案不同的 last week 边界。 |
| gpt4_2ba83207 | 召回遗漏 | aggregation | Thrive Market 的 150 美元 Claim 已入库，但最高消费比较时未召回。 |
| gpt4_ab202e7f | 回答阶段失败 | classification | 五个厨房物品均有证据，回答错误排除了咖啡机。 |
| edced276 | 摄入损失 | exact_payload | 原文中的夏威夷 10 天没有进入 Claim；Episode 回退也没有命中该证据回合。 |
| bf659f65 | 回答阶段失败 | classification | 三张专辑或 EP 均已召回，回答错误排除黑胶。 |
| eace081b | 回答阶段失败 | state_resolution | 上下文明确有最新的 Oahu 计划，回答没有采用。 |
| a2f3aa27 | 回答阶段失败 | state_resolution | 最新陈述接近 1300 已召回，回答仍锚定旧值 1250。 |
| 0977f2af | 回答阶段失败 | temporal_inference | Instant Pot 与 Air Fryer 均已召回，回答过度保守而拒绝题目要求的顺序判断。 |
| 031748ae_abs | 回答阶段失败 | abstention | 问题换成未出现的 Manager 职位，回答却迁移了 Senior Engineer 的团队人数。 |
| 07741c45 | 题目/裁判问题 | future_vs_current | 原文说鞋仍占据衣柜空间、计划放入鞋架；回答忠实区分了当前状态和计划，标准答案却把计划当成当前。 |
| 8a2466db | 回答阶段失败 | personalization | 已召回 Premiere Pro/Lumetri 偏好，回答仍混入泛化工具。 |
| 0edc2aef | 作用域污染 | foreign_account | 没有本账户的迈阿密酒店记录，却把其他账户的酒店清单交给回答模型。 |
| 35a27287 | 回答阶段失败 | personalization | 已召回语言练习偏好，回答没有据此组织文化活动建议。 |
| 75f70248 | 作用域污染 | foreign_account | 答案使用了另一账户的猫 Lola；目标上下文要求 Luna 和客厅深度清洁。 |
| 1d4e3b97 | 召回遗漏 | causal_support | 更换链条和飞轮的维护 Claim 已入库，但问题召回没有覆盖它。 |
| 89527b6b | 摄入损失 | exact_payload | Plesiosaur 的蓝色被摘要掉，证据片段又恰好在颜色之前截断。 |
| 18dcd5a5 | 摄入损失 | exact_payload | 原文的 Mummies (4) 被抽成笼统事件，数量没有保留。 |
| 5809eb10 | 摄入损失 | exact_payload | 原文的开工年份 2014 没有进入 Claim。 |
| eaca4986 | 摄入损失 | exact_payload | 第二首歌的副歌和弦序列被概括掉。 |
| 51a45a95 | 题目/裁判问题 | unsupported_gold | 用户只说兑换咖啡伴侣优惠券；Target 只是 assistant 后续举例，回答拒绝猜测是合理的。 |
| 75499fd8 | 摄入损失 | entity_attribute | Max 的 Golden Retriever 犬种没有被抽取。 |
| b86304ba | 回答阶段失败 | reference_resolution | 三倍购买价已经召回，回答因题材措辞差异拒绝关联。 |
| ec81a493 | 回答阶段失败 | reference_resolution | 500 copies 已召回，回答对海报/专辑指代作了错误区分。 |
| bc8a6e93_abs | 题目/裁判问题 | judge_strictness | ‘不知道’已经正确拒答，只是没有复述‘提到侄女而非叔叔’的完整理由。 |
| gpt4_18c2b244 | 回答阶段失败 | temporal_order | 三个事件日期均在上下文，回答却称 ShopRite 日期缺失。 |
| gpt4_a1b77f9c | 回答阶段失败 | arithmetic | The Power 完成日期已召回，回答没有完成三段时长求和。 |
| 4dfccbf7 | 回答阶段失败 | arithmetic | 2 月 1 日开始、2 月 25 日送修均已召回，却算成 0 天。 |
| 370a8ff4 | 题目/裁判问题 | incorrect_gold | 数据日期是 2023-01-19 与 2023-04-10，相隔 81 天（11 周 4 天），标准答案 15 周不成立。 |
| gpt4_21adecb5 | 回答阶段失败 | arithmetic | 本科完成与论文提交日期均已召回，却拒绝计算约六个月。 |
| 2ebe6c92 | 召回遗漏 | temporal_event | 完成 The Nightingale 的 Claim 已入库，但没有进入上下文。 |
| 71017277 | 回答阶段失败 | semantic_match | 姑妈送的水晶吊灯已召回，回答因 jewelry/chandelier 类别差异拒绝关联。 |
| gpt4_d6585ce9 | 召回遗漏 | event_participant | 与父母参加 Queen 演唱会的 Claim 已入库，但没有进入上下文。 |
| gpt4_1e4a8aec | 摄入损失 | exact_payload | 种下 12 株番茄苗这一动作与数量没有被完整保留。 |
| 7405e8b1 | 回答阶段失败 | comparison | 两次首单优惠信息已召回，回答仍拒绝比较。 |
| 92a0aa75 | 召回遗漏 | multi_claim_arithmetic | 召回了晋升前 2 年 4 个月，却漏掉在公司共 3 年 9 个月，无法做差。 |
| ba358f49 | 题目/裁判问题 | underspecified_gold | 2022-09-01 时 32 岁、婚礼仅知在 2023 年，缺少生日与婚礼相对顺序，32 或 33 才是严谨答案。 |
| 73d42213 | 摄入损失 | event_endpoint | 两小时路程被保留，但周一 7:00 出发这一计算端点没有进入 Claim。 |
| 37f165cf | 回答阶段失败 | aggregation | 416 与 440 页均已召回，回答没有按题目把两本书相加。 |
| a96c20ee_abs | 回答阶段失败 | abstention | 把‘在 Harvard 参加会议’错误拼接成‘在 Harvard 展示海报’。 |
| 09ba9854_abs | 回答阶段失败 | provenance_policy | 用 assistant 给出的通用公交价格补齐用户缺失事实，产生了不该有的计算。 |
