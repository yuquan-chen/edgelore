# 阶段 2 全部 47 道错题逐题解剖

> 2026-09-20 · 三路并行取证（多会话 21 题 / 时间推理 13 题 / 其余 13 题），全程本地只读
> 合成结论见文末

---

# 阶段 2 多会话（multi-session，非 _abs）错题解剖报告

分片：stage1-ids.txt 固定 100 题中 question_type=multi-session 且非 _abs 且 verdict=0，共 **21 题**（该能力 4/25=16%）。管道：forensics-lib.cjs 打分器已对照 src/agent/retrieval.ts 逐行核验（bigrams/空格折叠、statementText=assistant前缀+key+JSON.stringify(value)+unit、F1=2·cov·prec/(cov+prec)、k=10、48 行/维度 8 条目/时间序渲染器），先在 3 题上验证再批量跑。库=memory.db（8402 语句/5657 维度），只读 DatabaseSync。

## 1. 逐题表

| qid | 金标(≤40) | 我们的答案(≤40) | refusal? | contentRate | 散key数 | goldRank旧→新 | 主因 |
|---|---|---|---|---|---|---|---|
| 6d550036 | 2 | Based on your history, the latest recorded | no | 1.0 | 29 | 39→36 | b 散账（+未来污染） |
| aae3761f | 15 hours for getting to the three destin | I don’t have that information — I have no | soft | 0.5 | 31 | 128→13 | a 抽取漏 |
| 46a3abf7 | 3 | You have **2 tanks** right now: | no | 0.0 | 27 | 196→43 | d 推理（污染项带偏） |
| 36b9f61e | $2,500 | 不知道具体金额。我只记得你有“每隔几个月 | soft | 1.0 | 24 | 26→1 | b 散账 |
| gpt4_e05b82a6 | 10 times | You rode rollercoasters **9 times** across | no | 0.5 | 35 | 71→1 | b 散账（碎片化） |
| 2b8f3739 | $495 | Based on your recorded market sales, the to | no | 0.0 | 28 | 21→35 | d 推理（污染项带偏） |
| 81507db6 | 3 | You attended **2 graduation ceremonies** in | no | 1.0 | 29 | 262→1 | a 抽取漏 |
| a11281a2 | 100 | Based on my memory, I don’t have a record o | soft | 0.0 | 24 | 41→2 | **c attractor（可抢回）** |
| 4f54b7c9 | 5 | 根据记忆，你从家人那里继承/获得的古董/传 | no | 0.0 | 16 | 296→4 | d 推理（污染项带偏） |
| a4996e51 | 50 | During peak campaign seasons, you work **45 | no | 0.0 | 15 | 6→1 | b 散账（+污染基底） |
| 681a1674 | 2 | You re-watched **4 MCU movies**: the ones y | no | 1.0 | 11 | 4→1 | a 抽取漏 |
| 4adc0475 | 5 | I don’t have that specific stat. My memory | soft | 1.0 | 22 | 184→1 | f 数值不可达 |
| 4bc144e2 | $65 | I don’t have any record of a parking ticket | soft | 0.0 | 8 | 450→354 | a 抽取漏 |
| 8979f9ec | 8 meals | 不知道。我的记忆里没有记录你从鸡肉法士达 | soft | 0.0 | 13 | 1→3 | a 抽取漏 |
| a96c20ee | Harvard Universit | The memory doesn’t specify which university | soft | 1.0 | 20 | 297→2 | c* dim进屏但条目被截 |
| ef9cf60a | $300 | Based on your notes, you’ve mentioned two s | no | 0.0 | 7 | 978→8 | b 散账 |
| d6062bb9 | 1,998 | I don’t have any view counts or analytics d | soft | 0.5 | 17 | 2→19 | f 数值不可达 |
| 157a136e | 43 | 我记得奶奶现在是 75 岁，但记忆里没有明确 | soft | 0.0 | 19 | 694→84 | a 抽取漏 |
| c18a7dc8 | 7 | 不知道，因为记忆里没有你大学毕业的年龄或 | soft | 0.0 | 18 | 1175→60 | a 抽取漏 |
| 55241a1f | 33 | I don't know. My memory only contains gener | soft | 0.0 | 16 | 3→12 | f 数值不可达（12条评论新排名#22差2位） |
| 37f165cf | 856 | 不知道。我的记忆里没有关于你在1月和3月读 | soft | 0.0 | 11 | 15→10 | a 抽取漏 |

refusal 列：严格 `hypothesis==="不知道"` 为 **0/21**（本题组无一输出精确拒答标记）；soft 拒答（"I don't have…"/“记忆里没有…”）= **12/21**。

