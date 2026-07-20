# 动态 Agent UI · 行式 DSL + 持久 Surface 设计决议（#12 P1c M1）

> 2026-07-20 定稿。Q-A/Q-G 由用户拍板，Q-B/C/E/F 为其推定结果（论证见下）；Q-D 词表细节与面板 UX 留待各自的设计小节。对比底料：`docs/design/agent-ui/spec-comparison.md` 与讨论 artifact（A2UI v1.0 / ChatKit / OpenUI Lang 八轴对比）。

## 0. 一句话

模型用一门**行式 DSL** 持续"编辑"一个**跨 turn 存活的工作台面（surface）**；落盘的是**语句流**（骑现有 `role:'ui'` 信封），surface 是语句流的 **fold**——回放硬约束（#14 Q3：渲染=持久化事实的纯函数）由此保持。

## 1. 决议清单

| 问题 | 决议 | 性质 |
|---|---|---|
| Q-A 组合表示 | **行式 DSL**（OpenUI Lang 形态：一行一句、标识符引用、前向引用） | 用户拍板 |
| Q-G 承载面 | **A2UI 式持久 surface**（右侧面板工作台，跨 turn patch 同一面） | 用户拍板 |
| Q-E 流式编码 | 行级解析 + Autocloser（截断行补齐照常渲染）+ 语句级增量缓存；L1/L2/L3 一次到位 | 随 Q-A 定 |
| Q-F 校验-提示词同源 | **Zod 式目录 → 同源生成校验器 + 系统提示词**，从"值得抄"升格为承重墙（API 层 JSON schema 校验被 DSL 绕开，防线在 parser 层重建且更强——schema/guidance 漂移结构性不可能） | 随 Q-A 定 |
| Q-C 绑定与编辑态 | 响应式 `$variables`（声明即默认值、$binding 双向、依赖自动重算）；编辑态归 renderer，模型只在事件时刻拿 formState 快照 | 随 Q-A 定 |
| Q-B 事件分档 | OpenUI Action 步骤模型：`@Set/@Run` 本地消化不上抛；`@ToAssistant` 回模型（自然语言 + formState 快照）——既有"原样执行"结构化确认 turn 即其载荷形态，平移 | 随 Q-A 定 |
| Q-D 能力属性层 | 仍为原创设计；表达位置已定：机制归组件内建 + 原语上的能力属性声明。**具体词表/约束语法在 M5 前单独过一轮** | 部分开放 |
| Q-H 迁移路径 | 信封留作语句流持久化载体；旧 props-JSON 卡走 legacy 渲染路径永不迁移；migration_preview 按 P1c 原计划报废 | 随 Q-A/Q-G 定 |

**为什么这对组合互相成就**：行式 DSL 的增量编辑（改 20 条语句中的 2 条，token -85%）只有在持久 surface 上才有意义；反之 surface 需要 patch 协议——**DSL 语句本身就是 patch 协议**。

## 2. 语句文法（草案，M3 定稿）

```text
statement   := assignment | actionDecl
assignment  := ident "=" componentCall | literal | "$" stateDecl
componentCall := Name "(" args ")"            // 位置参数 ABI = 目录 Zod 键序
args        := (expr ",")* expr?
expr        := literal | ident | "$" ident | "[" exprList "]" | componentCall(仅叶子内联)
stateDecl   := "$" ident "=" literal          // 响应式状态，声明即默认值
action      := "Action([" "@" step ("," "@" step)* "])"
step        := Set($var, expr) | Run(tool, args) | Reset($var) | ToAssistant(text)
```

- **root 约定**：`root = …` 是 surface 的挂载点；root 先到即渲染骨架（L2），前向引用出占位。
- **按名合并**：同名标识符后出现者覆盖（增量编辑的全部机制）；无法解析的行丢弃并结构化报错，其余照常渲染（OpenUI 违约分层降级）。
- **Autocloser**：流中截断的半行按括号/引号栈补齐成合法语句先渲染，下一 chunk 到达后以完整行覆盖。
- 目录规模对齐三家共识（18–29 原语）；样式不可控，只有 variant 枚举（A2UI v1.0 删 primaryColor 的教训照单全收）。

## 2.5 词表海拔（2026-07-20 修正，用户确认）

```
原子（语言词表）      Stack / Text / Table / Select / Button / Code(待补) …——三家共识的 18–29 目录
机制组件（词表条目）   原子拼不出的交互机制，机制内建（首个：field_mapping 拖线画布）
场景卡（已废弃）      migration_preview——业务名词烤进组件，P1c 已判死
```

P1c 旧计划的"三原语卡"按此尺重新裁定：

