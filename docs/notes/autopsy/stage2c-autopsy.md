# stage2c 错题解剖（29 道）+ stage2b→2c 翻转对分析

> 2026-09-20 · stage2c = 71.0%（软 scope）。双路取证：错题归因 + 翻转对分析

---

# 第一部分：错题归因

# stage2c 错题解剖（29 道，verdict=0）

证据文件（只读分析产物）：`C:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\data\tmp-core2c.txt`（每题核心摘要）、`tmp-part1/2/3.txt`（金标话语+金会话入库语句逐条）、`tmp-wrong2c-dump.txt`（全量 token 覆盖）。

## 1. 逐题表

refusal：硬=完整拒答；软=含“记忆里没有/I don't have”类软拒答；部分=答一半+拒一半。cov=金标内容词在金会话入库语句的覆盖率。散key=金会话内承载金标事实的维度 key 数（人工核定，非 token 噪声计数）。

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | cov | 散key | 主因 |
|---|---|---|---|---|---|---|
| 982b5123 | Five months ago | 3.5 months ago（由"提前3月订"推算） | 否 | 0/2 | 1 | (a) “两个月前去过SF参加婚礼”未抽取，运算缺操作数 |
| b759caee | @jessica_poole_jewellery | 列出3个handle，猜Rachel Boston | 否 | 1/3 | 2 | (a) 三位设计师的 UK-based/gemstone 限定词全库无（gemstone 全库 0 命中） |
| 6d550036 | 2 | 8 个（5绘画+营销campaign+2） | 否 | 0/1 | 3 | (c) “5绘画项目”来自 da72b1b4、“marketing campaign”来自 6a4f8626（他组） |
| gpt4_e061b84f | Tri→Midsummer5K→慈善足球 | 排球联赛→铁三→慈善足球 | 否 | 8/16 | 4 | (a) "Midsummer 5K Run"事件未抽取（全库 0 命中，仅存 27:42 PB）；次因(d)把排球联赛当参赛 |
| 157a136e | 43 | 奶奶75岁，无您年龄，没法算 | 软* | 0/1 | 1 | (a) 用户 32 岁未抽取（金会话语句无年龄） |
| 4bc144e2 | $65 | 洗车$15；停车罚单“记忆里没有” | 软(部分) | 0/1 | 1 | (a) parking ticket 全库 0 命中，$50 罚单在"By the way"插入语中丢失 |
| aae3761f | 15 小时(4+6+5) | 16-17 小时（4+5+7~8 错腿） | 否 | 2/8 | 2 | (a) “开6小时去DC”未抽取，模型用 OBX→Tybee 规划值替代 |
| gpt4_78cf46a3 | 先收到手机壳 | 无法确定先后 | 软 | 2/3 | 2 | (a) 充电器“两周前丢”时点丢失（userGoal 语句无时间）；phoneCaseAge“一月前”在库 |
| gpt4_a1b77f9c | 共 8 周(2+4+2) | 仅 Sapiens≈4周，其余无法算 | 软* | 6/10 | 5 | (a) Nightingale 开始(01/01)未抽取；次因(d) Power 起止(03/06+03/20)在库但没连上 |
| 81507db6 | 3 | 2 场（Emma+Rachel） | 否 | 0/1 | 2 | (a) “同事Alex的毕业典礼”未抽取（_5 语句全是认证话题） |
| 37f165cf | 856 页 | 335+384（推荐书目页数） | 否 | 0/1 | 0 | (a) 用户的 416 页小说与 Nightingale 440 页均未抽取；模型误用助手推荐书的页数 |
| c18a7dc8 | 7 | 不知道。 | 硬 | 0/1 | 1 | (a) “25岁毕业”与“32岁”双双未抽取 |
| dad224aa | 周六 7:30 am | 只有周五6:00、周日8:30 | 软 | 1/2 | 2 | (a) 更新值“周六7:30”未抽取（_2 只入 joggingStartTime 8:15-8:30） |
| gpt4_f420262c | JetBlue,Delta,United,AA | 仅 United→AA | 否 | 5/5 | 4 | (a) Delta BOS-ATL 航班事件未抽取（只剩 miles=10000）；次因(d)把在库的 JetBlue 红眼误判为未来预订 |
| 8aef76bc | Mod Podge | 不知道（无密封剂记录） | 软 | 0/4 | 1 | (a) "Seal with Mod Podge"细节未抽取（recycledDecorProjects 只留项目名） |
| 71315a70 | 10-12 小时 | 12 小时 | 否 | 2/3 | 1 | (a) 区间"10-12"被抽取压平成 12（与金标实质等价但判0，最接近 judge-noise 的一题） |
| 8cf51dda | …clinical and biological significance | 目标2写成“临床意义和治疗反应” | 否 | 15/19 | 2 | (d) 正确措辞在库（grantsAimPageContent），模型却采用了漂移版 objectives 语句 |
| 4dfccbf7 | 24 天 | 0 天（同日2/1） | 否 | 0/4* | 3 | (d) 把 02/01 的“计划送修”当决定；02/25“今天决定”语句在库未用 |
| 681a1674 | 2 | 5 部 MCU（5/25） | 否 | 0/1 | 2 | (c) “5部MCU”来自他组 67074b4b、22部来自 86c505e7；根因兼(a)金标“重看2部”未抽取 |
| ef9cf60a | $300 | $200（把$100礼品卡当未确认计划） | 否 | 0/1 | 2 | (a) “last time 已买”过去时丢失，语句归入 plan 命名的 key；次因(d) |
| 59524333 | 6:00 pm | 7:00 pm | 否 | 1/3 | 2 | (a) 更新语句 gymSchedule(05/30) 只留了星期、丢了 6:00 pm 时间 |
| 07b6f563 | iPhone 13 Pro 配件偏好 | 按 Samsung S22 推荐配件 | 否 | 8/23 | 4 | (c) “S22+Case-Mate”来自他组 e49ed9d3_abs_2；使能因素：金会话未抽取“iPhone 13 Pro”设备属性 |
| 8979f9ec | 8 顿 | 扁豆汤5顿；fajitas 顿数无记录 | 否 | 0/2 | 2 | (a) fajitas“第三顿”计数未抽取 |
| 2b8f3739 | $495 | $1,775（含$1,280营业额） | 否 | 0/1 | 3 | (c) userBusinessEarnings=1280 来自他组 c9f5693c；三个金标分项全在屏且被引用 |
| gpt4_4ef30696 | 1 天 | 不知道（无 Nightingale 完读日期） | 软 | 0/4 | 1 | (a) “刚读完 Nightingale”(01/15) 未抽取（该会话只入了推荐类语句） |
| 35a27287 | 偏好语言实践类活动(西/法语) | 推荐SF帆船/Alcatraz/爱尔兰文化中心 | 否 | 4/19 | 1 | (c) 爱尔兰中心来自 83c13ff9、帆船来自 ab603dd5（他组）；次因(d)法语西语资源在库但没转成偏好 |
| gpt4_fa19884d | bluegrass band w/ banjo | 不知道（只有推荐清单） | 软 | 2/5 | 3 | (a) 用户“发现蓝草乐队”事实在库但落在变体会话 ff201786_2（金标是 ff201787）且无时点 |
| 36b9f61e | $2,500 | $800（礼服）；“无其他金额” | 否 | 0/2 | 3 | (b) 三笔($800/$500/$1200)分居3个key，检索只召回1条（含"luxury"词的那条） |
| 9ea5eabc | Paris | Hawaii | 否 | 1/1 | 2 | (a) “recent family trip to Paris”被压成目的地列表项 europeTripDestinations：Paris，家庭+时序语境丢失 |