关键取证事实（支撑主因判定）：
- **a 抽取漏（8 题）**：aae3761f 的"drove six hours to Washington D.C."全库 0 命中（Outer Banks 4h、Tennessee 5h 均已抽出）；81507db6 的"colleague Alex's graduation（leadership development program）"0 命中（仅另一位形 whose cousin Alex 工程学毕业）；681a1674 的"re-watch"全库 0 命中（只有误导性的 recentlyWatchedMovies 4 元素列表 + 污染的 mcuMarathon"22 部"→模型恰好答 4）；4bc144e2 停车罚单 $50 全库 0 命中；8979f9ec 的"This is the third meal"计数未抽出（leftoverIngredients 无数量；5-lunches 已抽出）；157a136e 自己金会话里的"do you think 32 is…"未抽出（userAge=32 只存在于别的题的会话 answer_c8cc60d6/991d55e5）；c18a7dc8 的"completed at the age of 25"全库 0 命中；37f165cf 的 416 页全库 0 命中（440 页倒存在于别题 2311e44b 的会话里）。
- **b 散账（5 题）**：6d550036 项目事实碎在 29 个 key（marketingResearchExperience 新#36），模型实际引用的是**未来**的 paintingProjectCount="5"@2023-10-09（answer_da72b1b4，他题会话）；36b9f61e 三个金额（800/500/1200）排名 5946/3094/8087，任何词面打分都够不着；gpt4_e05b82a6 的 Xcelerator 被拆成 xceleratorRideDate="October 8th"+xceleratorFavorite 两碎片（3157/6330），模型 3+3+3=9 漏掉第 10 次；a4996e51 的基底"userTenure=40 hours per week"@金会话排名 5208/2650，模型用了**未来** workHours"9am-5pm 午休 12-1"=35h→45；ef9cf60a 的 $200 项链进屏（新#8 dim 整块渲染）但 $100 spa 卡在 sisterBirthdayGiftCard 新#46 出不了屏，模型还混入了他形的 $75 耳环。
- **c（2 题）**：a11281a2 两个前提都抽出（"started with 250"旧#482→新#2；"350 after two weeks"旧#1130→新#8），新屏渲染模拟确认两行都在 48 行预算内 → stage2b 可抢回。a96c20ee 的 Harvard 语句（userEducation，新#4）虽使其 dim 进屏，但该 dim 28 条目、时间序只渲染前 8 条（2016-2023/05/20，多为他人形），Harvard@05-23 被截掉 → ** rescoring 抢不回**，需修渲染。
- **d 推理（3 题）**：生产（hybrid，向量路）把金料送进了屏——模型逐字引用了金内容（46a3abf7 的 guppies/1-gallon/20-gallon 明细、2b8f3739 的 $225/$120/$150、4f54b7c9 的全部 5 件传家宝）——但分别混入污染项：tankUpgrade"upgraded from 10-gallon to 20-gallon"（他题 answer_3e5fea0e，导致误判 5-gallon 被升级掉→2 缸）、farmersMarketSales="420"（他题 answer_c9f5693c@**2023-09-30 未来**→$915）、crystalChandelierAcquisition（他题 answer_0b4a8adc@2023-03-04→6 件）。
- **f 数值不可达（3 题）**：证据是纯数字值（'soccerGoalsScored "3"'、'tiktokVideoViews "1456"'、'youtubeTutorialViews "542"'/'"21"'），与问题词面几乎零重叠——数字本身永不贡献 bigram。F1 把 1456 从旧#4629 拉到新#276，仍进不了 top-10；55241a1f 的"12 comments…"新#22 已是最近的一题。这是纯词面打分的结构性盲区，新旧都无解。

## 2. 失败模式分布

| 主因 | 题数 | 占比 | 题号 |
|---|---|---|---|
| a not-in-lib（抽取漏） | 8 | 38% | aae3761f, 81507db6, 681a1674, 4bc144e2, 8979f9ec, 157a136e, c18a7dc8, 37f165cf |
| b scattered（在库但散/稀释出屏） | 5 | 24% | 6d550036, 36b9f61e, gpt4_e05b82a6, a4996e51, ef9cf60a |
| c attractor（F1 能进屏） | 2 | 10% | a11281a2（真可抢回）， a96c20ee（dim 进屏但条目被截，不可抢回） |
| d reasoning（污染项带偏） | 3 | 14% | 46a3abf7, 2b8f3739, 4f54b7c9 |
| e judge-noise | 0 | 0% | —（21 题中无实质等价被判错） |
| f other（数值证据词面不可达） | 3 | 14% | 4adc0475, d6062bb9, 55241a1f |

