# 消息流重构设计方案（#14 · M1 决议版）

- 状态：**M1 完成，Q1–Q5 全部拍板**（2026-07-18）
- 关联：[#14 消息流优化重构](https://github.com/mellivora-tech/mellivora-malatang-agent-chat/issues/14) · [#13 产出物管理](https://github.com/mellivora-tech/mellivora-malatang-agent-chat/issues/13)（P2 前置）· #12 动态 Agent UI · #2 work digest
- 附件：[设计文档完整版（含七家竞品矩阵与桌面端证据，HTML artifact）](https://claude.ai/code/artifact/4e6939b1-38d9-4032-ab2e-445a20da0502) · [Q1 交互原型（运维排查场景，可播放）](https://claude.ai/code/artifact/91c1294e-800a-41c2-8c2e-92016b9bb1d2)

## 背景

mellivora 消息流骨架（work 块收纳、narration 重定位、两层折叠、结果优先）方向正确，问题在骨架之下：长 run 步骤墙、工具名行无意图语义、narration 的章节结构信息被丢弃、长答案撑爆聊天流。

## 竞品证据摘要

七家：Kimi、Antigravity（界面分析）；Codex、Claude Code 2.1.88、OpenCode、Pi（2026-07 源码级）；腾讯 WorkBuddy（官方文档）。桌面端另查六家形态。

**三个消息流收敛点**（三家以上源码级一致，直接当行业答案用）：

1. **读类聚合**：read/glob/grep/list 连续段合并，任何非读类事件打断，写类永不聚合，折叠态只显示计数摘要（Codex `Explored` / CC `collapseReadSearch` / OpenCode `Gathering context`）。
2. **意图动词**：步骤行以 Analyzed/Ran/Edited 等意图开头而非工具名（Antigravity、Codex、OpenCode、Kimi 4:1）。
3. **信息预算不对称**：diff 一等公民全量渲染，exec 输出按行封顶、中间截断保头尾（Codex、Pi、OpenCode）。

**受众规律**（Q1 的决定性证据）：面向开发者的产品全部内联（用户盯着 agent 干活），面向"拿结果的人"的全部收纳（Antigravity 报告场景、WorkBuddy 职场人、mellivora 运维/财务）。

**桌面端三收敛点**（后续立项候选，不在 #14）：per-session git worktree（CC Desktop/Codex/OpenCode）；diff 行内批注→agent 回改闭环（同三家，与 PlanCard 批注同构）；定时任务进一级导航 + 结果队列（CC/Codex/Kimi Work/WorkBuddy）。

## 五问决议

### Q1 · narration 编排 —— b 增强版：块内章节化 + 运行中块内直播 + 完成后收口

- 容器从 run 开始即存在且展开：narration 实时升格为节标题，工具组流入其下（运行态即直播）；成功完成后自动收口为「工作了 Xm · N 个步骤」。
- 用户手动展开/折叠固定（沿用 expandOverride 语义），收口不与用户争夺。
- **失败/中断的 run 不自动收口**，出错步骤自动展开。
- 收口瞬间滚动锚定（块头滚出视口时锚回块头）。
- 底部状态行实时小节标题作为叠加项（P1 实施）。
- **显式排除**"真内联直播、完成后事后收拢"：主时间线已渲染内容撤下重组导致 DOM 重排/滚动跳动/长会话性能不可接受。
- 交互基准以 Q1 原型为准（见附件）。

### Q2 · 聚合规则 —— 与行业一致规则保持一致

读类连续段为组、非读类打断、写类永不聚合、折叠态计数摘要、running 态由聚合行承接 spinner（调用 id 路由、孤儿结果拒绝并入）、计数只增不减防抖、展开/verbose 态跳过聚合 pass 还原逐条。与 Q1 叠加时先按 narration 切节、节内再聚合。

### Q3 · 步骤行 —— 意图动词 + chip + 状态色 + 弱化时长；附加可回放硬约束

- 19 个工具一次做完意图动词映射；文件参数渲染为带类型图标 chip（可附行号范围）；行首状态色点（成功/失败/running）。
- **时长保留在主流步骤行**，右对齐、小一号、次要色、tabular-nums；聚合行显示组总耗时，展开见单步。理由：对本产品用户"哪步慢"是一等诊断信息；Codex 移出主流是终端行宽取舍，GUI 无此约束；耗时是 mellivora 仅有的存量优势之一。
- detail 按不对称预算截断：diff 类全量，exec/查询类 5–10 行、中间截断保头尾。
- **可回放硬约束**：渲染必须是持久化事实的纯函数。step 落盘结构化事实（工具名、参数摘要、结果态、durationMs、narration 文本、detail）；意图动词/chip/聚合计数/章节结构/状态色全部渲染时派生、不落盘；spinner/实时计时等 live 态永不参与已完成状态的渲染——重开会话与首次渲染逐像素一致。旧会话缺结构化字段降级为工具名行；新会话按需追加字段（增量式，不改既有字段语义）。

### Q4 · 长答案分流 —— 进 #13 artifact 体系 + 通用产物引用卡

- 长答案落 #13 的 document artifact（`IArtifactEntry` 增 document kind）。
- 消息流侧只渲染**通用「产物引用卡」**：标题 + 一句话描述 + 打开入口，引用 artifact id 的轻量投影；kind 无关（document/表格/导出文件同卡不同图标）。
- **不新建 PlanCard 式重型专用卡，不走"新 message role 驮载荷"模式**（role:'plan' 的五重白名单被认定为架构负债）。PlanCard 自身重构为独立待议项，不在 #14 范围；通用引用卡为其预留退路（plan 未来可退化为 artifact + 引用卡，评审交互挂产物侧）。
- citations 锚定（Codex 云端形态：摘要论断跳转到证据行）列为后续增强。
- **#13 P0 落地前 P2 不开工。**

### Q5 · 持久化边界 —— 零改动为强约束

聚合/折叠/章节全部是渲染前的幂等 pass（CC 先例），组装层只加标记不改格式。精确含义（配合 Q3 可回放）：零改动 = 旧会话零迁移、不改既有字段语义；**允许对新写入的 step 追加结构化字段**，旧记录缺字段走渲染降级。

## 实施拆解

| 阶段 | 内容 | 前置 |
|---|---|---|
| P0 | 读类聚合 rollup（Q2 全部规则）＋ 步骤行意图化（Q3，含可回放的字段补齐）。纯渲染/组装层，老会话自动受益 | 无，即可开工 |
| P1 | narration 章节化 + 运行中块内直播 + 完成收口（Q1 全部规则）＋ 状态行小节标题 | P0 |
| P2 | 长答案分流：判定阈值、产物引用卡、打开跳转（Q4） | #13 P0 |

## 性能与验收约束

- CC 教训：约 2800 条消息的会话上 memo 失效曾致 15 万次写入/帧。对策与现有 conversationView 增量 reconcile 同路：**折叠 pass 幂等、聚合计数只增不减、长列表虚拟化**。
- P0 验收：≥50 步骤长 run 展开首屏无同质步骤墙；老会话 `.jsonl` 零迁移直接以新样式渲染；**关闭再打开会话，work 块渲染与关闭前逐像素一致**（可回放验收）。
