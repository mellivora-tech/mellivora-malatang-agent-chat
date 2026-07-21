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
| Q-D 能力属性层 | 仍为原创设计；表达位置已定：机制归组件内建 + 原语上的能力属性声明。**词表/约束语法草案见 §8，决议点待拍板（§8.7）** | 部分开放 → §8 提案 |
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
原子（语言词表）      Stack / Text / Table / Select / Button / Code …——三家共识的 18–29 目录
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

## 8. Q-D 能力属性层设计（M5 前置 · 草案待拍板）

> 2026-07-21 起草。§1 承诺"Q-D 词表/约束语法在 M5 前单独过一轮"，本节即此轮。Q-A/Q-G 是用户拍板，**Q-D 是原创设计（轴 3 结论：业界无现成答案）**，故本节是**提案**——决议点集中在末尾 §8.7，其余为随 Q-A/Q-B/Q-C/Q-F 推定的结构性结论。

### 8.0 一句话

**能力属性 = 挂在原语某个参数上的"能力声明"**，本体是一个复用 Action `@Step` 形态的 mini 构造器（`@Editable(...)` / `@Validate(...)`），进**同一 catalog spec 表**，同源驱动校验器 + 提示词。它让既有原子的既有结构"就地长出交互"，不新增组件——这正是 §2.5「data_preview 降级为原子+能力属性第一验证场景」的兑现物。

### 8.1 判定线：能力属性 vs 机制组件（Q-D 的承重规则）

三层海拔（§2.5）里最容易糊的一刀，就在"能力属性"与"机制组件"之间。判据一句话：

> **交互产出的值能不能塞进原子的既有数据形状？** 能 → **能力属性**；产出的是一个原子结构里没有的**新结构** → **机制组件**。

| 交互 | 产出 | 落点 |
|---|---|---|
| 单元格就地编辑 | 一个 cell 值（Table 既有形状内） | 能力属性 `@Editable` |
| 校验高亮 | 一个 valid/invalid 标记（附着于既有 target） | 能力属性 `@Validate` |
| 拖线把源字段连到目标字段 | 一对 mapping（**任何原子结构里都没有**） | 机制组件 `field_mapping`（内建） |

这条线同时解释了为什么 `field_mapping` 必须是机制组件而非属性：配对关系是新结构，原子拼不出（轴 3 结论），机制只能内建。**能力属性只做"增强"，绝不"造结构"。**

### 8.2 词表（M5 开局集：editable/validation 先行）

严格照 §92 M5 排序（editable/validation 先，拖线其次）。开局只上两条，均有业界实证或明确旁路：

| 能力 | 签名（位置参数 ABI） | 语义 | 实证 |
|---|---|---|---|
| `@Editable(target, placeholder?)` | target: 列头字符串；placeholder?: string | target 列单元格就地变输入框；**无 action，值进 formState**（Tier 0） | ChatKit `Text.editable`（轴 3 唯一实证）；砍掉 `autoFocus/autoSelect`（UX 抛光，later） |
| `@Validate(target, pattern, hint)` | pattern: JS 正则源；hint: 违约文案 | target 列按正则校验；不匹配→**高亮 + hint，非阻断**；invalid target 进 formState 快照 | ChatKit 客户端原生校验（实证仅 `required?/pattern?`），我们加**自定义 hint**（ChatKit 没有）|

> **落地细化（2026-07-21，草案 §8.2 的 `rule` 集收敛）**：草案给 `@Validate` 列的 `rule ∈ {pattern/range/oneOf/notNull}` 落地为**单一正则谓词**——理由：① ChatKit 唯一校验实证就是 `required?/pattern?`；② 正则是单 target 内自足的通用谓词（`required` = `.+`、枚举 = `a|b|c`），range 这类数值判等留 later 或用正则近似；③ 最关键——**避免引入嵌套 rule 构造器**（`range(0,999)` 会污染 parser 的 `ident(` = 组件调用假设），死守"处处位置参数 ABI"。`@Editable` 的 `required` 也并入校验轴（用 `@Validate(target, ".+", ...)`），使 `@Editable` 只管"可编辑"这一件事。

保留位（不在 M5 开局，登记以固定语法走向）：`@Selectable(mode)`（行/单元格选中）、`@Reorderable`（拖排）——两者一旦触及"直接操纵"就逼近机制组件边界，届时用 §8.1 判定线复裁。

### 8.3 同源接线（Q-F 承重墙的延伸）

能力属性**不是**新语法，是 `catalog.ts` 里一个新 `ArgType` + 一张平行的 cap spec 表：