\* cov 为纯数字金标（如"2""856"）时区分度低，以人工核对为准；Q18 金标为算术结果，库内三个日期语句齐全。

## 2. 失败模式分布

| 主因 | 数量 | 占比 | 题号 |
|---|---|---|---|
| (a) not-in-lib / 抽取丢失 | 21 | 72% | 982b5123, b759caee, gpt4_e061b84f, 157a136e, 4bc144e2, aae3761f, gpt4_78cf46a3, gpt4_a1b77f9c, 81507db6, 37f165cf, c18a7dc8, dad224aa, gpt4_f420262c, 8aef76bc, 71315a70, ef9cf60a, 59524333, 8979f9ec, gpt4_4ef30696, gpt4_fa19884d, 9ea5eabc |
| (c) pollution 跨用户污染 | 5 | 17% | 6d550036, 681a1674, 07b6f563, 2b8f3739, 35a27287 |
| (d) reasoning | 2 | 7% | 8cf51dda, 4dfccbf7 |
| (b) scattered / 检索漏召 | 1 | 3% | 36b9f61e |
| (e) judge-noise | 0 | — | （71315a70 最接近，但根因仍是抽取把 10-12 压成 12） |
| (f) other | 0 | — | |
| (b) truncation-middle（A1 新盲区） | **0** | — | 金标承载维度均为 n≤6 小维度，无“落在中间被截”案例 |