## 3. 能力级结论

瓶颈排序（对多会话 16% 的贡献从大到小）：
1. **抽取层漏事实（8/21）**——模式高度一致：长 user turn 顺带一提的自事实（"this is the third meal"、"416-page novel"、"at the age of 25"、"re-watched X"、"six hours to D.C."、Alex 毕业、"32 is young or old"、$50 罚单）在抽取时随 turn 主话题（菜谱/认证/读书）流失。检索怎么改都救不回。
2. **跨形污染（系统性，直接制造 3 题 d + 为 ≥3 题供错数）**——938 会话池化进单库、通用 key（userProject/sisterBirthdayGift/userEducation/recommendedStrategies）跨形同名碰撞，且含未来日期语句（至 2023-12）；模型的"latest accepted"偏置+prompt 里的 Today 行挡不住。
3. **巨型 dim + 8 条目时间序截断**——recommendedStrategies 273 条、userEducation 28、recommendedRecipes 28、userBakingHistory 15：正确 dim 拿到屏位后，决定性条目（时间序靠后、多为本人新会话）被前 8 条（多为他人旧条目）挤出渲染。
4. **数值证据词面不可达（3 题）**——计数/金额类答案的载体是'key "纯数字"'，任何纯词面打分都结构性够不着。

**stage2b（换 F1 词面打分重跑）预计能抢回：1 题（a11281a2），乐观 2 题。** 理由：唯一一题两前提都抽出且新打分双双进屏、渲染模拟确认两行都落在 48 行预算内（250@新#2、350@新#8 → 100）；a96c20ee 虽 dim 进屏（新#4/#1）但 Harvard 条目被 28 条目 dim 的 8 条截断，重跑无效。其余 19 题在 a/b/d/f 四类，均不因打分函数改变而翻盘（b 类金额/碎片新排名 3000-8000；f 类最好 276；d 类内容已在生产屏内仍错）。即多会话 16%→约 **20%**（5/25），+4pp。另注意 2 题（d6062bb9 旧#2→新#19、2b8f3739 21→35）F1 反而退步，屏面内容变化有轻微回归风险（当前内容均非决定性，预计无损）。

## 4. 新发现的问题（脚本之外）

1. **“多会话”多数实为单会话多跳**：21 题中 13 题的 answer_session_ids 只覆盖 1 个会话（4-5 个 turn），失败更接近"session 内多跳聚合"而非跨会话检索——分组渲染已缓解散账，但计数题仍需把多个 key 的数字对齐。
2. **contentRate 对派生答案失真**：14/21 金标是计算值（8、$495、43…），逐字内容词必然 0；本报告的主因判定以“前提事实逐条在库检查”为准（表列 contentRate 仅按任务口径原样报告）。
3. **模型引用了词面屏里不存在的内容**（如 gpt4_e05b82a6 引用 Mako/Kraken/Manta 而旧词面屏全为 attractor）：生产 stage2 实际跑 hybrid（向量路经 RRF 送料）。因此“词面排名 k 外”≠“模型没看到”；本报告 d 类判定均以模型答案逐字引用了金内容为证。stage2b 若只改词面分，向量路行为不变。
4. **拒答标记失灵**：answer 层的 abstain 判定是精确串"不知道"，但模型实际输出的是解释性拒答（12/21 无一精确命中），abstain 计数低估真实拒答率；若 judge 对解释性拒答更宽容，这 12 题存在判分波动面（本次 0 命中 e 类，但 judge-noise 风险集中在此）。
5. **污染语句可被"state=accepted+更晚日期"加权**：6d550036 模型明说"latest recorded number…accepted entry from 2023-10-09"——治理层（state/时间窗）未参与答题层过滤，是污染见效的放大器。低成本修复方向：ask 时按 question-date 过滤 created_at 晚于 Today 的语句，或对非本形会话降权。

脚本（复现用，均只读）：`C:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\shard-multisession.cjs`（批量解剖）、`fact-check.cjs` + `verify-round2.cjs`（事实在库/严格渲染/精确排名）、`dump-sessions.cjs`（金会话原文）。中间产物：`C:\Users\SZU1\AppData\Local\Temp\shard21.json`、`briefs.txt`、`facts.txt`、`verify2.txt`。

---

解剖完成，全部 13 题证据链已闭环。以下为最终报告。

---

# LongMemEval Stage2 时间推理（temporal-reasoning）错题解剖报告