```ts
// ArgType 增一支
| { readonly kind: 'capabilities'; readonly allow: readonly CapName[] }

// 平行于 IComponentSpec 的 CAP_SPECS（同款位置参数 ABI + doc）
// @Editable / @Validate 各一条；parser 按同一位置 ABI 校验其参数，
// generateDslPrompt 只为"本会话注册原语实际 allow 的 cap"注入文档（§7.3 token diet 自然延伸）
```

于是 `Table` 长出可选第三参：

```text
Table(columns, rows, caps?)
  caps?: [@Cap(...), ...] — allow: [Editable, Validate]
```

调用长这样（data_preview 第一验证场景，**零新组件**）：

```text
tbl = Table(
  ["源字段", "目标字段", "金额"],
  [["order_no", "order_id", 128], ["amt", "amount", 0]],
  [@Editable("目标字段", required), @Validate("金额", range(0, 999999), "金额需为非负数")]
)
```

`@Cap(...)` 的分词/递归下降与 `Action([@Set(...)])` **同一套内核**（parser 已有 `@Name(args)` 步骤解析）——所以 Q-D 的实现增量极小，主要是加两条 spec + 复用已存在的步骤解析器。这也是"能力属性挂在 Action 同款机制上"能成立的工程理由。

### 8.4 事件归档（对齐 Q-B/Q-C）

能力属性产出的一切都是 **Tier 0 本地**，与 §1 Q-C「编辑态归 renderer」严格一致：

- `@Editable` 改动 → 写进按 target 键控的结构化 formState；**永不自动上抛模型**。
- `@Validate` 结果（每 target 的 valid/invalid + hint）→ 同样进 formState。
- 只有显式 `@ToAssistant` 才把 formState 快照（含**已编辑值 + 哪些 target invalid**）作为 `<form-state>` 回模型——模型**看得到** invalid，但从不亲自算校验。M4 已落地的"确认 turn 携 `<form-state>` 快照"直接复用，零新通道。

### 8.5 1-based 防线 与 目标寻址

- **优先按 name 寻址**（列头字符串 / 字段名），把 §3 的 0/1-based 火药桶从源头绕开——列本来就有名字，无须报索引。
- 仅当 target 无名可用时才退回索引，此时该 cap 参数在 spec 层打 `zeroBased: true`，文档生成器自动写 "0-BASED" 警示（§3 已制度化的教训，cap 层白拿）。

### 8.6 安全不变量（承接 §7.4）

- 能力属性**不引入新信任边界**：cap 产出只进 formState，@ToAssistant 时作为 **untrusted 快照**回模型（ChatKit "treat action payloads as untrusted" 同款立场）。
- **cap 不能声明"自动执行"**：执行永远走 `@Run(工具)` 且受既有审批闸——**审批卡仍在词表之外**（§7.4 原则不变）。
- 复杂交互的逃生口是 **`@ToAssistant`（回模型），不是 ChatKit 式 client modal**：任何 cap 表达不干净的交互，降级为一个模型 turn，而非再造 cap——词表保持封闭、增长可控。

> artifact_review 第二验证场景由此闭合：它 = 原子组合 + `Code` 原子 + Action 步骤（`@Run` 导出、`@ToAssistant` 授权执行），**一条 cap 都不需要**——反向证明"组合"与"增强"两条路各司其职，专用组件无处安放。

### 8.7 决议点（2026-07-21 用户拍板：D1–D4 全部照提案通过，进入开发）

1. **D1 · 跨字段校验**：✅ **不做**（`@Validate` 恒为单 target 谓词，跨字段一律 `@ToAssistant` 交模型）——照 ChatKit"复杂校验官方劝退"。
2. **D2 · 目标寻址默认**：✅ **name-first、index 兜底**（§8.5）。此决定外溢到 field_mapping 端点寻址，一次定。
3. **D3 · invalid 是否阻断 @ToAssistant**：✅ **只标注不阻断**（客户端原生、非阻断，"要不要带病提交"留给模型）。
4. **D4 · 开局词表就两条**（`@Editable`/`@Validate`）：✅ 够 M5 两场景；`@Selectable/@Reorderable` 留保留位、触发时按 §8.1 复裁。

> 实现落点（本轮）：`catalog.ts` 加 `ArgType.capabilities` + `CAP_SPECS`（同源）、`Table` 增 `caps?` 第三参；`parser.ts` 复用 Action `@Step` 内核解析 `@Cap(...)`、按 `allow` + 位置 ABI 校验；`fold.ts` 物化 cap 进 SurfaceValue；`SurfacePanel.tsx` 的 Table 渲染可编辑单元格 + 校验高亮，编辑态进 formState、@ToAssistant 快照携带。smoke harness 换真实词表复测留到 field_mapping 一并做（§92 M5 验收）。

### 8.8 实现状态（2026-07-21 · ✅ Q-D 落地）

Q-D 能力属性层已按 §8.1–8.7 实现，`npm run verify` 除既有环境级 locale 失败外全绿（单测 578 全绿，含 5 组 cap 新测；cap e2e 通过）：

