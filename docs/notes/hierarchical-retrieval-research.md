# 分层检索实现机制调研（RAPTOR / Small-to-big / Zep roll-up / Letta）+ 认识论分类

> 2026-09-21 · 聚焦"检索本身找得到"的架构方案，全部核到源码/论文一手来源

## 一、RAPTOR（聚类摘要树）

- **建树**：叶子=分块文本 → 嵌入 → UMAP 降维 → GMM 软聚类（一节点可属多簇，阈值 0.1）→ LLM 摘要 → 递归到无法再聚类。压缩率实测 0.28。成本随语料线性；约 4% 摘要含轻微幻觉（无可测影响）。
- **检索（关键发现）**："collapse the tree"——**所有层拍平进一个向量池做 flat top-k**，查询对粗细粒度自适应选择。论文消融：collapsed 一致优于"先命中上层再下钻"（traversal 每层比例固定，与问题粒度不匹配）。
- **效果**：QuALITY 82.6%（强 reader 下 SOTA）；但弱 reader 下仅 +0.5~1.7pp——增益依赖强 reader。
- **增量写入：不支持**（add_to_existing 未实现，只能整树重建）。ICLR 2025 Dynamic Tree Memory 专门补此短板，佐证是公认缺陷。

## 二、Small-to-big / Parent-document

- LlamaIndex AutoMerging：三层 chunk 2048→512→128，**只有叶子进向量索引**；命中叶子的父节点若 ≥50% 子节点被命中则整父替换（递归上卷）。
- LangChain ParentDocument：两级 2000/400，子块嵌入带 parent_id，父块存 docstore；**add_documents 天然增量**。
- 要点：small-to-big 的"层级"是**同一文本的不同粒度视图**（布局），不产生新知识——解决"小块准、大块全"，不解决聚合。

## 三、Zep/Graphiti 的 roll-up 一等公民（证据最强的路线）

- **每实体节点维护 LLM 增量更新的 summary；实体簇之上再有 community 摘要节点；摘要与事实、实体同池参与 flat 检索**（搜索返回 edges × entities × communities 三元组）。
- 增量更新：新实体看邻居社区多数派归属，**只做一次** "旧社区摘要 + 新实体摘要 → 归并" 的 LLM 调用（O(1)），无需重建；代价是社区渐漂，需周期全量刷新纠偏。
- **效果**：multi-session +30.7%、temporal +38.4%（聚合类大涨）；**代价 single-session-assistant -17.7%**（细节类反降）——roll-up 不可替换底层语句的实证。

## 四、GraphRAG / LongMemEval key-expansion 的补充证据

- GraphRAG：聚合/主题类 comprehensiveness 72-83% 压倒 flat RAG；但精确事实题 naive RAG "directness" 反而最高——**分层摘要与扁平检索是互补而非替代**。
- LongMemEval 官方：**压缩形态单独当检索 key 全都更差**（fact-as-key recall 0.530 vs 原文 0.582）；**fact 拼接进原文做 expansion 才有效（recall +9.4%）**——roll-up 只做加法不做替换的实证。

## 五、机制对照表

| 方案 | 建层成本 | 检索路径 | 增量写入 | 聚合效果 |
|---|---|---|---|---|
| RAPTOR 聚类树 | 高（UMAP+GMM+逐簇 LLM，全量重算） | collapsed flat（层级只是粗细节点混池） | ❌ 只能整树重建 | 好但依赖强 reader |
| Small-to-big | 低（纯切分） | 叶子 flat → 按父命中率上卷 | ✅ 追加式 | 不产生聚合知识（拼装策略） |
| **Zep roll-up** | 中（每实体/社区增量摘要，O(1) 归并） | **摘要与事实同池 flat** | ✅ pairwise 归并+邻居投票 | ✅ multi-session +30.7% 已验证 |
| GraphRAG | 高（Leiden+逐层报告） | global=map-reduce；local=邻域 | ❌ 需重建 | 全局主题题 72-83% 胜，细节题反输 |
| key-expansion | 极低（fact 拼进原文 key） | flat | ✅ | recall +9.4%（最便宜正收益） |

## 六、对 edgelore 的落地建议

1. **不照搬 RAPTOR**：不支持增量（与持续写入冲突）；"先命中上层再下钻"直觉在论文里恰是输的。
2. **维度级 roll-up 作为一等公民**：每维度维护一条 LLM 增量归并的摘要语句（"旅行：去过 X/Y/Z"），**与普通语句同表/同索引、同池参与检索**（加 row_type 或 parent_dimension 标记）。聚合类问题天然命中 roll-up；细节题仍由语句承接。
3. **增量更新学 Zep 的 O(1) 归并**：新语句写入 → 只对所属维度做"旧 roll-up + 新语句 → 新 roll-up"一次 LLM 归并（可 debounce），保留时间戳，定期重算兜底。
4. **可叠加 small-to-big**（免费纯 SQL）：命中某语句后，若该维度 ≥一半语句在 top-k 中 → 用 roll-up + 全组语句替换散点返回。
5. **roll-up 只做加法不做替换**：细节语句永远可独立命中（Zep -17.7% 的教训）；聚合答案必须可溯源回语句列表（防 roll-up 幻觉）。

来源：[RAPTOR](https://arxiv.org/abs/2401.18059)/[代码](https://github.com/parthsarthi03/raptor) · [LlamaIndex auto-merging](https://docs.llamaindex.ai/en/stable/examples/retrievers/auto_merging_retriever/) · [LangChain ParentDocument](https://github.com/langchain-ai/langchain/blob/master/libs/langchain/langchain_classic/retrievers/parent_document_retriever.py) · [Zep](https://arxiv.org/abs/2501.13956)/[Graphiti](https://github.com/getzep/graphiti) · [GraphRAG](https://arxiv.org/abs/2404.16130) · [Mem0](https://arxiv.org/abs/2504.19413) · [LongMemEval](https://arxiv.org/abs/2410.10813) · [Dynamic Tree Memory](https://arxiv.org/abs/2410.14052)