**方法**：只读打开 `C:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\data\memory.db`（DatabaseSync readOnly，14,059 节点 / 8,402 语句 / 5,657 维度）。打分器逐行复刻 `C:\Users\SZU1\Desktop\edgelore\src\agent\retrieval.ts`（bigrams 去全部空白→字符 bigram 集合；statementText = speaker前缀+key+JSON.stringify(value)+unit；旧=containment hits/query，新=F1）。屏模拟复刻 `runtime.ts retrievalContext`：top-10 语句→所在维度整组渲染，每组 created_at 升序前 8 条 + 48 行预算。先在 3 题上验证管道再批量。脚本：`C:\Users\SZU1\AppData\Local\Temp\lme-forensics.cjs`、`screen-sim.cjs`、`final-ranks.cjs`。

## 1. 逐题表

| qid | 金标(前40) | 我们的答案(前40) | refusal | contentRate | 散key数* | goldRank 旧→新 | 主因 |
|---|---|---|---|---|---|---|---|
| gpt4_2655b836 | GPS system not functioning correctly | 第一次保养(3/15)后的问题是 spongy br | 否 | 50% | 85 | #25→#1 | (b) 金证据 gpsIssueDate="3/22" 词面不可达(NEW #5456)；hybrid 向量路由召回跨题污染 e28c1f0d/e 的自行车 spongy brakes(3/19)，模型当成了汽车问题 |
| gpt4_76048e76 | bike | 2月先照顾的是汽车：2/3洗车、2/10保养 | 否 | 100% | 120 | #181→#18 | (b) bikeRepairDate="mid-February" NEW #18 差 8 名进屏；所用 2/3、2/10 日期来自他题 answer_9ef115d4_1 污染（真值 carWashDate=2/27 在库） |
| 982b5123 | Five months ago | 提前三个月订、行程5/10-14，约三个半月前 | 否 | n/a(0内容词) | 0 | #223→#3 | (a) 决定性锚点“恰好两个月前去过SF”从未入库（只抽到 booked three months in advance，NEW #3 在屏），行程日期是幻觉补全 |
| gpt4_9a159967 | United Airlines | Spirit Airlines（三月春假往返） | 否 | 100% | 38 | #20→#22 | (a) 三、四月的乘坐次数事实（United 3月芝加哥 4 程、Southwest、American）全部未抽取；唯一代理证据 userHabit 20k miles 在 userHabit 大键 38 条中排第 15 位（截断）且 NEW #27 |
| gpt4_4cd9eba1 | one week | 不知道（无录取日期） | **是** | n/a | 0 | #182→#1 | (b) 两个锚点都在库（accepted March 20 + orientation since 3/27），但录取语句埋在 userPlan 全局大键 46 条的第 10 位（前8截断）、NEW #290；orientation 虽 NEW #1 进屏也无从计算 |
| 6613b389 | 2 | Rachel 5/15 订婚，但记忆里没有结婚纪念日 | 部分 | n/a | 0 | #16→#4 | (b) 两个日期都在库（friendEngagementDate="May 15th"、weddingAnniversaryDate="July 22nd"）；NEW 屏只进 anniversary(#8) 不进 engagement(#2246)——生产 hybrid 反过来只进了 engagement，永远缺一角 |
| gpt4_78cf46a3 | Receiving the new phone case | 无充电器丢失的记忆，无法比较 | 部分 | 67% | 109 | #518→#3 | (a) phoneCaseAge="about a month ago" 在库，但充电器丢失的“about two weeks ago”时间状语被抽取丢弃（userGoal 只剩 "Buying a new phone charger after losing old one at the gym"，NEW #3 进屏也无法定序） |
| gpt4_a1b77f9c | 2+4+2 = 8 weeks total | 不知道（无阅读时长记录） | **是** | 29%** | 77 | #17→#2 | (a) 6 个锚点缺 1：Nightingale 起读日(1/1 会话)未抽取（只有 1/15 的 currentBookReading）；Sapiens 对(2/1→3/1)与 Power 对(3/6→3/20)在库但分散 |
| 4dfccbf7 | 24 days | 不知道（无尤克里里开课日期） | **是** | 0% | 42 | #209→#95 | (b) 两锚点都在库且带会话日期（ukuleleLessonsStarted @02/01、guitarServiced @02/25），但查询插入词破坏 bigram 邻接（"started taking ukulele lessons"），NEW 仅 #95/#2412 |
| gpt4_e061b84f | Triathlon→5K Run→charity soccer | 三项铁人内部顺序 swim→bike→run | 否 | 67% | 389 | #442→#53 | (b) 三个赛事语句全在库带日期(@06/02、06/10、06/17)但 NEW 均 >500；hybrid 只送进铁三碎片，模型把问题误读为铁三内部阶段顺序 |
| gpt4_f420262c | JetBlue, Delta, United, American | 只确认 American(2/10)；Spirit 订票未乘 | 否 | 100% | 78 | #131→#1 | (b) 4 段航程散在 4 键 5 会话；NEW 屏只进 American+Spirit，JetBlue #105、United #47 全出屏；Delta 仅剩 SkyMiles 余额 |
| gpt4_e061b84g | The company's annual charity soccer tournament | 与同事的 recreational soccer game，进了一球 | 否 | 100% | 86 | #813→#28 | (b) 金语句 charityEventParticipation @06/17（=题目日期前两周，created_at 精确命中）在全局合并键 12 条中排第 10 位被前8截断；所答内容来自他题 a25d4a91_1 的 "scored a goal" 污染 |
| gpt4_fa19884d | a bluegrass band that features a banjo player | 那天我推荐了 Bill Monroe、Earl Scruggs… | 否 | 60% | 118 | #527→#193 | (a) 本题会话的“发现蓝草班卓乐队”事实抽取丢失（只剩推荐列表）；库里唯一副本来自孪生题会话 ff201786_2，NEW #5352 不可达 |