- **同源目录**：`ArgType.capabilities{allow}` + `CAP_SPECS`（`@Editable`/`@Validate`）落 `catalog.ts`；`generateDslPrompt` 只为注册原语 `allow` 的 cap 注入 CAPABILITIES 段 + EXAMPLE 3（token diet 延伸）。校验器与提示词同一张表 —— Q-F 漂移不可能扩到 cap 层。
- **解析/校验**：`parser.ts` 新增 `DslValue.cap`，`parseValue` 遇前导 `@` 走 cap 分支（Action 内核零冲突复用）；`validateCap` 按 `allow` + 位置 ABI + 类型逐参校验，结构化 hint 回喂（`@Frobnicate 不允许` / `@Validate takes 3` / `argument 0 (target): expected a "string"`）。违规语句照常单条丢弃、其余渲染。
- **物化 + 渲染**：`fold.ts` 加 `SurfaceValue.cap`；`SurfacePanel.tsx` 的 Table 读第三参 caps → `@Editable` 列渲染 `.surface-cell-input` 就地输入、`@Validate` 列正则不匹配加 `.surface-cell-invalid`（danger 描边）+ title=hint（非阻断）。编辑态按 `表名.列名[行]` 键入 formState，`@ToAssistant` 快照携带编辑值 + `# invalid …` 行（含用户未触碰但原值即非法的单元格）。坏正则降级为"有效"（不误伤）。

**data_preview 第一验证场景达成**：编辑 + 校验用 `Table + @Editable + @Validate` 复现，零新组件。

**（2026-07-21 续）`Code` 原子 + artifact_review 第二验证场景达成**：`Code(content, language?)` 进目录（同源，renderer `.surface-code` 只读等宽块 + 语言标签）；artifact_review = `Stack([Text 统计, Code, Button(Action([@Run 导出, @ToAssistant 授权执行]))])` 纯原子组合复现，**零专用组件**（单测锁定 + e2e 渲染断言）。至此**组合性双向证毕**：data_preview 靠"增强"（能力属性）、artifact_review 靠"组合"（原子+Action），§8.1 判定线两侧各有实证。

**（2026-07-21 续）`field_mapping` 机制组件达成**：`field_mapping(source, sourceFields, target, targetFields, mappings?)` 进目录（同源），renderer `@xyflow/react` 拖线画布（左源右目标、拖 handle 成对、删边解对），xyflow 主题 CSS-var 全量重映射到 `--vscode-agents-*` token（含 danger/accent/input）。**机制逻辑纯函数化**（`common/uiDsl/fieldMapping.ts`：解析/1:1 连接淘汰/断开/序列化/孤立节点）——拖线交互本身脆，机制**逻辑走单测**、画布**渲染+快照走 e2e**（渲染源/目标节点 + 声明边、未拖动也把有效配对写进 @ToAssistant 快照）。三迁移场景（表→表/文件→表/表→文件）共用同一画布，靠端点 label 区分，零场景专属组件。
> 用户拍板用 @xyflow/react（设计原定，非手写 SVG）。落地代价：新增依赖（bundle 1.8→2.19MB）+ `tsconfig` 开 `skipLibCheck`（xyflow d.ts 不满足本仓 `exactOptionalPropertyTypes`，标准做法，只跳过 lib 声明内部检查、自有代码仍全检）。

**（2026-07-21 续）`migration_preview` 报废完成**：整组场景卡移除——`migrationPreview.ts` / `MigrationPreviewCard.tsx` / `MigrationGrid.tsx` / 其单测 / 218 行 CSS / 32 条 `ui.migration.*` i18n / 两处注册表条目 / render_ui guidance / agentIpc 提示（重指向 surface_patch+field_mapping）。**旧会话零崩**：`UiCard.tsx` 对未注册组件天然降级为 markdown fallback（Q-H「legacy 渲染永不迁移」的兑现物），退役 migration_preview 卡回落为可读摘要——`ui-card.spec` 重写为此 fallback 契约的专测。`surface_patch` 成为唯一注册组件；共享 SQL 闸（`isReadOnlySql`/`isSingleStatement` 在 dbQuery，非迁移私有）原样保留。live 管线 spec 与 uiArtifact 信封测平移到 surface_patch。

**M5 未竟（仅剩）**：smoke harness 换真实词表复测良率——已备 harness（`scripts/ui-dsl-smoke.mjs` +3 真实词表任务：field_mapping 画布 / Table 能力属性 / Code 产物；同源提示词自动含新词表）；实跑需 Kimi 凭证（k2.7/k3，~40 次付费调用，同 M2 由用户执行）。门槛不变：初始语句级 ≥90%、自纠后 ≥98%。