- **field_mapping**：保留，**唯一的机制组件**——直接操纵（拖线配对）是三家规范共同空白，原子不可组合出，机制必须内建（对比报告轴 3）。名字合规（"两列字段集配对"是交互范式非业务名词）。
- **data_preview**：**取消独立组件**——它 = `Table` + 单元格可编辑 + 校验高亮，后两者正是 Q-D 能力属性层的正题（ChatKit `Text.editable` 是唯一业界实证）。作为"原子+能力属性"的第一个验证场景存在。
- **artifact_review**：**取消独立组件**——≈ 原子组合 + 缺失的 `Code` 原子 + Action 步骤（导出 @Run、授权执行 @ToAssistant）。作为组合性的第二个验证场景存在。

原则：**组合性最大化，专用组件只留给真正不可分解的机制**——这才是"原子级词表+模型组合"的字面兑现。机制组件命名沿用同一禁令（无业务名词）。

## 3. 同源目录（Q-F 承重墙）

每个原语一个 Zod 式 schema（沿用 common/uiComponents 的 validator 位置）：

```
schema ──┬──▶ parser 的参数校验器（位置参数按键序解位）
         ├──▶ 系统提示词的组件文档（自动生成，含类型/枚举/示例）
         └──▶ TS 类型（组件 props）
```

- 解析/校验错误结构化带 hint（行号、期望类型、最近合法值）回喂模型自纠——重试闭环从 API 层挪到 parser 层。
- **1-based 防线**：行号/索引类参数在 schema 层声明 `zeroBased: true` 元标记，文档生成器自动写入 "0-BASED" 警示 + 指纹移位兜底（P0 的教训制度化）。

## 4. 持久化与回放（fold 语义）

- 模型每轮产出的语句批（一次 render_ui 类工具调用的参数）**原文落盘**为 `role:'ui'` 消息的新载荷形态 `{surface: id, statements: string}`——转录仍是唯一事实源，**不新增 message role**。
- Surface 运行态 = 该 surface 全部历史语句批的**按序 fold**（解析→按名合并→挂载）。重开会话重新 fold，逐像素一致。
- 用户编辑态（表单值、选中）不落转录；`@ToAssistant` 触发时以 formState 快照进结构化确认 turn（"原样执行"模式），快照文本即持久化。
- 旧会话的 props-JSON 卡：注册表保留 legacy 渲染路径，永不迁移（#13"旧记录降级、新记录追加"同款约定）。

## 5. Surface 生命周期（M4 细化）

- 右侧 auxiliary bar 新页签「工作台」，与数据面板并列；一个会话同时至多一个活动 surface（多 surface 是明确的 later）。
- 消息流中的投影：**轻引用卡**（"迁移工作台 · 已更新 N 处 · [打开]"），与 #13 产物引用卡同族——surface 是交互主场，消息流是审计轨迹（权威倒置于纯卡片流方案，特此记录）。
- 会话切换/重开：面板从语句流重建；surface 无独立持久化。

## 6. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| M1 | 本决议文档 | 评审通过（本文件） |
| **M2 真模冒烟（先于全面开工）** | 最小 parser + 3–5 原语目录 + 同源提示词，k2.7/k3 实测 | **DSL 良率 ≥90%（语句级）且自纠一轮后 ≥98%，否则回头评审杂交路线（JSON 扁平表），此时沉没成本最小**。✅ **2026-07-20 已过闸**：k2.7 与 k3 均为语句级 100%、8/8 程序首发零错、零围栏违规（6 原语目录、8 个域内任务、同源提示词为唯一教学来源；harness=`scripts/ui-dsl-smoke.mjs`）。注记：冒烟验证的是文法+同源闭环的可行性，M5 真实词表（画布/能力属性）复杂度更高，届时复测 |
| M3 | parser/Autocloser/增量合并 + 同源目录管线 + fold 运行时 | 解析测试成体系（截断/乱序/非法行/覆盖）；老会话零迁移 |
| M4 | surface 面板 + 投影卡 + 事件通道（@Set/@Run/@ToAssistant） | 重开会话逐像素一致；确认 turn 平移"原样执行" |
| M5（2026-07-20 重塑，见 §2.5） | ① 原子补全（`Code` 等）② Q-D 能力属性层设计+实现（editable/validation 标记先行，拖线其次）③ field_mapping 作为首个机制组件进目录 ④ migration_preview 报废 | data_preview/artifact_review 两场景用**原子+能力属性**组合复现（不新增组件）；三迁移场景共用 field_mapping+组合；smoke harness 换真实词表复测良率 |

## 7. 风险登记

1. **Kimi 写 DSL 的良率是最大未知**（OpenUI 数据来自 GPT-5.2）——M2 门槛即为此设，不达标回退有明确出口。
2. parser + Autocloser 是真工程量——解析测试先行（fuzz 式截断用例）。
3. 系统提示词增量（文法 + 目录文档）按 token 计费——同源生成器要带"精简模式"（只注入本会话注册的原语）。
4. 审批卡在词表之外的原则不变（安全轴三家共同弱点，我们的既有原则无先例也无反例，保持）。