\* 散key数按简报定义（金标内容词命中的全库不同 key 数），含大量泛词噪声（如 "system" 命中 85 键）；决定性语句的 key 分布见主因列。
\** tokenizer 对书名引号切分有伪影，数值偏低。

## 2. 失败模式分布

| 主因 | 题数 | 占比 | 题目 |
|---|---|---|---|
| (a) not-in-lib（抽取丢关键锚点） | **5** | 38% | 982b5123、gpt4_9a159967、gpt4_78cf46a3、gpt4_a1b77f9c、gpt4_fa19884d |
| (b) scattered（在库但出屏/被大键截断/被污染顶替） | **8** | 62% | 其余全部 |
| (c) attractor（F1 可抢回） | **0** | 0% | — |
| (d) reasoning | 0 | 0% | — |
| (e) judge-noise | 0 | 0% | — |
| (f) other | 0 | 0% | — |

严格拒答（==="不知道"）3 题；部分拒答 2 题。注意：**时间题零推理错、零判分错**——模型拿到成对日期锚点时算术全对（答对的同型题可证）；982b5123 的“日期算错”实为上下文缺失后的幻觉补全，不是算术能力问题。

## 3. 能力级结论

**瓶颈排序**：
1. **抽取层丢时间锚点（5/13=38%）**。时间推理题的答案链需要 2-6 个日期锚点，链条对单点丢失零容错。丢失模式固定：相对时间状语（"about two weeks ago"、"exactly two months ago"）和“今天做了X”式的起点事件被压缩成无时间值或整句丢弃。
2. **检索可达性（8/13）**，三个结构性机制叠加：
   - **全局 key→单 dimension 节点合并 + 渲染 oldest-first 前 8 截断**（见第 4 节）：userPlan 录取语句 10/46、userHabit 20k-miles 15/38、charityEventParticipation 锦标赛 10/12——三条金语句即使维度进屏也看不见；
   - **长查询-短语句 bigram 邻接断裂**：F1 对修 attractor 有效，但对“查询比证据多几个词”型失配无能为力（4dfccbf7 NEW #95、e061b84g 金语句 #28）；
   - **OLD 打分的屏是纯噪声**：13/13 题的 OLD top-10 几乎全被全局推荐列表（movie/music/book recommendations）占据，金维度进屏率 OLD 1/13 vs NEW 8/13——F1 大幅改善“进屏”，但 13 题中没有任何一题把**完整的决定性证据集**送进屏。
3. **跨题污染（比检索不中更危险）**：4 题实锤 stage2 答案内容来自其他题目的会话（spongy brakes←answer_e28c1f0d/e；2/3、2/10 洗车保养←answer_9ef115d4_1；scored-a-goal←answer_a25d4a91_1；Spirit←answer_d8a1af6b_3），由 hybrid 向量路由召回。它把“应拒答/检索失败”转化为“高置信度错误答案”。

**stage2b（F1 重跑）预计抢回：0 题（区间 0-1）**。13 题中没有任何一题在新打分 k=10 下补齐全部决定性证据：5 题 (a) 缺库、8 题 (b) 中最好情形也缺角（6613b389 只进 anniversary 不进 engagement；e061b84g 维度进了但语句被截断）。F1 把 goldRank 中位数从 ~#200 拉到 ~#4，但决定性语句本身词面太弱（"3/22"、"May 15th" 与问题几乎零 bigram 重叠）。**若 stage2b 同时把 k 提到 ~30**，76048e76（bikeRepairDate NEW #18）大概率翻成"bike"，9a159967（#27）进屏但只有 20k-miles 弱证据、答对属猜测——即 k=30 下预期 +1 题。单独换 F1 的期望收益 ≈ 0。时间推理题的杠杆在抽取层（时间锚点保全）与渲染层（大键截断策略/全局键隔离），不在词面打分。

