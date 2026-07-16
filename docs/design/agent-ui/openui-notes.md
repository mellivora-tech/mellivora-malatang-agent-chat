# OpenUI / OpenUI Lang 深读笔记

> 来源:thesysdev/openui 仓库(README、`docs/content/docs/openui-lang/*.mdx` 全部规范、`docs/generated/chat-system-prompt.txt` 真实系统提示词、rust-wasm-parser 博文、skills/openui/SKILL.md)。**定位**:三层栈——① OpenUI Lang(面向 LLM 输出的行式 DSL)② 框架运行时(`@openuidev/lang-core` + react/vue/svelte 绑定)③ 成品聊天界面(AgentInterface)。语言 v0.1(静态)/ v0.5(+响应式状态/数据获取)。MIT。

## A. 组件目录

**语言本身零内置组件**——目录完全由宿主用 Zod 注册(见 F)。官方默认库(来自真实喂给 LLM 的签名):

- Content: CardHeader, TextContent(markdown), MarkDownRenderer, Callout, Image, ImageGallery, CodeBlock, Separator
- Tables: Table, Col(**列式**表格——每个 Col 自带数据数组,为流式与 pluck 服务)
- Charts: Bar/Line/Area/Radar/HorizontalBar + Series;Pie/Radial + Slice;Scatter + Point
- Forms: Form, FormControl, Label, Input, TextArea, Select, DatePicker, Slider, CheckBox/Radio/SwitchGroup
- Buttons: Button, Buttons
- Lists & Follow-ups: ListBlock/Item, FollowUpBlock/Item(点击即发回 LLM 的建议项)
- Layout: SectionBlock(流入时自动展开的手风琴), Tabs, Accordion, Steps, Carousel;容器 Card, Stack

**粒度**:原子 + 少量模式件(Carousel/SectionBlock/FollowUpBlock)。布局原语极少:`Stack(children, direction?, gap?, align?, justify?, wrap?)`;聊天库甚至禁用 Stack("Card is the only layout container")。

**组合写法(DSL 核心)**——每行一条赋值,子组件用**标识符引用**,支持前向引用:

```text
root = Root([nav, dashboard])
nav  = Navbar("Acme Corp", [link1, link2])
link1 = Link("Home", "/")
dashboard = Section([kpi_row, main_chart])
kpi_row   = Grid([stat1, stat2])
stat1     = StatCard("Revenue", "$1.2M", "up")
main_chart = LineChart(["Mon", "Tue", "Wed"], [Series("Visits", [100, 450, 320])])
```

内联嵌套也合法,但文档明确建议引用式("prefer references for better streaming")。**参数全部位置化**,顺序 = Zod schema 键序;显式禁止具名参数(colon syntax "silently breaks")。

## B. 交互能力

交互是**属性**(ActionExpression 类型 prop):

1. 按钮:`Button(label, action?)`,无显式 Action 默认等价 `Action([@ToAssistant(label)])`
2. 表单输入:带声明式校验 `rules`(`{required, email, min, maxLength, pattern...}`),渲染器自动显示错误
3. 双向绑定:prop 标注 `$binding<type>` 的位置传 `$variable`
4. 可点击列表/追问:ListItem/FollowUpItem 点击把文本作为用户消息发回 LLM
5. 条件显隐:三元 `$showEdit ? editForm : null`
6. 自动刷新:Query 第 4 参秒级轮询

**无任何直接操纵**(drag/sort/connect/resize 沉默)。表格排序/搜索是**组件内建行为**,不在语言层。

## C. 事件模型(最重要)

事件 = `Action([...])` 表达式,`@` 步骤顺序执行、失败中断:

```text
submitBtn = Button("Create", Action([@Run(createResult), @Run(tickets), @Reset($title, $priority)]))
btn = Button("Show 30 days", Action([@Set($days, "30")]))
viewBtn = Button("View", Action([@OpenUrl("https://example.com")]))
```

五种步骤,三个去向:

| 步骤                              | 去向                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| `@Run(ref)`                       | **客户端本地**:执行 Mutation / 重取 Query(调 toolProvider,零 LLM 往返) |
| `@Set($var, v)` / `@Reset($v...)` | **客户端本地**:改响应式状态,依赖重算                                   |
| `@ToAssistant("msg")`             | **回模型新一轮**:作为用户消息发给 LLM                                  |
| `@OpenUrl`                        | 浏览器                                                                 |

**运行时只把需要出圈的动作上抛 onAction**(@Run/@Set/@Reset 内部消化):

```tsx
<Renderer
	library={myLibrary}
	response={content}
	onAction={event => {
		if (event.type === 'continue_conversation') {
			// event.humanFriendlyMessage — button label 或 follow-up 文本
			// event.formState — 点击时刻的字段值快照
		}
	}}
/>
```

**Payload**:`{ type; params; humanFriendlyMessage; formState?; formName? }`,内置 type 只有 `continue_conversation` 和 `open_url`。**"回模型"事件 = 人类可读消息 + 表单快照**(不是结构化事件),由宿主决定怎么拼进下一轮——运行时不直接调 LLM。

## D. 数据模型/绑定

三类可绑定数据(v0.5):