refusal 共 7 题（4bc144e2、gpt4_78cf46a3、c18a7dc8、dad224aa、8aef76bc、gpt4_4ef30696、gpt4_fa19884d），全部是“库里真没有”的诚实拒答——拒答机制本身工作正常，缺的是抽取。

## 3. 能力级结论

**瓶颈排序：**

1. **抽取保真/保全（21/29，72%）是压倒性瓶颈**，不是检索排序、不是答题推理。三个具体亚型：
   - **事件+时点不保全**：相对时态（"two months ago / today / two weeks ago"）未解析成绝对日期入库，或"just finished/started X today"事件在推荐类长会话里被丢弃。时间推理 8 错中 6 错、知识更新 4 错全部由此而来（dad224aa 更新值、59524333 更新时间丢失后，A2 规则3“最新优先”根本无新值可选）。
   - **旁插数字丢弃**："By the way" 类插入语里的 $50 罚单、DC 6小时、416/440 页、fajitas 第三顿、$100 已购礼品卡——多会话求和题几乎全灭（4bc144e2/aae3761f/37f165cf/8979f9ec/2b8f3739 分项缺失或时态丢失）。
   - **限定词压平**：设计师的 UK-based/gemstone 属性、区间 10-12、biological significance→therapy response、“家庭旅行”语境——单会话助手与偏好题的语义等价性被破坏。
2. **跨用户污染（5/29，17%）**：scope 硬过滤改软加权（范围外保留）的直接代价。他组同类记忆（5个绘画项目、5部MCU、营业额$1280、Samsung S22、爱尔兰文化中心）被召回并混入答案。污染源全部是身份性强/计数类维度。
3. **reasoning 仅 2 例**（计划日vs决定日混淆；同屏选了漂移措辞），答题层规则（A2 规则3、A4 dateTo、A6 桥接）本轮已把这类压到最低。
4. **scattered/截断几乎绝迹**：(b) 仅 1 例且是“聚合求和需 3 条全召回，只召回含 scope 关键词的 1 条”；**A1 双端渲染的 truncation-middle 盲区实测 0 例**——本轮 >8 条维度的中间截断没有造成任何错题。

**只能靠第 2 轮重摄入解决的（≈20 题）：**
- event_time 解析落库（相对时态→绝对日期，相对词本身也保留）：982b5123、gpt4_78cf46a3、gpt4_f420262c、gpt4_a1b77f9c、gpt4_4ef30696、gpt4_fa19884d、4dfccbf7(部分)、dad224aa、59524333
- 旁插/数字细节与时态保全（"already purchased"不归入 plan 类 key）：4bc144e2、aae3761f、37f165cf、8979f9ec、ef9cf60a、71315a70(区间)、c18a7dc8、81507db6、681a1674(根因半)、b759caee(属性)、8aef76bc、9ea5eabc(语境)
- **变体会话别名归并**：gpt4_fa19884d 的事实被抽到相邻变体会话（ff201786 vs 金标 ff201787），按 source 加权时会错位——重摄入时需把同一用户变体会话的事实归并到统一命名空间。

**重摄入解决不了、须在检索/隔离层解决的（6 题）：** 5 例污染（6d550036、681a1674、07b6f563、2b8f3739、35a27287）需要对用户组（answer_XXXXXX 前缀）做身份类维度硬隔离或同型跨组强降权；1 例 (b)（36b9f61e）需要聚合题的多组件召回保证（求和题把所有带金额的同主题语句拉齐）。2 例 (d)（8cf51dda、4dfccbf7）属答题层，靠 prompt/规则小修。

---

# 第二部分：stage2b→2c 翻转对分析

分析完成。所有数据均通过 `node:sqlite` 只读模式及两轮的 `hypotheses/verdicts` 文件获取。关键机制已对照代码进行验证：`src/agent/retrieval.ts` (软范围 ×3 融合得分提升，截断前生效) + `src/agent/runtime.ts` (维度渲染回退至范围外成员，当维度不存在范围内成员时 —— 即“孪生会话”通道)。