## 4. 新发现（取证脚本之外）

1. **key 全局唯一维度节点**（实测 5,657 key → 5,657 dim 节点，**0 个 key 拥有多节点**）：100 题的全部会话抽进同一个库后，所有同名 key 的语句合并进同一维度节点。后果：(i) 分组头计数对单题失真（"charityEventParticipation — 12 entries" 实为 10 个不同题用户的慈善事件）；(ii) oldest-first cap-8 系统性隐藏近期事实（3 个金语句分别排在第 10、10、15 位全部被截）；(iii) userHabit/userPlan/userGoal/userEvent/recommendedStrategies 等通用 key 成为跨题熔池——这是 (b) 类 8 题的共同底层机制。修法方向：维度键加会话/主题作用域，或渲染截断改 newest-first/相关性排序。
2. **LongMemEval 孪生会话双份入库**（ff201786/ff201787、8c64ce25/8c64ce26、4bebc782/4bebc783、d8a1af6b/d8a1af6c 等）：同一事实在库里有“金会话副本”和“别题副本”，叠加全局键后互相污染排序（fa19884d 的金事实只存在于孪生副本中）。
3. **value="today"/"3/22"/"mid-February" 类相对值**依赖渲染器的 [@date] 后缀才能解析——当前渲染带日期所以未爆雷，但抽取时把绝对日期写进 value（或 attributes）会彻底消除风险。
4. **OLD containment 的全局 attractor 名单**已锁定（movieRecommendationsSimilarToAvengersEndgame、musicRecommendations、bookRecommendations、bookstagramTips、socialMediaPromotionTips 等超长推荐列表语句），它们在 13 题的 OLD top-10 里反复出现——可作为回归测试的固定负例集。

---

# 长记忆解剖（LongMemEval）第二阶段分片：single-session-assistant (4) / knowledge-update (7) / single-session-preference (2)，共 13 道错误题目

流水线已验证：`benchmark/longmemeval/shard-misc-anatomy.cjs` + `forensics-lib.cjs`，与生产环境代码 `src/agent/retrieval.ts` 在第二阶段运行时 commit (8898eb1) 的评分/渲染逻辑逐字节一致（旧模型 = 包含度；新模型 = F1；`statementText` = assistant-prefix + key + `JSON.stringify(value)` + unit；screen = k=10 命中语句的维度，分组渲染，最大 8 条/维度，最大 48 行）。分片问题数量已确认 = 13 个 (KU 7 / SA 4 / SP 2)。

## 1. 逐题表

| qid | 金标(前40) | 我们的答案(前40) | refusal? | contentRate 金会话/全库 | 散key数 | goldRank 旧→新 | 主因 |
|---|---|---|---|---|---|---|---|
| 945e3d21 (KU) | Three times a week. | …attend yoga classes **weekly** (accepted 2023-11-03) | 否 | 100%/100% | 2 | 669→1 | **d** 状态策略错（见下） |
| 9ea5eabc (KU) | Paris | …most recent family trip was to **Hawaii** | 否 | 100%/100% | 1 | 785→64 | **b** 被~100个 *trip* 维度稀释 |
| 2698e78f (KU) | every week | 你每两周见一次 Dr. Smith… | 否 | 100%/100% | 5 | 20→2 | **c** attractor（旧值占屏） |
| 59524333 (KU) | 6:00 pm | …周二周四 6:30pm Zumba、周六 10am… | 否 | 100%/100%* | 3 | 84→70 | **a** 金事实未入库 |
| 9bbe84a2 (KU) | level 100 | 我不知道。我的记忆里只有…沟通技巧… | 软拒答 | 100%/100% | 4 | 194→1 | **c** attractor |
| dad224aa (KU) | 7:30 am | I don't have a recorded wake-up time for Saturday… | 软拒答 | 50%/100% | 4 | 56→15 | **a** 更新值未抽取+错值入库 |
| 0977f2af (KU) | Instant Pot | You got the stand mixer a few weeks before… | 否 | 100%/100% | 5 | 291→54 | **f** 语义鸿沟 |
| 16c90bf4 (SA) | I recommended using a Pilsner or Lager… | You specifically recommended a **Pilsner**… | 否 | 60%/80% | 4 | 2223→2252 | **a** "or Lager" 抽取丢失 |
| 35a27287 (SP) | …prefers events to practice their language… | …attending a music festival this coming weekend… | 否 | 20%/100% | 1† | 4188→1183 | **b** 偏好碎片散落 |
| 07b6f563 (SP) | …accessories compatible with an iPhone 13 Pro… | …车载手机支架、无线充电板、旅行收纳… | 否 | 29%/100% | 8 | 983→1929 | **b** 8个配件 key 稀释 |
| e9327a54 (SA) | The Sugar Factory at Icon Park. | …matches "giant milkshakes"… **Sugar Factory**… | 否 | 100%/100% | 3 | 22→82 | **e** judge-noise |
| 8cf51dda (SA) | …1) identify molecular subtypes…2) clinical and biological… | 1. Identify molecular subtypes… 2. …therapy response… | 否 | 79%/100% | 4 | 8→1 | **a'** 抽取转写漂移 |
| ac031881 (SA) | …designation on your jumpsuit was 'LIV'. | I don't have a specific memory about a jumpsuit… | 软拒答 | 33%/33% | 2 | 3266→628 | **a'** 关联词丢失 |

