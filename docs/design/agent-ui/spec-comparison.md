# 生成式 Agent UI · 三家规范对比(讨论底料,不带结论)

> 目的:为我们的原子词表/事件/绑定/流式设计提供业界已验证的解法对照。三家均读规范原文:A2UI v1.0 Candidate(1305 行主规范 + 类型系统 + 目录 JSON)、ChatKit(597 行 widgets.d.ts 公开类型 + 开源 Python 服务端源码)、OpenUI(全部 Lang 规范 mdx + 真实系统提示词 + 解析器博文)。原始文件已留存本地 scratchpad(a2ui/、chatkit/ 目录)供查证。

## 0. 一句话画像

|        | A2UI (Google)                                    | ChatKit (OpenAI)                                 | OpenUI (Thesys)                             |
| ------ | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------- |
| 本质   | 协议:server→client JSON 消息流,UI 与数据严格分离 | 产品 SDK:widget 挂在聊天消息上,action 走独立通道 | 语言:面向 LLM 输出的行式 DSL + 宿主注册组件 |
| 渲染端 | 任意(Flutter/Angular/Lit…)                       | 闭源 chatkit.js(CDN 分发)                        | 开源 react/vue/svelte 绑定                  |
| 许可   | Apache 2.0                                       | 类型/服务端开源,渲染器闭源                       | MIT(纠错闭环等在 Cloud)                     |

---

## 轴 1 · 词表与粒度

**三家一致:原子级、封闭目录。**

- **A2UI**:18 个组件(Text/Image/Icon/Video/Audio + Row/Column/List/Card/Tabs/Divider/Modal + Button/TextField/CheckBox/ChoicePicker/Slider/DateTimeInput)。无 Form/Table/Chart。样式几乎不可控(v1.0 特意删掉 primaryColor),只有 variant 枚举。**目录可整体替换**:任何厂商可定义自己的 catalog(JSON Schema 同构),catalog 里还内嵌给 LLM 的 instructions——目录同时是白名单、校验器输入、提示词载体。
- **ChatKit**:3 root(Card/ListView/BasicRoot)+ 26 组件。布局 flexbox 词汇(Box/Row/Col/Spacer),文本四档,表单六种,有 Table。图标封闭枚举(~60 个,禁任意 SVG;A2UI 反而允许自定义 SVG path)。
- **OpenUI**:语言本身零内置组件,目录全由宿主用 Zod 注册;官方默认库含图表族(Bar/Line/Pie/Scatter…)和模式件(Carousel/SectionBlock/FollowUpBlock)。聊天库甚至禁用 Stack,只许 Card 垂直堆叠。

**对我们的含义**:目录规模 18-29 个是三家共识;"目录=白名单=提示词=校验器"三合一(A2UI 的 catalog、OpenUI 的 Zod→prompt 生成)是两家独立收敛出的同一设计。

## 轴 2 · 组合表示 —— 三家三种,分歧最大的轴

|         | 表示                                                                                     | 例子                                                          | 动机                                                  |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| A2UI    | **扁平邻接表**:所有组件平铺一张表,children 按 ID 引用,**禁止内联嵌套**,必须恰有一个 root | `{"id":"root","component":"Column","children":["user_name"]}` | 乱序到达、组件级 upsert、渐进渲染                     |
| ChatKit | **嵌套 JSON 树**:children 数组递归内联,`key` 做 diff 锚点、`id` 做流式文本锚点           | `{"type":"Card","children":[{"type":"Row","children":[…]}]}`  | 服务端 yield 整树、框架 diff,作者心智最简单           |
| OpenUI  | **行式赋值 + 标识符引用**:每行一条语句,子组件引用变量名,支持前向引用                     | `root = Stack([nav, tbl])` ↵ `nav = Navbar(…)`                | token 省 ~50%、行级流式、增量编辑(改 UI 只发变更语句) |

**关键观察**:A2UI 的扁平表和 OpenUI 的行式引用本质是同一个思想(引用扁平化,先声明骨架后填肉),只是编码不同(JSON vs DSL);ChatKit 的嵌套树把复杂度挪到了服务端 diff。**流式友好度:OpenUI ≥ A2UI > ChatKit;模型出错面:大致相反。**

OpenUI 实测 token 账(同一 UI,GPT-5.2):Lang 154 tokens vs C1 嵌套 JSON 357 vs 逐节点 patch 340 vs YAML 316——**扁平引用 + 位置参数比嵌套 JSON 省一半**。增量编辑再省一层(20 条语句改 2 条,-85%)。

## 轴 3 · 交互能力 —— 三家共同的空白

存在的交互全部是**表单式**:点击(Button/整行)、文本编辑、选择、滑杆、日期。

**直接操纵(拖线、拖拽排序、resize、画布连线)三家规范全部沉默。**最接近的孤例:

- ChatKit `Text.editable`——渲染出的文本点击就地变输入框(能力属性思路的唯一实证)
- OpenUI 表格排序/搜索是**组件内建行为**(机制归组件私有,不在语言层)
- ChatKit 官方态度:复杂交互别用 widget,`handler:"client"` 弹自家 modal 再 `sendCustomAction` 回传

**对我们的含义**:"能力属性 + 机制库"这层没有业界现成答案,是我们要原创设计的部分。两条已验证的旁路可参考:机制归组件内建(OpenUI 表格)/ 复杂交互外溢给宿主(ChatKit client handler)。

## 轴 4 · 事件模型 —— 每家都是"分档"设计,档位划法不同

**A2UI:三档延迟模型,声明在组件的 action 属性上**

```json
"action": { "event": { "name": "submit_form", "context": {"email": {"path": "/formData/email"}} } }   // 完整 agent turn
"action": { "functionCall": { "call": "openUrl", "args": {…} } }                                        // 纯本地,agent 不知情
// 第三档:event + wantResponse:true → actionResponse 轻量 RPC(typeahead 场景),patch 数据不重建 UI
```

事件**开启新 agent turn**;payload 含 name/surfaceId/sourceComponentId/context(手挑的数据路径)。

**ChatKit:action 是独立协议通道,不是聊天 turn**

```json
"onClickAction": { "type": "select_flight", "handler": "server", "payload": {"id": "opt_123"} }
```

- `handler: "server"` → POST 到专门的 `action()` 方法(不进 respond()),返回与聊天相同的事件流——可以只原地刷新 widget,可以流回消息,可以纯副作用
- `handler: "client"` → 宿主回调,可再链回服务端
- **模型可见性是手动的**:action 不自动进模型上下文,官方模式是写 HiddenContextItem 记录"用户做了什么"
- loadingBehavior 声明式(auto/self/container/none)

**OpenUI:Action([@步骤…]) 顺序执行,五种步骤三个去向**

```text
Button("Create", Action([@Run(createResult), @Reset($title)]))   // 本地工具 + 本地状态
Button("Show 30d", Action([@Set($days, "30")]))                  // 纯本地状态
FollowUpItem("再看一周") // 点击 = @ToAssistant,文本作为用户消息回模型
```

- `@Run/@Set/@Reset` 运行时内部消化,**不上抛**;只有 `@ToAssistant/@OpenUrl` 走宿主 onAction
- 回模型 payload = **人类可读消息 + formState 表单快照**(不是结构化事件!)

**共同点**:都区分"本地消化"与"回模型";都把表单值随事件快照带出。**分歧点**:交互是否自动进模型上下文(A2UI 是=开 turn;ChatKit 否=手动回写;OpenUI 半自动=转成自然语言消息)。

## 轴 5 · 数据绑定与编辑态 —— 光谱的三个点

|         | 绑定                                                                                                                                                     | 编辑态归属                                                      | 模型怎么读回                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A2UI    | 独立 data model + JSON Pointer 双向绑定,`Dynamic* = 字面量\|{path}\|{call:函数}` 三态类型;List 模板有作用域和相对路径                                    | 客户端(击键实时写本地 model,零网络)                             | ① action context 手挑路径 ② `sendDataModel:true` 全量快照随每条消息;**刻意不做 delta 协议** |
| ChatKit | **运行时零绑定**——树即终态;绑定只在服务端模板阶段(Jinja + JSON Schema 数据契约)                                                                          | 客户端 DOM(defaultValue 非受控)                                 | 提交瞬间按 `name` 快照进 action payload(点号路径展开成嵌套对象)                             |
| OpenUI  | 响应式 `$variables`:声明即默认值,传给 $binding 位即双向绑定,依赖自动重算("No useEffect. No wiring.");Query/Mutation 是一等数据源,成员访问带列 pluck 语义 | Renderer(opaque state,宿主经 onStateUpdate/initialState 持久化) | ActionEvent.formState 快照;模型不被动感知状态变化                                           |

**共识**:编辑态都归客户端,模型都只在"事件时刻"拿快照,没有人做实时状态同步。**分歧**:要不要运行时绑定(A2UI/OpenUI 有,换来标签实时联动、条件显隐;ChatKit 没有,换来实现最简)。

## 轴 6 · 流式/更新协议

|         | 初始渲染                                                         | 后续更新                                                                                                                                      | 渐进渲染机制                                                                                          |
| ------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A2UI    | JSONL 消息流(createSurface → updateComponents → updateDataModel) | 组件按 id **整体 upsert**;数据按 JSON Pointer 定点改;surface 跨 turn 持续存在                                                                 | 扁平表允许乱序到达;root 到达即渲染,未定义引用出占位;schema 校验失败结构化回喂 LLM 自纠                |
| ChatKit | widget 随消息下发                                                | 服务端 **yield 整棵新树,SDK 自动 diff** 成三档 patch:文本 delta(仅带 id 的 Text/Markdown)/ 单节点替换 / 整树替换;任意后续时刻可经 action 刷新 | 文本级流式动画;其余 diff 降级为节点替换                                                               |
| OpenUI  | 行式文本流                                                       | LLM 只输出**变更语句**,parser 按名合并(增量编辑)                                                                                              | **Autocloser**(把截断半行补齐成合法文本再解析)+ 语句级增量缓存(O(N²)→O(N));非法语句丢弃、其余照常渲染 |