**① 响应式状态**:`$days = "7"`(声明即默认值)
**② 双向绑定**:`filter = Select("days", $days, [...])` —— 用户改输入→变量更新→"所有引用它的表达式重算、Query 重取、UI 重渲"("No event listeners. No useEffect. No wiring.")
**③ 工具数据**:必须顶层语句:

```text
data = Query("list_tickets", {}, {rows: []})        // (tool, args, 默认值, 刷新秒数?)
createResult = Mutation("create_ticket", {title: $title})
createResult.status == "error" ? Callout("error", "Failed", createResult.error) : null
```

成员访问带**列 pluck 语义**:`data.rows.title` 对数组取每元素的 title —— `tbl = Table([Col("Title", data.rows.title)])`。

**编辑态**:Renderer 拥有(opaque state),宿主经 `onStateUpdate`/`initialState` 持久化。**模型读回用户输入的唯一通道 = ActionEvent.formState 快照**;模型不被动感知状态变化。组件作者用 `useStateField(name, value)`,schema 用 `reactive(z.string().optional())` 标记接受 $variable 的 prop。

## E. 流式协议(招牌)

**为什么便宜**:去掉 JSON 结构税(component/props/children 每节点重复)+ 位置参数去掉键名。benchmark 原文(同一 UI,GPT-5.2 temp0,tiktoken):

- OpenUI Lang **154 tokens** vs Thesys C1 嵌套 JSON **357** vs Vercel 逐节点 patch **340** vs YAML **316**
- 七场景合计:vs YAML **-47.4%**,vs Vercel **-52.8%**,vs C1 JSON **-51.7%**;60 tok/s 下 2-3× 渲染提速
- 增量编辑:改 UI 只输出变更语句,parser 按名合并("20 语句 ~400 tokens → 2 语句 ~60 tokens,-85%")

**流式三机制**:

1. **行级渐进解析**:每行自足,chunk 到达即重解析可见文本更新 React 树
2. **前向引用(Hoisting)+ 骨架**:强制顺序 Layout → Components → Data,root 必须第一行:

```text
root = Root([table]) // 引用在前…
// …(网络延迟)…
table = Table(rows)  // …定义在后
```

root 解析后发现 table 未定义 → 渲染 Skeleton;table 到达替换;rows 到达填数据。(当前实现修正:数组中未解析引用被**直接丢弃不留 null 洞**;无 nodePlaceholder API,占位主要靠 Query 默认值与组件自身 loading 态)

3. **解析器内部**(他们把 Rust/WASM 重写成 TS 反而快 3×):**Autocloser**——"makes partial (mid-stream) text syntactically valid by appending minimal closing brackets/quotes"(截断半行补齐再喂 lexer);**语句级增量缓存**——已完成语句永不重解析,每 chunk 只重解析尾部未完语句,O(N²)→O(N)。

**畸形输入**:按语句粒度丢弃、其余照常渲染;`meta.orphaned`(定义了但从 root 不可达 → 静默丢弃,系统提示词第 5 条专门警告 LLM)与 `meta.unresolved` 每 chunk 可查。

## F. 约束/校验

**契约 = Zod schema,键序即 ABI**:

```tsx
const List = defineComponent({
	name: 'List',
	description: 'List of items',
	props: z.object({ items: z.array(Item.ref) }),
	component: ({ props, renderNode }) => <div>{renderNode(props.items)}</div>,
});
```

**契约双向约束模型**:schema 一方面驱动解析期校验,另一方面**自动生成系统提示词里的组件签名**(`library.prompt()` / CLI `openui generate`)。"Changing key order breaks all existing LLM outputs"、"Required props must come before optional props"、prompt 与 schema 不同步则 "output will be garbled"。

**违约分层降级**(结构化上报 onError,格式适合回喂 LLM 自纠):`unknown-component/missing-required/null-required` → 丢语句;`excess-args` → 丢多余参数**仍渲染**;`runtime-error` → 回退原始值;`render-error` → 回退 last good state。每个错误带 `source/code/message/hint/statementId`,hint 会列出可用组件/工具名。

## G. 安全

1. **目录白名单是根本**:未注册组件名直接丢弃;模型永远不能生成任意 HTML/JS
2. **工具白名单**:Query/Mutation 只能命中 toolProvider 显式提供的函数;表达式语言封闭(无 eval)
3. root 约束收敛输出形状
4. **防误导性拼装 UI:规范沉默**(与另两家相同的弱点)

## C1 与开源的关系

C1 是 Thesys 原商业 API(输出嵌套 JSON,即 benchmark 里被打 -51.7% 的那个),OpenUI 是其开源化换代。OSS(MIT):语言规范、lang-core、渲染器、默认库、AgentInterface、CLI、benchmarks。Cloud 独占:对话存储、**模型输出错误检测与自动纠正闭环**、跨模型一致性、主题白标、可观测性。

## 对我们最值得抄的四个答案

1. 行式赋值 + 引用扁平化(而非嵌套树)是流式与增量编辑的共同基座
2. 事件三分法(本地状态/本地工具/回模型),回模型 payload = 人类可读意图 + 表单快照
3. Autocloser + 语句级增量缓存的两级流式解析
4. **Zod 键序 = 位置参数 ABI,schema 同时生成校验器与提示词**(防两者漂移——我们 1-based 事故的系统性解法)