\* 59524333 全库 100% 是假象："6"/"00"/"pm" 命中的是无关语句（Sunday yoga 6:00 PM）；gym 时间 6:00 pm 本身从未入库（gymSchedule 只存了星期）。
† 35a27287 的散 key 按子串命中是 1 个（learningResources 55 条），但真正的偏好成分散在 languageExchangeTutor/Format/TutorMaria/spanishLearningResources 等多个 key。

精确拒答（"不知道"）= 0；实质软拒答 = 3（9bbe84a2、dad224aa、ac031881）。

## 2. 失败模式分布

| 主因 | 题数 | 占比 | 题目 |
|---|---|---|---|
| (a) 不在库/抽取损失（含 a' 漂移/关联丢失） | 5 | 38% | 59524333, dad224aa, 16c90bf4, 8cf51dda', ac031881' |
| (b) scattered / 同概念 key 稀释出屏 | 3 | 23% | 9ea5eabc, 35a27287, 07b6f563 |
| (c) attractor（旧打分屏外、F1 进屏） | 2 | 15% | 2698e78f, 9bbe84a2 |
| (d) reasoning（状态策略压过日期） | 1 | 8% | 945e3d21 |
| (e) judge-noise | 1 | 8% | e9327a54 |
| (f) other（query 词表与库内零交集） | 1 | 8% | 0977f2af |

## 3. 能力级结论

瓶颈排序（本分片）：
1. **抽取保真度（5/13）是第一瓶颈，检索调优无法触及**：值丢失（"or Lager"、gym 6:00 pm、Saturday 7:30 am）、转写漂移（"clinical and biological significance"→"clinical significance and therapy response"，模型忠实复述了被污染的 `grantsAimPageObjectives`，而屏内 `grantsAimPageContent` 反而存着正确值）、关联丢失（"jumpsuit designation" 两词全库为 0，LIV 孤悬在 `userIdentity`/`userProject`）。
2. **维度爆炸稀释（3/13）是第二瓶颈**：`europeTripDestinations="Paris"` 被 ~100 个 trip 维度淹没（F1 后仍 rank 64）；偏好题的成分散在 8+ 个 key。F1 救不了 rank 100+ 的题。
3. **全局 attractor 占屏（旧打分）**：`movieRecommendationsSimilarToAvengersEndgame`、`musicRecommendations`（11 条、含重复值）、`recommendedStrategies`（273 条）几乎出现在每题的旧屏里——F1 正是为此设计的，本分片 2 题直接受益。
4. 状态策略（1）、judge 噪声（1）、语义鸿沟（1）各占一题。

**stage2b（换 F1 重跑）预计抢回：2 题** — 2698e78f（rank 20→2：旧值 "every two weeks" 压在 2 个长 key 上霸屏，新值 "every week"/"weekly" 短值被 F1 提到 rank 2，屏内再按 rule 3 取最新 accepted @11/03 即金标）和 9bbe84a2（rank 194→1：`apexLegendsLevelGoal=100` 短语句登顶，且 `apexLevelGoal=150` 同屏，"previous goal" 按日期可比出 100）。