**对我们 L1/L2/L3 的映射**:L1(材料化提前)三家都天然满足;L2(骨架)= A2UI 的 root 先行/OpenUI 的前向引用;L3(渐进)= OpenUI 的 Autocloser + 行级解析,或 A2UI 的乱序 upsert。

## 轴 7 · 约束/校验

- **A2UI**:`checks` 数组(条件函数组合:required/regex/length/numeric/email + and/or/not),纯客户端执行;**Button 挂 checks 任一失败自动禁用**(表单有效性 gating 声明化)。⚠️ 规范与示例三处自相矛盾(checks 语法三种写法并存)。
- **ChatKit**:仅 required/pattern/min/max,原生表单校验,复杂校验官方劝退("走 client action 弹自家 UI");服务端明言 payload 不可信,校验归集成方。
- **OpenUI**:**Zod 键序 = 位置参数 ABI**,schema 同时生成校验器和系统提示词(防两者漂移——这是我们 1-based 事故的系统性解法);违约分层降级(未知组件丢语句/多余参数照渲/表达式失败回退原值),错误结构化带 hint 适合回喂自纠。

## 轴 8 · 安全

- **共识底座**:目录白名单 + 声明式数据而非代码 + 封闭表达式(A2UI 函数注册制、OpenUI 工具白名单、ChatKit 无任何注入口)。
- **A2UI 独有**:surface 身份归属(iconUrl/agentDisplayName 由 orchestrator 覆写验证,防子 agent 冒充可信服务);数据定向投递(快照只发给创建 surface 的 agent)。
- **三家共同弱点**:对"用原子拼出误导性 UI"(假确认框、假系统对话)都没有超出白名单之外的专门机制——我们的"审批卡在词表之外"原则在业界没有先例但也没有反例。

---

## 放到我们的场景:迁移工作台三种写法(示意)

**A2UI 式**(扁平表 + 绑定):映射表 = List 模板绑 `/mappings`,行内 TextField 双向绑 `target`;确认按钮 action context 手挑 `/mappings` 整树回传;样例表格没有现成组件(基础目录无 Table)。

**ChatKit 式**(嵌套树 + 提交快照):Form 包 Table,每行 target 是 `Text.editable(name: "mappings.0.target")`;确认按钮 submit,payload 里自动带全部字段;改动后原地刷新走 action() → yield 新树。

**OpenUI 式**(行式 DSL + 响应式):`$mappings` 状态 + Table(Col 列式),`Button("确认", Action([@ToAssistant("按当前映射执行")]))` 带 formState 快照;编译 SQL 可以是本地 `@Run(compileSql)`。

**三家都表达不了**:拖线重新配对。都要退化成 Select 下拉选目标列,或自定义组件。

---

## 开放问题(我们要逐个讨论定的)

- **Q-A 组合表示**:扁平邻接表(A2UI)/ 嵌套树(ChatKit)/ 行式 DSL(OpenUI)?或杂交(JSON 扁平表起步,DSL 作为 L3 优化)?牵动:token 成本、流式、模型出错面、与现有信封的兼容。
- **Q-B 事件分档**:本地消化 / 轻量 RPC / 回模型 turn 三档怎么定?交互对模型的可见性:自动(A2UI)、手动回写(ChatKit)、还是转自然语言(OpenUI)?——这直接决定 token 成本和模型"知道多少"。
- **Q-C 绑定与编辑态**:要不要运行时数据绑定?(A2UI/OpenUI 有,ChatKit 用"提交快照"绕过)我们的表单场景够不够简单到用快照?
- **Q-D 能力属性层**(业界空白,原创):机制集(拖线/拖排/行内编辑/选中)怎么声明、约束怎么表达(maxIn:1)、事件怎么归档?
- **Q-E 流式编码**:JSONL patch 还是行式 DSL?Autocloser 思路是否值得抄?与 render_ui 信封的关系(props 变成组件表?工具变成流?)。
- **Q-F 校验-提示词同源**:Zod→prompt 自动生成(OpenUI)vs catalog 内嵌 instructions(A2UI)——防"schema 与 guidance 漂移"(我们已经吃过 1-based 的亏)。
- **Q-G 承载面**:A2UI 的 surface 概念 = 持久工作台面(跨 turn 持续 patch 同一面),ChatKit = 消息挂 widget 但可后续刷新——我们的迁移工作台是卡片流还是 surface?
- **Q-H 迁移路径**:现有 role:'ui' 信封/注册表/migration_preview 怎么演进过去,分几步。