---

# stage2b → stage2c 翻转对分析

总分：两轮均 71（6 题 2→0，6 题 0→2，净 0）。两轮共用同一个 memory.db（mtime 14:08 < stage2b 答题 14:35），唯一差异 = scope 硬过滤 → 软加权 ×3。

## 1. 逐题表（12 道翻转题）

| qid | 类型 | 2b→2c | 金标(≤40) | 2b 答案(≤40) | 2c 答案(≤40) | refusal(2b/2c) | contentRate(屏内/全库) | 散key数 | 主因 |
|---|---|---|---|---|---|---|---|---|---|
| b759caee | s-s-assistant | 1→0 | @jessica_poole_jewellery | 列出3个handle，“无法确定哪个” | 同3个handle+**猜Rachel Boston** | 否/否 | 3/3 | 2 | **(d) reasoning**：金料在屏（两轮同屏），UK/异形宝石属性抽取时丢失，2c 无锚幻觉点名 |
| 71315a70 | knowledge-update | 1→0 | 10-12 hours | 12 hours | 12 小时 | 否/否 | 2/3 | 1 | **(e) judge-noise**：实质同答，英文判对、中文判错；底层缺陷=抽取把"10-12"压成"12" |
| 681a1674 | multi-session | 1→0 | 2 | 2部（Doctor Strange+Endgame） | 5部 MCU（引“记录于5/25”） | 否/否 | 数值题 | 证据2key | **(c) pollution**：孪生“5 MCU films @5/25”(67074b4b_2)+“22部”(86c505e7)入屏并被逐字引用 |
| 07b6f563 | s-s-preference | 1→0 | 偏好 iPhone 13 Pro 兼容配件 | 屏保/钱包壳/充电宝品牌清单 | **Samsung S22+Case-Mate**+车充支架 | 否/否 | 11/30 | 5 | **(c) pollution**：孪生“Galaxy S22”(e49ed9d3_abs_2)+“车载支架”(dc5e537d_1)成为答案主轴；iPhone 13 Pro 约束只在维度描述里被淹没 |
| 2b8f3739 | multi-session | 1→0 | $495 | $495（120+225+150） | **$1,775**（多加$1,280） | 否/否 | 数值题 | 证据3key | **(c) pollution**：孪生“business earnings $1,280”(c9f5693c_1, 4/11)混入求和 |
| 35a27287 | s-s-preference | 1→0 | 偏好可练西/法语的文化活动 | 不知道（软拒答）→判对 | SF Bay帆船/恶魔岛/**爱尔兰文化中心** | 软拒/否 | 2/24 | 1 | **(c) pollution**：孪生 Irish Cultural(83c13ff9)+SF Bay(ab603dd5_1)占满答案；屏内金信号本就稀薄（资源名清单）；2b 拒答被判 1 属 judge 宽松 |
| a11281a2 | multi-session | 0→1 | 100 | 350（把350当增量） | **350−250=100**（双key引用） | 否/否 | 数值题 | 2 | 范围内补全恢复：instagramFollowerGrowth(250起点)经×3加权入屏，与350同屏才可做减法 |
| e9327a54 | s-s-assistant | 0→1 | The Sugar Factory at Icon Park | Sugar Factory（巨型奶昔） | Sugar Factory（巨型奶昔） | 否/否 | 3/4 | 3 | **(e) judge-noise**：两轮实质同答（均未提Icon Park），判0/判1纯抖动 |
| f4f1d8a4 | s-s-user | 0→1 | my sister | 不知道 | **sister 送的搅拌机** | 拒/否 | 0/**1** | 0(屏内) | **孪生会话恢复确认**：金会话 f5b33470 的 has_answer 句“I got my new stand mixer as a birthday gift from my sister”**抽取漏收**；事实仅存于孪生 f5b33470_abs + 733e443a_1，2b 硬过滤→拒答，2c 软加权→可引用 |
| 16c90bf4 | s-s-assistant | 0→1 | Pilsner or Lager | 推荐了 Pilsner（含日期） | 推荐了 Pilsner | 否/否 | 2/5 | 1 | **(e) judge-noise**：几乎逐字同答，判0/判1抖动 |
| 46a3abf7 | multi-session | 0→1 | 3 | 4个（把检疫缸计入） | **3个**（排除检疫缸） | 否/否 | 数值题 | 证据多key | 屏内噪声位移：quarantineTankPlan 是**范围内**语句，×3 重排后出屏/未被计入，非跨用户污染 |
| ad7109d1 | s-s-user | 0→1 | 500 Mbps | 不知道 | **500 Mbps**（@2023/03/28） | 拒/否 | 0/**2** | 0(屏内) | **孪生会话恢复确认**：金会话 679840f8 的“upgraded to 500 Mbps”**抽取漏收**；事实仅存于孪生 internetPlanSpeed=500(da704e79_1)，同 f4f1d8a4 机制 |

A1 双端渲染新盲区 (b) truncation-middle：12 道翻转题中 **0 例**（无 >8 条且中间条目承重的维度）。

## 2. 失败模式分布

回归 6 题：(c) pollution ×4（681a1674、07b6f563、2b8f3739、35a27287——污染源全部验证为 haystack 外孪生会话，且 2c 答案逐字引用了污染语句）；(d) reasoning ×1；(e) judge-noise ×1。
修复 6 题：孪生恢复 ×2（f4f1d8a4、ad7109d1，均为单会话用户题，硬过滤结构性做不到）、屏内补全/位移 ×2（a11281a2、46a3abf7）、judge 抖动 ×2（e9327a54、16c90bf4）。

**3. 两边都错但答案变了（23 题，仅列出）**：982b5123, 6d550036, gpt4_e061b84f, 157a136e, 4bc144e2, aae3761f, gpt4_78cf46a3, gpt4_a1b77f9c, 81507db6, 37f165cf, c18a7dc8, dad224aa, gpt4_f420262c, 8aef76bc, 8cf51dda, 4dfccbf7, ef9cf60a, 59524333, 8979f9ec, gpt4_4ef30696, gpt4_fa19884d, 36b9f61e, 9ea5eabc

## 4. 能力级结论

分型得分变化：single-session-user 10/12→**12/12**(+2)、s-s-assistant 13/17→14/17(+1)、s-s-preference 4/4→**2/4**(−2)、knowledge-update 14/17→13/17(−1，纯 judge 噪声)、multi-session 16/28=、temporal 14/22=。拒答数 20→16。

**软 scope 净评估**：分数净 0，但性质是“用偏好题的确定性换单会话用户题的恢复”。它修的是结构性缺陷（金会话抽取漏 → 孪生兜底，2 题真实救回），伤的是污染敏感面（4 题被外账本语句带偏，全是“同类记忆形状相似”的题：卖钱总额/电影计数/手机配件/文化活动）。值得保留，但必须配约束。

**两全方向**（检索侧即可做，不必等重摄入）：
1. **账本标注渲染**：无范围内成员的维度仍可渲染孪生内容，但打标（如 `[non-user-account]`），并在答题层加规则——**聚合类问题（求和/计数/对比）只允许使用单一账本（scope 内）语句**；单点事实查询才允许孪生兜底。这可同时救回 2b8f3739/681a1674/07b6f563/35a27287 并保住 f4f1d8a4/ad7109d1（后者是“该维度无范围内成员”时的兜底，正是现渲染层已有的语义）。
2. 拒答保底：偏好类问题若屏内范围内证据词覆盖过低（如 35a27287 屏内 2/24），宁可保守陈述偏好而非用外账本活动填充。

**只能靠第 2 轮重摄入解决的**（检索层无解）：b759caee（UK/异形宝石属性关联丢失）、07b6f563（"for iPhone 13 Pro"约束只在维度描述、语句值丢失）、35a27287（“练西/法语”偏好框架丢失成裸播客清单）、71315a70（"10-12 hours"压成"12"）、f4f1d8a4/ad7109d1（金会话内语句级漏抽——现在靠孪生侥幸救回，孪生措辞稍有偏差即失败）、46a3abf7（计划态 vs 已完成的时间状态建模，event_time/生命周期）。

关键文件：`C:/Users/SZU1/Desktop/edgelore/src/agent/retrieval.ts`（软 scope ×3 实现，154/211 行注释）、`C:/Users/SZU1/Desktop/edgelore/src/agent/runtime.ts`（retrievalContext 维度成员 scope 回退，328-351 行）、`C:/Users/SZU1/Desktop/edgelore/benchmark/longmemeval/data/memory.db`。