**关键警告——1 个假抢回**：945e3d21 lexical rank 669→1 看似 (c)，但生产混合检索（vector 路）当时已把金料送进屏内——模型答案里逐字引用了 "three times a week (tentative @11/30)" 和 "weekly (accepted @11/03)"，却按 prompt rule 3（“LATEST ACCEPTED entry is current truth”）选了 accepted 的旧值。stage2b 改变不了这个结局，**不要把 rank 类指标直接当抢回数**，本分片因此打 9 折（3→2）。

## 4. 新发现的问题（脚本之外）

1. **状态-日期倒挂是知识更新的系统性炸弹**：抽取把较新值标 tentative、较旧值标 accepted（945e3d21：tentative "three times" @11/30 vs accepted "weekly" @11/03），rule 3 又强制模型信 accepted——两条规则叠加 = 按设计答错。修法：rule 3 加“日期更新的 tentative 可推翻较旧的 accepted”，或抽取时状态对齐时间序。
2. **跨 key 冲突是冲突检测的盲区**：`gymSchedule="Mondays, Wednesdays, and Fridays"`(@05/30) 与 `gymDays="Tuesdays, Thursdays, Saturdays"`(@06/01) 直接矛盾，但冲突裁决只在同 dimension 内看 `siblings`——事实被拆到两个 key 后就免检了。这正是“key 散账”最大的隐性代价。
3. **组渲染截断取最旧**：`runtime.ts` `retrievalContext` 按时间升序排序后执行 `members.slice(0, 8)`——`>8` 条的维度（`userSchedule` 13、`learningResources` 55、`recommendedStrategies` 273）屏内显示的是**最旧**的 8 条，知识更新类最需要的最新值恰好在被裁掉的那段。头部计数虽在，但值全过期。建议对时间取尾部或双端保留。
4. **重复入库**：`musicRecommendations` 中同一 Phoebe Bridgers/Tove Lo 列表各存 2 条（同日期）、`standMixerGift`、`tripodPurchaseYear=2018`、`travelInsuranceRecommendation` 等也有重复——既虚增头部计数，也浪费 48 行预算。
5. **saidBy 误标**：`beerChoiceForSeco="Pilsner"` 实为 assistant 原话（"a pilsner or lager would work well"）却存成 `saidBy=user`，丢失 "assistant: " 检索前缀和 "(assistant)" 上下文署名——助手题（4 题分片）的署名行本身依赖抽取正确标 saidBy，本题说明该信号已部分失真。
6. **偏好题的元偏好丢失**：两道 SP 题金标都是“元偏好”句式（"user would prefer…"），抽取只存了成分（品牌清单、语伴安排），没存偏好本身（金会话 contentRate 仅 20%/29%）——answer 层拿到成分也难以重构“按偏好筛选”的行为。

---

## 合成结论（三路汇总）

### 失败模式分布（47 题）
| 主因 | 题数 | 占比 |
|---|---|---|
| 抽取漏/丢（a：事实、数字、时间锚点没进库） | 18 | 38% |
| 散账/截断/稀释（b：在库但出屏——多 key 拆散、巨型 key oldest-first 截断、维度爆炸） | 16 | 34% |
| attractor（c：F1 可抢回） | 3 | 6% |
| 污染/推理（d：跨题会话污染带偏 + 状态策略压过日期） | 4 | 9% |
| 数值不可达/语义鸿沟（f：纯数字语句与问题零词面重叠） | 4 | 9% |
| 判分噪声（e） | 1 | 2% |

### stage2b（仅换 F1 打分重跑）预期：+3~4 题 → 53%→56-57%
多会话 +1~2、时间推理 0、其余 +2（已扣除 1 个假抢回）。

### 新发现的系统性问题（按杠杆排序）
1. **全局 key 池化（benchmark 特有）**：100 题的不同虚拟用户共用单库，userPlan/userHabit/recommendedStrategies 等通用 key 成为跨题熔池（charityEventParticipation — 12 entries 实为 10 个不同用户的事件），oldest-first 截断系统性隐藏近期事实 → 修法：scope 隔离（M0 预留了 project_id）或按题分库
2. **状态-日期倒挂**：较新值 tentative、较旧值 accepted + rule 3 强制信 accepted = 按设计答错 → rule 3 补「日期更新的 tentative 可推翻较旧 accepted」
3. **渲染截断取最旧**：>8 条的维度显示最旧 8 条，最新值恰好被裁 → 改 newest-first
4. **跨 key 冲突盲区**：gymSchedule 与 gymDays 直接矛盾但免检（冲突检测只看同维度）→ 别名合并的另一论据
5. **数值证据词面不可达**：「key: 纯数字」与问题零 bigram 重叠 → statementText 纳入维度 description
6. 抽取保全：相对时间转绝对日期、量词/时间不剥离、元偏好句式
