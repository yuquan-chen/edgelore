# stage3 全量 500 题错题解剖（129 道，四分片）

> 2026-09-21 · 四路并行解剖（多会话41 / 时间+拒答30 / 助手+偏好37 / 知识更新+用户21），全程只读
> 合成结论见文末

---

# 分片一：多会话（41 题）

# LongMemEval stage3（full500，v3 库）多会话错题解剖报告

分片确认：`question_type='multi-session'`、非 `_abs`、verdict=0 → **41 题**（该类型共 121 题，本轮对 80 题，66.1%；全量 500 题均分 74.2%）。本轮 run = `answer-meta-full500.json`（tag=full500，2026-09-20T14:17Z，k=10，deepseek-v4-flash-0731），verdict 键与 `hypotheses-full500.jsonl` 哈希 500/500 匹配。全程只读（node:sqlite readOnly），脚本在 `C:/Users/SZU1/AppData/Local/Temp/lme-analysis/`（load/analyze/check/verify/final.js）。

contentRate = 金标内容词（去停用词）在金会话语句（key+value）覆盖率；数字型金标（如 "3"）词覆盖率无意义，改用**分项在库率**（我在表中以 `分项k/n` 标注）校准。散key数 = 承载金标分项的 distinct dimension key 数。

## 1. 逐题表

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | contentRate | 散key数 | 主因 |
|---|---|---|---|---|---|---|
| 0a995998 | 3 | 1 件（Zara靴）；干洗店不算店 | 答(误) | 分项2/2 | 4 | d 语义过严("干洗店≠store") |
| gpt4_59c863d7 | 5 kits | 4 个 | 答 | 0.67 分项5/5 | 11 | b Tiger I 在库(中文"虎I坦克")未聚合 |
| e831120c | 3.5 weeks | 重叠算=2周；和=3.5周但主答2周 | 答 | 0*(推导值) | 3 | d 选错语义(该求和却取日历重叠) |
| 3a704032 | 3 | 2 盆；蛇尾兰"可能出窗" | 答 | 分项3/3 | 7 | d 相对窗口过严(蛇尾兰 last month) |
| gpt4_d84a3211 | $185 | 只有车灯$40 | 答 | 分项3/3 | 12 | b 头盔$120/链条$25在库未召回(40+条语句挤爆k=10) |
| aae3761f | 15h | 9h(2地)；第三地无车程记录 | 答+部分拒 | 0.25 分项2/3 | 4 | a DC 6h车程整句抽取丢失 |
| gpt4_f2262a51 | 3 doctors | 2 位(Smith, Patel) | 答 | 0.50 分项3/3 | 6 | b Dr. Lee(皮肤科)在库未召回 |
| dd2973ad | 2 AM | 无 5/24 睡眠记录，不知道 | 软拒 | 1.00 分项2/2 | 2 | d "凌晨2点"在库但锚定5/17，未做叙事配对 |
| c4a1ceb8 | 3 | 5 种(多算 grapefruit/yuzu) | 答 | 分项3/3 | 16 | c 把助理建议清单里的柑橘当作用户用过 |
| 46a3abf7 | 3 | 2 个缸；5加仑"曾拥有已升级" | 答 | 分项3/3 | 9 | d 源文本自相矛盾(I have vs old tank)，抽取取一边 |
| 36b9f61e | $2,500 | "没记录任何金额" | 软拒 | 1.00 分项3/3 | 5 | b 三笔($1200/$800/$500)全在库accepted，整体拒答 |
| gpt4_2f8be40d | 3 (Rachel+Mike/Emily+Sarah/Jen+Tom) | 3 场(对人名缺失，Emily合并表述) | 答 | 0.25 分项3/3* | 6 | e 场次对但人名不可得：Mike不在haystack，Tom被抽取丢 |
| gpt4_15e38248 | 4 | 3 件；无出售记录 | 答 | 分项4/4 | 10 | b 床垫在库但 dim.desc=""(空key)未召回 |
| 88432d0a | 4 | 2 次(focaccia/意式包=计划) | 答 | 分项4/4 | 13 | d 5/23酸面面包(失败也是bake)没数；5/13蛋糕出窗 |
| 80ec1f4f | 2 | 1 个；Art Cube"无日期" | 软拒(部分) | 1.00 分项2/2 | 6 | b "2023-02-15参观Art Cube"在库，日期与参观散在不同key |
| d23cf73b | 4 | 3 个方向 | 答 | 分项4/4 | 9 | b 埃塞俄比亚餐厅在库(中文)未召回 |
| gpt4_7fce9456 | 4+各弃因 | 4套(含townhouse本身)；若不含=3 | 答 | 0.32 分项4/4 | 4 | d 集合口径错：把townhouse自己算进"之前看的4套" |
| 7024f17c | 0.5 hours | 0 小时(5/20 jog 在"上周"前) | 答0(无记录) | 0* | 23 | d 严格窗口(5/22-28)排除5/20周六jog；gold按会话相对窗 |
| gpt4_2ba83207 | Thrive Market | Walmart($120) | 答 | 1.00 分项4/4 | 11 | d Thrive$150在库，被"4月出窗"排除；gold按会话相对窗 |
| 2318644b | $270 | "at least $270 more"，不承诺精确 | 答(对冲) | 0*(推导值) | 9 | d 已含270但对冲("over $300不能精确")→judge判负 |
| 2ce6a0f2 | 4 | 2 个 | 答 | 1.00 分项4/4 | 12 | b History Museum 2/24、Women in Art 2/10 在库(中文)未召回 |
| 9d25d4e0 | 3 | 2 件 | 答 | 分项3/3 | 6 | b 订婚戒指在库×2(日期还互相矛盾4/23 vs 4/29)未召回 |
| gpt4_194be4b3 | 4 instruments | 3 件(还逐条核查了鼓) | 软(部分) | 0.71 分项4/4 | 12 | b Korg B1 钢琴在库×2 未召回 |
| d851d5ba | $3,750 | $1,750 | 答 | 0.50 分项4/4 | 6 | b 动物收容所$2,000在库未召回 |
| gpt4_ab202e7f | 5 items | 4 样 | 答 | 0.63 分项4/5 | 11 | a "捐掉旧咖啡机(被替换)"事件抽取丢失 |
| gpt4_731e37d7 | $720 | $700(正念$20日期2023-12-12出窗) | 答 | 0*分项3/3 | 10 | a 原文"December 12"无年份→锚成2023(应2022)，未来日期 |
| edced276 | 15 days | 5 天；夏威夷"无天数" | 答+部分拒 | 1.00 分项1/2 | 2 | a 夏威夷"10-day"抽取丢失 |
| e3038f8c | 99 | 74；硬币"无确认数" | 答 | 0*分项4/4 | 19 | b "25 rare coins"在库accepted未召回 |
| bf659f65 | 3 | "无购买/下载记录，不知道" | 硬拒 | 1.00 分项3/3 | 8 | b EP+黑胶在库；EP语句被贴"但实际不存在"毒标 |
| 81507db6 | 3 | 2 场；Alex是"领导力项目"不算 | 答 | 分项4/4 | 4 | d 过严口径(领导力项目毕业≠graduation ceremony) |
| a11281a2 | 100 | "约100"但拒绝按两周口径孤立 | 答(对冲) | 0* | 2 | d 已算出100却对冲，被判不匹配 |
| 9aaed6a3 | $0.75 | 5/25无记录；若5/18那笔则$0.75 | 软拒 | 0*分项2/2 | 5 | d "last Thursday"按qdate锚5/25，gold按会话锚5/18 |
| e6041065 | 40% | 打包5双，"没记录穿了几双" | 软拒 | 0*分项1/2 | 2 | a "只穿了两双"被抽取改成未来计划("计划只带") |
| 3c1045c8 | 2.5 years | 不知道 | 硬拒 | 0 分项0/2 | 2 | a "32岁"与“部门平均29.5岁”双双抽取丢失 |
| ef66a6e5 | two | 1 项(网球) | 答 | 分项2/2 | 11 | b "曾大学竞技游泳”在库未召回 |
| 3fdac837 | 11 (or 12) days | 日本8天+芝加哥天数未知 | 答+部分拒 | 0*分项1/2 | 7 | a "4-day trip to Chicago”时长抽取丢失 |
| 61f8c8f8 | 10 minutes | 不知道上一年成绩 | 硬拒 | 1.00 分项1/2 | 1 | a "去年5K 45分钟”抽取丢失(35分钟在库) |
| 60159905 | three | 2 场(Alex potluck, Mike BBQ) | 答 | 分项2/3 | 2 | a "Sarah 家意大晚宴”抽取丢失 |
| 09ba9854 | $50 | 省¥17,000-27,000(≈$150-240) | 答 | 1.00 分项2/2 | 6 | c 用了助理查的交通数据(N'EX¥3,020等)，弃用户自己的$60/$10 |
| 37f165cf | 856 | "无一月/三月读完记录" | 软拒 | 0 分项1/2 | 1 | a "416页小说”(无书名)抽取丢失 |
| 21d02d0d | 2 | 1 次(3/26未标工作因) | 答 | 1.00 分项2/2* | 2 | a 单句因果"忙于工作…missed…March 26”被拆散，因丢失 |

\* 数字型/推导型金标，词覆盖率无意义。gpt4_2f8be40d 分项3/3 指3场婚礼在库，但 Mike 不在 haystack、Tom 被抽取丢。21d02d0d 两事件在库但因果属性丢失。

## 2. 失败模式分布

| 主因 | 数量 | 占比 | 上轮(100题全集) |
|---|---|---|---|
| (b) scattered 散账/检索聚合失败（内容在库没用上） | 14 | 34.1% | 3% |
| (a) not-in-lib 抽取漏/损/错锚 | 11 | 26.8% | 72% |
| (d) reasoning 推理/窗口/口径/对冲（含该答却拒） | 13 | 31.7% | 7% |
| (c) pollution 污染（助理内容压过用户账本） | 2 | 4.9% | 17% |
| (e) judge-noise | 1 | 2.4% | — |
| 跨用户(source_refs 出 haystack)污染 | 0 | 0% | — |

41 题中 34 题是 How many/How much 计数求和题。计数失败里除 1 题多算(c)外全部是**漏项**（off-by-one 或漏 $xx 分项）；无 cross-user 污染；无“该拒没拒”题（本分片金标全部实质可答，拒答失守专项不适用；反向的“该答却拒”6 题：36b9f61e、bf659f65、3c1045c8、61f8c8f8、37f165cf、e6041065）。

## 3. 能力级结论

**瓶颈排序（本轮多会话）**：
1. **散账/检索聚合 (34%)** — 单题金标分项几乎都在库（14 题中 12 题 contentRate=1.0 或分项全在），但 ask 没召回/没聚合。机制：一个金会话抽出 20-40+ 条语句（bike 题 40 条、e3038f8c 19 keys、c4a1ceb8 16 keys），k=10 与“4旧+gap+4新”分组渲染装不下全部承载 key → 枚举缺项。图给计数头没有在任何一道错题答案里被用上——计数头只能数已召回的 key，key 召回不全时无效。
2. **推理/窗口 (32%)** — 两个子型：(i) 相对时间窗口“三体”（qdate vs 会话日期 vs 语句日期）：7024f17c、gpt4_2ba83207、3a704032、9aaed6a3 四题模型按 qdate 严格开窗全都没错在数学、错在 gold 用会话相对窗；(ii) 口径过严/对冲：81507db6、0a995998、gpt4_7fce9456、2318644b、a11281a2（后两题答案已含正确数字仍被判负）。
3. **抽取 (27%)** — 从上轮 72% 大幅下降（few-shot + 日期锚点提示词起效），但残余全是“旁插从句/无书名数字/因果单句/时态翻转”类难例。
4. 污染 (5%) 与 judge (2%) 已是次要项。跨用户污染 0——软 scope 对跨账户拦截有效。

**与上轮对比的变化**：主矛盾从“库外”（抽取丢 72%）整体后移到“库内用不上”（b+d 合计 66%）。抽取修复把 (a) 压掉 45pt，但释放出的失败被 (b)(+31pt) 和 (d)(+25pt) 接管——即读路径（召回完整度+聚合）和 ask 时间窗策略成为新瓶颈。

**只能靠第 2 轮重摄入解决的（读路径修不好）**：
- 抽取保全：aae3761f(DC 6h)、3fdac837(4-day Chicago)、61f8c8f8(45min)、60159905(Sarah 晚宴)、37f165cf(416页无书名)、edced276(10-day)、gpt4_ab202e7f(咖啡机被替换)、e6041065(过去时“只穿两双”被翻成未来计划)、21d02d0d(单句因果拆散)、3c1045c8(32岁/29.5岁双丢)。
- event_time/年份锚定：gpt4_731e37d7("December 12"无年份→锚成 2023-12-12 未来)；dd2973ad("last Wednesday"歧义锚定需保留备选锚)。
- 别名/实体合并：9d25d4e0(订婚戒指 4/23 与 4/29 重复抽取)、gpt4_2f8be40d(Emily“表姐/大学室友”冲突归一——注意源文本本身矛盾)。

## 4. 新形态发现

1. **空维度描述 (dim.desc="")**：gpt4_15e38248 的 Casper 床垫等语句挂在空描述 dimension 上，无 key 可渲染/检索，直接漏项。此前未见。
2. **虚构性毒标**：bf659f65 抽取把“乐队实际不存在”（assistant 现实核查）写进用户购买 EP 的语句，疑诱发整体拒答（EP/黑胶明明在库）。
3. **助理研究数据压过用户账本** (09ba9854)：用户自己的 taxi$60/train$10（gold $50 可直接算）在库，模型却用 assistant 提供的 N'EX¥3,020 等调研数据作答——assistant 语句的 (non-user-account) 软标记+规则6 没拦住“用助理数字做计算”。
4. **助理建议清单被计入“我用过”** (c4a1ceb8)：装饰建议清单里的 grapefruit/yuzu 被算作用户用过的柑橘（3→5）。
5. **抽取时态翻转** (e6041065)：“ended up only wearing two”（过去事实）→“计划…只带运动鞋和凉鞋”（未来计划），事实彻底反转。
6. **年份缺省锚错** (gpt4_731e37d7)：裸"December 12"锚成未来年份，$20 被正确逻辑排除——错在抽取不在推理。
7. **同事实重复抽取带冲突日期** (9d25d4e0)：戒指 2023-04-23 vs 2023-04-29 两条 accepted。
8. **相对窗口系统性偏严**：4 题同型（见结论 2.i），模型统一按 qdate 开窗而 gold 按会话相对期——建议 ask 侧对 "last week/month" 类窗口叠加“会话日期相对窗”回退，可白捡约 4-5 题。

---

# 分片二：时间推理 + 拒答（30 题）

# Stage3 轮（v3 库 · 全量500）错题解剖 — 分片：时间推理 23 题 + 拒答 7 题

**数据源说明**：分片按题量精确对上全量 500 题跑（127−104=23 时间题，30−23=7 拒答题），取自 `hypotheses-full500.jsonl` + `judge-verdicts-full500.json`（v3 库 = stage3 轮）；`hypotheses-stage3.jsonl` 是 100 题子集文件，不含本分片 30 题。全程只读：DB 用 `readOnly` 打开；检索复演（逐题重放 k=10 检索窗口以确认模型当时看到什么）在 memory.db 的**一次性临时副本**上跑，原库零写入。30 题全部人工深挖（含 raw 会话原文比对），非仅脚本分类。

## 1. 逐题表

时间推理（refusal：无=强答 / 软=软拒答；contentRate=金标内容词在金会话语句覆盖率，†=金标为纯数字/日期，指标无意义；散key=承载金标词的 key 数）

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | rate | 散key | 主因 |
|---|---|---|---|---|---|---|
| a3838d2b | 4 | 3 场（漏 Walk for Wildlife） | 无 | †1.00 | 0 | (b) 检索：第4场藏在 interest 维度，未进 k=10 |
| gpt4_4edbafa2 | June 3rd | 无6月烧烤记录，列6/10、6/17近似项 | 软 | 0.00 | 0 | (a) 抽取：“6月3日参加同事后院烧烤”整句丢失 |
| c9f37c46 | 2 months | “1到2个月(33-62天)”骑墙 | 无 | 1.00 | 1 | (d) 推理：内容齐全，该果断答~2个月却给区间 |
| gpt4_9a159967 | United Airlines | American 最多 | 无 | 1.00 | 9 | (a) 抽取：芝加哥"乘坐美联航”属性被剥（4段最多） |
| d01c6aa8 | 27 | 拒答（无出生年份/年龄） | 软 | †0.00 | 0 | (b) 检索："32岁”维度未进 k=10（5/10 槽被跨用户占） |
| gpt4_cd90e484 | Two weeks | 无金翅雀记录 | 软 | 0.50 | 1 | (a) 抽取：金翅雀回归目击事件丢失（望远镜在库） |
| gpt4_88806d6e | Tom | Mark&Sarah 更早可证，Tom 属另一账户 | 软 | †0.00 | 0 | (a) 抽取：“几个月前认识Tom"丢失；跨用户Tom被标签正确挡住 |
| gpt4_f49edff3 | nursery→baby shower→phone case | 只排出2件（shower 缺失） | 部分 | 0.44 | 13 | (a) 抽取：“帮表姐挑 baby shower 用品"(02-10) 是旁插半句，丢失 |
| gpt4_4929293a | Michael's engagement party | 只有表姐婚礼记录，无法判 | 软 | †0.00 | 0 | (a) 抽取："刚从 Michael 订婚派对回来”(05-06) 旁插丢失 |
| gpt4_7f6b06db | Muir Woods→Big Sur→Yosemite | 只有 Big Sur→Yosemite | 无 | 0.70 | 17 | (b) 检索：Muir Woods（“徒步”≠"trip"语义差）未进 k=10；5/10 槽跨用户 |
| gpt4_18c2b244 | Luvs→Ibotta→ShopRite | 排出前2件，ShopRite 无日期 | 部分 | 0.83 | 18 | (b) 检索：ShopRite 注册语句在库（含日期+@04-15）但被 9 个优惠券建议维度挤出窗口 |
| gpt4_a1b77f9c | 2+4+2=8 weeks | Sapiens 4周；Power/Nightingale 无法算 | 部分 | 0.55 | 21 | (a) 抽取：The Power 读完事件(03-20)丢失；Nightingale 读完仅以助理建议句式存在 |
| gpt4_7abb270c | Science→MoCA→Met→History→ModArt→NatHist | 顺序错乱，3件"无日期" | 无 | 1.00 | 34 | (a) 抽取：Science Museum 参观丢失 + 3次参观坍缩成@03-04"recently before" |
| 4dfccbf7 | 24 days | 主答0天（次答24天） | 无 | †0.13 | 1 | (d) 推理："决定送修”绑到02-01计划语句而非02-25实际事件 |
| gpt4_61e13b3c | 3 weeks | 拒答（无 Spring Fling 记录） | 软 | 1.00 | 1 | (a) 抽取："昨天在 Spring Fling Market 摆摊”(03-20) 丢失 |
| 370a8ff4 | 15 | 81天=11周4天 | 无 | †0.00 | 0 | (e) 金标噪声：01-19→04-10 任何算法都得不出15周；我们的11.6周才是对的 |
| gpt4_d6585ce8 | Billie→公园→Brooklyn→爵士→Queen | 只排3件，漏 Billie/Queen | 无 | 0.72 | 20 | (b) 检索：10 槽只命中5维，Billie/Queen 两个出席维度落榜 |
| gpt4_f420262c | JetBlue→Delta→United→American | "只确认 AA 一班" | 无 | 1.00 | 27 | (b) 检索：4个航段事实散4维，JetBlue/Delta/United 维度全被行李费/信用卡建议挤出 |
| gpt4_e414231e | 4 days | 0天（同一天） | 无 | †0.00 | 0 | (d) 推理：“决定升级"绑到03-15计划语句而非03-19实际 |
| gpt4_7bc6cf22 | 12 days ago | 拒答（无读3月15日刊记录） | 软 | 0.11 | 1 | (a) 抽取："今天读了3月15日刊 New Yorker"丢失 |
| gpt4_d6585ce9 | my parents | Billie 演唱会（姐姐） | 无 | 1.00 | 1 | (b) 检索：Queen@04-15(with parents) 维度未进窗口，模型退回3/18 |
| gpt4_fa19884d | a bluegrass band with banjo | 拒答（无法锁定具体艺人） | 软 | 0.60 | 3 | (a) 抽取：“发现了一支有班卓琴手的蓝草乐队”降级成“在探索蓝草" |
| gpt4_68e94288 | #PlankChallenge | 慈善义卖社媒帖（跑偏） | 无 | †0.00 | 0 | (a) 抽取："今天参加了#PlankChallenge"(03-15) 丢失；6/10 槽跨用户 |

拒答失守题（_abs，全部为“应拒未拒/拒得不彻底”；跨用户列=该题检索窗口中被 (non-user-account) 标记的维度数，来源经 source_refs 逐一核对，均不在本题 haystack）

| qid | 金标 | 我们的答案 | 主因 | 跨用户槽 |
|---|---|---|---|---|
| 80ec1f4f_abs | 0，12月没提过博物馆 | 12月没去过，计数 0 | (e) 裁判噪声：与金标几乎逐字等价仍判错 | 0 |
| 88432d0a_abs | 信息不足，没提过烤蛋挞 | 无蛋挞记录…所以答案：0次 | (e) 边缘：语义等价但把“无记录"落成"0次"，且复述了跨账户内容 | 3 |
| 6aeb4375_abs | 信息不足，提过韩式没提意式 | 意菜记录都属另一账户，个人史：0 | (e) 边缘：拒答正确+标签防护成功，败于"0"收尾 | 7 |
| 2133c1b5_abs | 信息不足，住原宿不是新宿 | 新宿无记录——你住原宿，约3个月 | (e) 边缘：正是金标要的“纠正前提”，裁判未给分 | 3 |
| 031748ae_abs | 信息不足，提的是 Senior SWE 不是 Manager | 答“带4名工程师” | (d) 该拒强答：松散相关条目（Senior SWE 带4人）触发 rule 7 | 4 |
| a96c20ee_abs | 信息不足，没提过本科课程海报 | "Harvard"（海报@首届会议 × 会议在 Harvard 两跳链） | (d) 该拒强答：两条真实但前提不符的条目跨维串联 | 5 |
| 09ba9854_abs | 信息不足，没提过巴士票价 | 给出 Narita/Haneda 两套节省金额 | (d) 该拒强答：用助理交通建议条目做算术 | 2 |

## 2. 失败模式分布

| 主因 | 时间题(23) | 拒答题(7) | 合计(30) | 占比 |
|---|---|---|---|---|
| (a) not-in-lib 抽取丢失/降级 | 12 | 0 | 12 | 40% |
| (b) scattered/检索漏（含散key挤出 + 跨用户占槽） | 7 | 0 | 7 | 23% |
| (c) pollution 污染 | 0 | 0 | 0 | 0% |
| (d) reasoning（含该拒强答/骑墙） | 3 | 3 | 6 | 20% |
| (e) judge/gold 噪声 | 1 | 4 | 5 | 17% |
| (f) other | 0 | 0 | 0 | 0% |

## 3. 能力级结论

**瓶颈排序（本分片，按“可挽回分”排序）**
1. **抽取丢旁插事件/属性（40%）**——12题全是同一形状：会话里以旁插半句出现的**事件**（参加BBQ/订婚派对/PlankChallenge/读某刊/发现某乐队）或**属性**（航班归属美联航）被丢弃，而同会话的衍生内容（酱料偏好、建议清单）被大量收库。新 few-shot 提示词修好了“日期换算”，但没修住“事件保全”。
2. **检索窗口被挤占（23%）**——两个挤占者：(i) **跨用户维度**（软 scope ×3 boost 不够；7 题窗口里 2-7/10 槽被别的账户占用，最狠一题 7/10）；(ii) **同账户助理建议维度**（推荐/费用/攻略与问题共享词汇但没有事实）。7 题 (b) 全部是“事实在库、维度落榜”。
3. **ask 层规则缺口（20%）**——两种：plan/realization 绑定（2题，金标把“决定X”绑到后一个会话，我们绑到先前的计划语句 → 答0天）；以及 rule 7（“部分相关就强答”）直接导致 3 题拒答失守。
4. **裁判噪声（17%）**——4 题拒答题我们的答案与金标语义等价（含一题近逐字），flash 裁判仍判负；1 题时间题金标算不出来（370a8ff4：任何读法都得不出 15 周，我们的 11.6 周才对）。

**与上轮（100题子集解剖：a72% / c17% / d7% / b3%）对比**
- (a) 抽取丢失 72% → 40%：新抽取提示词确实见效（金料“完全不在库”的比例大降），但残余全是更难的旁插/属性级丢失。
- (c) 污染 17% → **0%**：软 scope 降权 + (non-user-account) 标 + rule 6 完全防住了“跨用户内容进答案”——本分片唯一被彻底消灭的形态（88806d6e/6aeb4375 中标签实际拦截了跨用户 Tom/意餐馆）。
- (b) 散账 3% → 23%：**反向爆炸**。上轮是“写路径散账”（key 漂移），本轮是“读路径窗口挤占”——500 用户合库后 k=10 稀缺性暴露，软 scope 从防污染武器变成了检索瓶颈的一部分。
- (e) 17% 是新显形的类别（上轮 n 小看不出）：约一半的拒答失守其实是判分噪声，**76.7% 拒答率低估了真实拒答能力（≈90%）**，但剩下一半是真失守。

**哪些只能靠第 2 轮重摄入（抽取保全/event_time/别名合并）**
- 12 题 (a) 全部：旁插事件保全（事件必须带日期锚入库）、属性保全（航司/金额/对象不得剥）、相对日期换算（"today/3 weeks ago"必须落成绝对日期——顺带修 birdingJournalHabit "since ~2023-11-26" 这种未来日期 bug）。
- (b) 中 2 题依赖重摄入减负：7abb270c（3 次参观坍缩进单维 "recently before"）+ a1b77f9c（Power 读完丢失）——先丢后找是找不回的。
- event_time（W6a）直接对症：@date=会话日期在"旁插提及过往事件”时系统性说谎（7abb270c 坍缩、c9f37c46 开放麦@05-27），value 内嵌日期多次救场说明这一层才是可依赖的。
- 检索侧的 (b)（5 题）**不需要重摄入**：提高 scope boost/硬过滤+兜底标签、事件类问题降权纯建议维度、聚合题放大 k——读路径可修。

**拒答止血方案（按性价比排序）**
1. rule 7 加数量词卫兵（通用规则）："how many/how much/how long 类问题，若本账户无任何记录该精确量的条目，仅有邻近主题条目（别的食物/别的职位/别的城市）→ 必须 不知道”。直接对症 031748ae/a96c20ee/09ba9854。
2. 无记录 ≠ 0：答案措辞改为“没有记录，无法统计”，不断言 0——对症 88432d0a/6aeb4375 的裁判口径。
3. 答案卫生：拒答时**不复述**跨账户条目清单（6aeb4375/88432d0a 的答案里跨账户内容可能干扰裁判阅读）。
4. 前提失配优先纠正：问题里的实体（新宿/SWE Manager）与记忆中同类实体（原宿/Senior SWE）不匹配时，输出前提纠正而非数字——2133c1b5 已做对，固化成规则可过裁判。

## 4. 新形态发现

1. **"0-day 区间"形态（新，2题）**：同一意图的“计划@T1 + 实现@T2"共居一个维度时，区间题把事件词（decided/fixed）绑到 T1 → 答“0天”。4dfccbf7 甚至在答案里算出了正确的 24 天但让 0 天当主答。通用解法：intent 类问题“最新语句为准”（rule 3 的自然延伸），重摄入不需要。
2. **跨用户维度吃掉检索槽（新，量级意外）**：合库后 30 题中 14 题的 k=10 窗口含 2-7 个 (non-user-account) 维度。标签+rule 6 防住了答案污染（上轮的 (c) 清零），但**槽位饥饿**成为散账的新面孔——软 scope ×3 在金料维度词面弱时（trip↔徒步、age↔"how old moved"）不够用。
3. **助理建议维度是新的 attractor**：上轮修掉了“长 value 巨型语句霸榜”（F1），但推荐/攻略类维度仍以主题词汇与事件类问题同台，把出席/注册/完成等事实维度挤出 k=10（d6585ce8、f420262c、18c2b244）。“问题问事件时降权 tentative 助理建议维度”是通用读路径药方。
4. **@date 标记的双面性**：三层日期锚中，Today 行（第3层）本轮零失败、value 内嵌日期（第1层）多次救场，但 @date（第2层）=会话日期在“旁插提及过往事件”时主动误导（7abb270c 三事件同@03-04）。结论：**第1层+第3层可靠，第2层在 event_time 落地前不可单独依赖**。
5. **金标本身有错（370a8ff4）**：LongMemEval oracle 的时间算术存在不可复现项；建议对 temporal 错题先做算术复核再归因，避免把金标噪声当产品缺陷修。

**与分片相关的文件**：判分缓存 `c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\data\judge-verdicts-full500.json`、本轮答案 `data\hypotheses-full500.jsonl`、v3 库 `data\memory.db`（7160 语句/6456 维度，0 条斜杠日期——HANDOFF 里的斜杠告警对 v3 已不适用）；检索复演代码路径 `c:\Users\SZU1\Desktop\edgelore\src\agent\retrieval.ts`（软 scope L205-226）、渲染 `src\agent\runtime.ts` L352-395、ask 规则 `src\agent\ask.ts`（rule 6/7）。解剖用临时脚本已全部删除，仓库无残留。

---

# 分片三：单会话助手 + 偏好（37 题）

解剖完成。数据源说明：stage3 轮标签下的全量产物是 `hypotheses-full500.jsonl` + `judge-verdicts-full500.json`(500 题，对 `memory.db` 作答，371/500=74.2%),分片数量(assistant 25 错 + preference 12 错)与该轮完全吻合；而 `hypotheses-stage3.jsonl` 只是同配置在 100 题子集上的复跑，故以 full500 为准。全程只读(node:sqlite readOnly,零写库)。分析脚本在 `C:/Users/SZU1/AppData/Local/Temp/edgelore-dissect/`。

# 1. 逐题表(37 题)

refusal: exact=精确“不知道”(0 题) / soft=软拒答(25 题) / answered=给出实质回答(12 题)。主因： a1=整会话漏摄入， a2=列表展平(条目留/属性丢)， a3=抽取丢细节， b=散账， c=污染/跨户兜底， d=读路径/推理， e=判分噪声。

**单会话助手(25 题)**

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | contentRate | 散key数 | 主因 |
|---|---|---|---|---|---|---|
| 1d4da289 | I mentioned biometric authentication or | 抱歉，我目前没有关于…双因素认证具体方法的记 | soft | 0% | 0 | a1 |
| 51b23612 | Nu, pogodi! | Sorry — I don't have anything in my memo | soft | 0% | 0 | a1 |
| 58470ed2 | According to Borges, 'The Library is a s | I don't have any memory of discussing Bo | soft | 0% | 0 | a1 |
| 8752c811 | The 27th parameter was 'Sound effects (e | I don't have any memory of providing a l | soft | 0% | 0 | a1 |
| ceb54acb | I suggested 'sexual fixations', 'problem | 抱歉，我不记得我们之前聊过"sexual compul | soft | 0% | 0 | a1 |
| e3fc4d6e | Dr. Arati Prabhakar | I don't have any memory of that conversa | soft | 0% | 0 | a1 |
| 1b9b7252 | Mindful.org. | The website I mentioned was **Mindfulnes | answered | 100% | 4 | a2 |
| 7e00a6cb | International Budget Hostel | 离红灯区最近的是 **The Bulldog**(列表含正确答案) | answered | 100% | 1 | a2 |
| c7cf7dfd | Nostalgia | 我推荐过 **Fabriclore**(列表含 Nostalgia) | answered | 100% | 1 | a2 |
| 0e5e2d1a | 38 subjects | 我记得…提过双耳节拍可能有助于…(无数据量) | soft | 0% | 0 | a3 |
| 1568498a | 28. Kg3 | …进行到第 28 回合时是你刚走了 Be6 | soft | 67% | 1 | a3 |
| 18dcd5a5 | 4 | I remember that The Lost Temple of the D | soft | 0% | 0 | a3 |
| 352ab8bd | The average improvement in framerate was | I don't have any information in my memor | soft | 9% | 1 | a3 |
| 3e321797 | 10 minutes | I don't have that specific detail in my | soft | 0% | 0 | a3 |
| 41275add | The video is 'How to Sit Properly at a D | 我记得推荐了 4 个视频，第一个是 Mayo Clinic(无标题/链接) | answered | 20% | 1 | a3 |
| 4388e9dd | Andy was wearing an untidy, stained whit | 没有记录 Andy 具体穿什么衣服(角色设定在) | soft | 17% | 1 | a3 |
| 5809eb10 | 2014. | …关于该案是优化 case summary,无开工年份 | soft | 0% | 0 | a3 |
| 7161e7e2 | Admon was assigned to the 8 am - 4 pm (D | I don't have the exact shift assignment | soft | 78% | 1 | a3 |
| 89527b6b | The Plesiosaur had a blue scaly body. | I remember working on a children's dinos | soft | 25% | 1 | a3 |
| 8aef76bc | Mod Podge or another sealant | 没有找到关于“报纸花瓶”推荐过什么密封剂 | soft | 0% | 0 | a3 |
| dc439ea3 | Hoop Dance | I don't have any memory of mentioning a | soft | 50% | 1 | a3 |
| eaca4986 | C D E F G A B A G F E D C | I don't have the chord progression for t | soft | 0% | 0 | a3 |
| fea54f57 | Evolution | I don't have that specific detail in mem | soft | 0% | 0 | a3 |
| 8cf51dda | The three objectives were: 1) to identif | 三个目标：1.识别亚型 2.研究临床意义 3.开发生物标志物 | answered | 21% | 2 | e |
| e9327a54 | The Sugar Factory at Icon Park. | 主打巨型奶昔的那家应该是 **Sugar Factory** | answered | 100% | 3 | e |

**单会话偏好(12 题)**

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | contentRate | 散key数 | 主因 |
|---|---|---|---|---|---|---|
| 0edc2aef | The user would prefer suggestions of hot | your own account doesn't have any Miami…(转向他账户) | soft | 23% | 9 | a3 |
| 1da05512 | The user would prefer responses that tak | 从记忆来看，你是在 2023-05-23 开始考虑 NAS… | soft | 8% | 6 | a3 |
| 95228167 | The user would prefer responses that hig | Focus on Les Paul models…(未给两者差异) | answered | 33% | 4 | a3 |
| b0479f84 | The user would prefer documentary recomm | you specifically connected with Dynasties… | answered | 11% | 2 | a3 |
| 75832dbd | The user would prefer suggestions relate | 列出正确论文+“从另一账户历史”列会议 | soft | 28% | 4 | c |
| 09d032c9 | The user would prefer responses that bui | 不知道…只有旅行收纳建议(移动电源在库) | soft | 17% | 3 | d |
| 1d4e3b97 | The user would prefer responses that ref | It probably isn't the bike…it's the group-ride effect | answered | 24% | 5 | d |
| 32260d93 | The user would prefer recommendations fo | I don't have any saved preferences from…(转他账户电影) | soft | 50% | 7 | d |
| 35a27287 | The user would prefer responses that sug | 本周末是 5 月 27–28 日…(未提语言练习) | answered | 62% | 8 | d |
| 57f827a0 | The user would prefer responses that tak | 我自己账户里没有关于卧室家具的记录(梳妆台项目在库) | answered | 23% | 7 | d |
| 8a2466db | The user would prefer responses that sug | …你正在学 Premiere 高级设置…没有资源清单可给 | soft | 16% | 1 | d |
| 38146c39 | The user would prefer responses that bui | swap turbinado + pairings(正确基于偏好) | answered | 35% | 8 | e |

# 2. 失败模式分布

| 主因 | assistant (25) | preference (12) | 合计 (37) | 占比 | 上轮(100题全集) |
|---|---|---|---|---|---|
| a1 整会话漏摄入 | 6 | 0 | 6 | 16% | (并入a) |
| a2 列表展平→错选 | 3 | 0 | 3 | 8% | (并入a) |
| a3 抽取丢细节 | 14 | 4 | 18 | 49% | (并入a) |
| **a 合计(not-in-lib)** | **23 (92%)** | **4 (33%)** | **27** | **73%** | **72%** |
| b 散账/截断 | 0 | 0 | 0 | 0% | 3% |
| c 污染/跨户兜底 | 0 | 1 | 1 | 3% | 17% |
| d 读路径/推理 | 0 | 6 | 6 | 16% | 7% |
| e 判分噪声 | 2 | 1 | 3 | 8% | — |
| f other | 0 | 0 | 0 | 0% | — |

拒答形态： exact 0,soft 25,answered 12。本分片无 abstention 题(两类各 0 道 `_abs`),也不存在“该拒没拒”型失守——所有 37 题金标都有实质答案，拒答本身都是“库内确实没有时正确拒”。与拒答对应的真实失守形态是**跨账户兜底**(见第 4 节)。

深挖验证(每类 3-6 题，均通过 raw 会话 vs 库内语句比对)：a1 六题金会话 stmtsInLib=0 且全部命中 `missing-sessions.json`(ingest 失败，非抽取质量问题)；a2 三题 raw 原文含条目→属性映射、库内仅剩条目列表(1b9b7252 原文"Mindful.org: This website includes…Mountain/Body Scan"→库内扁平为"Headspace app, Mindful.org, UCLA…, Mindfulness Exercises, YouTube");a3 抽查 89527b6b/eaca4986/7161e7e2/18dcd5a5/41275add/0e5e2d1a 均确认细节在 raw 有、库内无；d 六题逐一确认载体语句在库且维度干净(无跨户共享、无 non-user-account 误标)；e 三题人工比对答案实质正确。

# 3. 能力级结论

瓶颈排序(本分片)：
1. **抽取保真(73%)仍是绝对瓶颈**，与上轮 72% 持平——读路径修复没有改变第一瓶颈，但其内部构成变了： 上轮主要是“抽不出来”，本轮大量是“抽了但压瘪”(a3 49% + a2 8%)。助手结论的细节保全是重灾区： 音符序列、逐条属性、逐日排班、视频标题/URL、数量、时长、颜色全部死于 value 摘要。saidBy 署名在本分片抽查全部正确(assistant/user 各归其位)，不是失败模式。
2. **偏好题的第二瓶颈是“元偏好零入库”**： 全库 7160 条语句中，匹配“回答方式偏好”(prefers responses/回答偏好/沟通偏好等)的语句数为 **0**。single-session-preference 的金标全是这种元偏好；主题内容(turbinado 糖偏好、NAS 考虑、Les Paul 升级)都在，但“希望回答怎么给”从未成为语句。这直接造成 0edc2aef(西雅图景观酒店偏好无法被"hotels Miami"检索命中)和 8a2466db(有 Premiere 锚点却因无“资源偏好”语句而拒绝推荐)。
3. **读路径(16%)退居第三**： 6 题 d 全在偏好类——内容在库、维度干净，但检索没把载金语句送进上下文，模型于是宣称“自己账户没有”并拒答或转他账户。
4. **散账(b)已消灭**(3%→0%): 分组渲染生效，载体分散到 9 个 key 的题(0edc2aef/35a27287/38146c39)不再因此丢分。
5. **判分噪声(e)成为新的可计量税(8%)**: 三题(e9327a54 答对店名、8cf51dda 三目标齐全、38146c39 直接基于 turbinado 偏好作答)都是实质正确被判 0——抽取压缩掉限定词 + judge 完整性严格叠加的复合税。

只能靠第 2 轮重摄入解决的：
- **a1 六个整会话**(sharegpt_cGdjmYo/U4oCSfU/5m7gg5F/6pWK9yx、ultrachat_348449/427265,即 missing-sessions.json 的 6/7): retry 已失败过，需换 ingest 路径重跑。
- **a2/a3 的抽取改造**： 逐条属性语句(list item→attribute 不展平)、payload 保真(音符/和弦/URL/标题类 verbatim 语句)、数量与时长独立成句、event_time 完整落库。
- **元偏好语句类型**： 抽取时把“用户希望回答怎么给”抽为一等语句(偏好类 12 错中至少 4 题的根因)，纯读路径修不了。

读路径可修(不需重摄入)： 兜底门控(scope 内存在主题匹配维度时禁止转他账户，32260d93/57f827a0/75832dbd 直接受益)；偏好感知检索(推荐类问题优先召回 preference/interest 维度，1d4e3b97/35a27287/09d032c9 受益)。

# 4. 新形态发现(本轮新出现)

1. **列表展平 → 世界知识代答(a2,新)**： 抽取保住条目、丢掉逐条属性后，模型用预训练常识“补全”并自信答错——The Bulldog(红灯区)、Fabriclore(印度面料店)、Mindfulness Exercises(免费冥想网站)都是“看起来更符合”的错误项。**contentRate=100% 却答错**，词覆盖率指标对这类完全失明，需按“条目数 vs 属性映射数”检测。
2. **“带载荷名”语句丢载荷(新)**： 库内语句自称有载荷却没存载荷——"Sad song **with notes** created…key C major"(零音符)、"推荐了4个YouTube视频(…)"(无标题无链接)、"shift rotation: 7 agents, 4 shifts"(无逐日排班)。语句文本自证丢了什么，可机械扫描("with X/X 列表”但 X 缺失)作为重摄入靶点。
3. **跨账户兜底自伤(新，soft-scope 的副作用)**： 诚实的“这是另一账户记录”披露把污染变成了明示引用——75832dbd 本题账户论文列得全对，会议段引自他账户，整题被判 0;更糟的是 32260d93/57f827a0,兜底掩盖了检索对自己账户内容的漏召，模型当轮**错误断言“自己账户为空”**(实际库内有 7-9 条干净的本户语句)。反污染修复(inversion)催生了新失守形态。
4. **judge 完整性税(新计量)**： 我们的重建答案压缩限定词("开发生物标志物” vs 金标"develop biomarkers for early detection and prognosis")即被判 0——抽取压缩与 judge 严格度复合，在 81-82% 的单项正确率下成为可见扣分项(3/37)。

---

# 分片四：知识更新 + 单会话用户（21 题）

# 分片解剖报告：knowledge-update 16 错 + single-session-user 8 错（全量 500 · v3 库 · stage3 轮）

数据源：`c:\Users\SZU1\Desktop\edgelore\benchmark\longmemeval\data\`（longmemeval_oracle.json + hypotheses-full500.jsonl + judge-verdicts-full500.json，即全量 74.2% 那轮）+ memory.db（只读）。分析脚本：`C:\Users\SZU1\AppData\Local\Temp\shard-analyze.mjs`、`shard-raw.mjs`、`shard-verify.mjs`；中间产物 `shard24.json`、`shard24-analysis.json`、`shard24-report.txt`、`shard24-raw.txt`。

注：首次 token 覆盖率脚本漏掉中文译文语句，已逐题人工核读全部 in-haystack 语句（含中文/西语）修正，下表 contentRate 为双语校对后的人工值。

## 1. 逐题表

| qid | 金标(≤40) | 我们的答案(≤40) | refusal | contentRate | 散key数 | 主因 |
|---|---|---|---|---|---|---|
| 6a1eabeb ku | 25:50 | 答 27:12（旧值） | 无 | 1.0 | 2 | (b) |
| 9ea5eabc ku | Paris | 答 Hawaii，还并列提到 Paris | 无 | 1.0 | 2 | (b) |
| 07741c44 ku | under my bed | 答“鞋柜/鞋架”（答错） | 无 | **0** | 0 | (a) |
| f9e8c073 ku | five | 3+5=**8 次** | 无 | 1.0 | 2 | (b) |
| 41698283 ku | 70-200mm zoom | 答 50mm prime（旧值） | 无 | 0.5* | 2 | (a) |
| 618f13b2 ku | six | 答 4 次（旧值） | 无 | 1.0 | 2 | (b) |
| 8fb83627 ku | Five | 3+5=**8 期** | 无 | 1.0 | 2 | (b) |
| 59524333 ku | 6:00 pm | 答 7:00，把 6:00 当一次性 | 无 | 0.9 | 3 | (d) |
| eace081b ku | Oahu | “住宿信息尚未记录”（可答却拒） | 软拒 | 1.0 | 2 | (d) |
| affe2881 ku | 32 | 答 27，自推 28，未见 32 | 无 | 1.0 | 2 | (b) |
| a2f3aa27 ku | 1300 | 答 1250（新值 tentative 被弃） | 无 | 1.0 | 1 | (d) |
| dad224aa ku | 7:30 am | 答 8:30（旧值） | 无 | 0.5* | 2 | (a) |
| 6aeb4375_abs ku | 应拒（只提韩餐） | 跨账隔离成功但答“**0**” | 半拒 | 1.0† | 0 | (d) |
| 031748ae_abs ku | 应拒（是 Senior 非 Manager） | 明知无 SEM 条目仍答“4 人” | 半拒 | n/a† | 1 | (d) |
| 2133c1b5_abs ku | 应拒（Harajuku 非 Shinjuku） | 正确驳 premise 但多答“3 个月” | 混合 | n/a† | 2 | (d) |
| 07741c45 ku | shoe rack in closet | “无存放位置记录”（可答却拒）+引用跨用户鞋 | 软拒 | 1.0 | 1 | (c)(d) |
| dccbc061 su | staunch atheist | “无神论者，但正转向灵性”（含金标但被稀释） | 无 | 0.75* | 1 | (e) |
| 8550ddae su | lavender gin fizz | 猜“lavender 某种鸡尾酒” | 无 | **0** | 1 | (a) |
| 3f1e9474 su | Sarah | “没有和谁聊过的记录”（软拒，库确无） | 软拒 | **0** | 1 | (a) |
| ec81a493 su | 500 | “500 是海报限量，专辑无记录” | 无 | 1.0 | 1 | (e) |
| 15745da0 su | three months | **西语**作答“无开始日期记录” | 半拒(西) | **0** | 1 | (a) |
| 001be529 su | over a year | “无提交日期，无法算出”（库确无） | 软拒 | **0** | 1 | (a) |
| 8a137a7f su | Philips LED bulb | “有 Philips LED 偏好，无更换动作” | 半拒 | 1.0 | 1 | (d) |
| 3d86fd0a su | a coffee shop in the city | “a coffee shop”（丢 in the city） | 无 | 0.67 | 1 | (a) |

\* 值在库但载体错误：41698283 的"70-200mm"只在 assistant 回声句（“与70-200mm互补”），购买事实丢失；dad224aa 的 7:30 只存在于 assistant tentative 语句的括号里（“用户周六7:30am起床”），用户自述丢失；dccbc061 的 "staunch" 修饰语被剥。† abstention 题金标即拒答文本，contentRate 不适用（6aeb4375 的 in-hay 意餐语句=0 属正确缺席）。

## 2. 失败模式分布（本分片 24 题）

| 主因 | KU(16) | SSU(8) | 合计 | 占比 | 上轮 100 题子集全类型 |
|---|---|---|---|---|---|
| (a) not-in-lib 抽取漏 | 3 | 5 | **8** | 33% | 72% |
| (b) scattered 跨 key 更新失效 | 6 | 0 | **6** | 25% | 3% |
| (c) pollution 污染 | 1 | 0 | **1** | 4% | 17% |
| (d) reasoning（拒答纪律双向错 + 更新语义判错） | 6 | 1 | **7** | 29% | 7% |
| (e) judge-noise/数据集歧义 | 0 | 2 | **2** | 8% | —（未单列） |
| (f) other | 0 | 0 | 0 | 0% | — |

(d) 内拆：该拒未拒 3（6aeb4375/031748ae/2133c1b5）、可答却软拒 2（eace081b/8a137a7f）、最新值语义判错 2（59524333/a2f3aa27）。

## 3. 能力级结论

瓶颈排序（本分片）：**抽取漏细节(33%) ≥ 拒答/范围纪律错位(29%) > 跨 key 更新失效(25%) > judge 歧义(8%) > 污染(4%)**。

与上轮（子集 a=72%）对比的变化：
- **(a) 72%→33%**：新抽取提示词生效。剩余 (a) 高度集中：SSU 的 5 个里 4 个是“单会话单事实”题——整个答案就是那一个细节（Sarah / gin fizz / three months / over a year），抽取丢一词即全题丢；KU 侧残余为事件型丢失（purchase→只剩 assistant 回声）、事实被转成偏好/计划（replace→偏好、7:30→assistant 括号）、限定词剥离（staunch、usually）。
- **(b) 3%→25%，升为 KU 头号杀手**：16 道 KU 错题里**新旧值都在库的有 10 道**，其中 **8 道是跨 key 更新失效**（converseChuckTaylorWearCount↔converseWearCount"6"、bereavementSupportGroupAttendance“三次”↔bereavementSupportGroup“5次”、localParkBirdSpeciesCount"27"↔birdWatchingSpeciesCount"32"、charity5kPersonalBest"27:12"↔charity5KTraining“25:50”、familyHawaiiTrip↔familyTripParis、nationalGeographicProgress↔amazonReadingProgress、kauaiBirthdayTrip↔birthdayTripHawaiiOctober、6:00 挂在 clientMeetingScheduled 名下）；另 1 道（a2f3aa27）同 key 双语句，1250 accepted vs “接近1300” tentative——**轮次顺序其实可从 source_refs 后缀（answer_5126c02d_1/_2）恢复，但状态机与 ask 层都没用**。A2 规则3（最新用户陈述优先）在 9/9 可判定的更新题上未生效：跨 key 时 ask 层不做调和（计数题两次做了荒唐的加法 3+5=8），同 key 时 adjudication 把新值降级 tentative。
- **(c) 17%→4%，且性质变了**：显性跨用户内容被正确隔离（6aeb4375_abs：库里全部意餐语句经核验均属其他会话 answer_83c13ff9/419d21d5/75eca223，模型说“属于另一账户”完全正确）；唯一的污染 case（07741c45）反而是**话题相近的跨用户内容未打标泄漏**（Adidas/Vans 语句来自 answer_099c1b6c_* 和 answer_caf5b52e_*，被当作本用户事实引用，同时挤掉了库内金标 closetOrganizationPlan“将旧运动鞋放入鞋架”）。
- **(e) 新出现 8%**：分数逼近天花板后 judge 严格性开始可见（详见新形态 5）。

SSU 100%（子集）→ 87.5%（全量）的解释：**不是回归，是小样本+尾部难度**。经核验，子集 stage1-ids.txt 与本轮 8 道 SSU 错题**交集为 0**——子集那 8 道全对纯属抽样没抽到这 8 类失败。全量 SSU（n=64-70）的难点：单事实会话无第二次机会、语言漂移会话、预设式问法（"did I replace"）、数据集歧义（poster/album）。另发现 KU 的 2133c1b5_abs 子集轮 verdict=1、全量轮 0——混合“驳 premise+强行作答”的回答在两轮间不稳定。

只能靠第 2 轮重摄入修复的：(1) 抽取保全——事件/所有格事实（购买 70-200mm、under my bed、时长从句 three months/over a year、路过提到的实体 Sarah/gin fizz）、限定词（staunch/usually）、事件-vs-偏好分型（8a137a7f）；(2) **抽取输出语言钉死**（见新形态 1）；(3) event_time 精度——语句 created_at 只有日期，同日双值无法排序（a2f3aa27），需把 source_refs 轮次后缀纳入调和；(4) M5 别名合并——上列 7 对跨 key 更新对合并后，A2 规则3/冲突裁决才有作用点。ask 侧可修（不依赖重摄入）：跨 key 计数“最新覆盖”调和规则、预设问题作答纪律（premise 缺失就拒答到底，不要输出 0/4人/3个月）。

## 4. 新形态发现

1. **抽取输出语言漂移（系统性，最重）**：全库语句语言普查 zh=4493（63%）/ en=2236 / **es=312（4.4%）**/ other=119，而 LongMemEval 会话 100% 英文。漂移按整会话传染（15745da0、001be529 全部 10/8 条语句为西语），并传导到回答语言（15745da0 的答案整段西语）；同时造成词面检索 token 失配（也是本分片首轮 contentRate 测量失真的根因）。只能重摄入修（抽取 prompt 钉死输出语言）。
2. **裸值计数语句检索不可达**：计数更新被抽成纯数字语句（converseWearCount="6"、birdWatchingSpeciesCount=“32种鸟类记录”、instagramFollowerCount="1250"），key 有语义但 value 零文本供词，ask 层在旧值的“叙事丰富”语句面前系统性看不见/不采信新值——与 (b) 耦合计数器的具体机理。
3. **预设问题过度审查（拒答纪律的反向走火）**：新加的范围/拒答纪律让模型在可答题上打折——"replace"（原始文本其实也没说 replace，是问题预设）、“计划停留 Oahu”不被认作住宿决定、“计划放入鞋架”不被认作当前状态。3 例，说明拒答闸门校准现在是双向问题。
4. **scope 守卫的非对称盲区**：对显性异己内容（他账户的意餐/护照）正确打 non-user-account 标并拒用，但对话题强相似的跨用户内容（鞋类语句撞鞋类问题）不打标、被当作用户自有事实引用（07741c45）。
5. **该拒未拒的机理已变**：3 道 abstention-KU 错题的 premise 检测全部正确（模型明说“没有 SEM 条目”/“属于另一账户”/“Shinjuku 无公寓”），败在最后一步仍输出数字/时长（"0"、“4 人”、“3 个月”）——是拒答收尾纪律问题，不是记忆错误；纯幻觉型拒答失守在本分片为 0。
6. **judge-noise 开始可见**：ec81a493 原始文本"signed poster from my...debut album, which is a limited edition of only 500 copies"的 which 本就歧义，我们的海报解读成立却被判 0；dccbc061 答案含“无神论者”金标但因附加转折被拒。按当前判分口径这两题只能靠更完整的复述金标拿分（如把"in the city"级限定词也带上）。