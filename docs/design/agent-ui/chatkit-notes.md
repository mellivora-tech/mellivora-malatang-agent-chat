# OpenAI ChatKit Widget 系统深读笔记

> 来源权威性:schema 唯一完整定义是公开的 [chatkit-js widgets.d.ts](https://github.com/openai/chatkit-js/blob/main/packages/chatkit/types/widgets.d.ts)(597 行);服务端完全开源([openai/chatkit-python](https://github.com/openai/chatkit-python):widgets.py 1193 行 Pydantic、actions.py、types.py 线协议);**客户端渲染器闭源**(chatkit.js 从 OpenAI CDN 分发,渲染实现不可审查)。文档:chatkit-widgets/chatkit-actions 指南、chatkit-python guides。可视化设计器 widgets.chatkit.studio 导出 `.widget` 文件。

## A. 组件目录

**两层:Root(容器)+ Component(节点),封闭联合类型**:

```ts
export type WidgetRoot = Card | ListView | BasicRoot;

export type WidgetComponent =
	| TextComponent
	| Title
	| Caption
	| Badge
	| Markdown
	| Box
	| Row
	| Col
	| Divider
	| Icon
	| Image
	| Button
	| Checkbox
	| Spacer
	| Select
	| DatePicker
	| Form
	| Input
	| Label
	| RadioGroup
	| Table
	| TableRow
	| TableCell
	| Textarea
	| Transition;
```

外加只能做 ListView 直接子节点的 `ListViewItem`。**3 root + 26 component**。

**粒度**:原子为主,仅 3 个模式级容器(Card 带 status/confirm/cancel 的确认卡、ListView、Form)。布局 flexbox 词汇(Box/Row/Col/Spacer/Divider,Row/Col 是 Box 的方向糖),文本四档(Text/Title/Caption/Markdown)。没有 Chart/Tab/Accordion/Modal:

```ts
type BoxBaseProps = {
	children?: WidgetComponent[];
	align?: Alignment; // 'start'|'center'|'end'|'baseline'|'stretch'
	justify?: Justification; // 'start'|'center'|'end'|'between'|'around'|'evenly'|'stretch'
	wrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
	flex?: number | string;
	gap?: number | string;
	padding?: number | string | Spacing;
	border?: number | Border | Borders;
	background?: string | ThemeColor; // ThemeColor = { dark; light }
} & BlockProps; // height/width/minSize/maxSize/aspectRatio/radius/margin
```

**嵌套即 children 数组递归**(真实 .widget 导出):

```json
{
	"type": "Card",
	"size": "md",
	"children": [
		{ "type": "Row", "children": [{ "type": "Text", "value": "#proj-chatkit" }, { "type": "Spacer" }, { "type": "Text", "value": "4:48 PM", "color": "tertiary" }] },
		{ "type": "Divider", "flush": true },
		{
			"type": "Row",
			"align": "start",
			"gap": 4,
			"children": [
				{ "type": "Image", "src": "/zj.png", "size": 44 },
				{
					"type": "Col",
					"children": [
						{ "type": "Text", "value": "Zach Johnston", "weight": "semibold" },
						{ "type": "Markdown", "value": "End of week update…" }
					]
				}
			]
		}
	]
}
```

每节点可选 `key`(diff 锚点,类似 React key)和 `id`(流式文本锚点)。Card 关键字段:`asForm?/status?/collapsed?/confirm?: CardAction/cancel?: CardAction`,`CardAction = { label, action: ActionConfig }`。图标封闭枚举(~60 个,**不允许任意 SVG**)。

## B. 交互能力

**全部交互 = 节点属性挂 ActionConfig,无独立事件节点**:

| 交互     | 载体                                                      | 属性                                                                  |
| -------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| 点击     | Button                                                    | `onClickAction?: ActionConfig`(另有 `submit?: boolean` 触发所在 Form) |
| 整行点击 | ListViewItem                                              | `onClickAction`                                                       |
| 表单提交 | Form / Card(asForm)                                       | `onSubmitAction` / `confirm.action`                                   |
| 值变更   | Select/DatePicker/Checkbox/RadioGroup                     | `onChangeAction`                                                      |
| 文本编辑 | Input/Textarea,以及 **`Text.editable`**(就地编辑已有文本) | 无 action,值进表单 payload                                            |
| 命令式   | 宿主代码                                                  | `chatkit.sendCustomAction({type, payload}, widgetItemId)`             |

`Text.editable` 是最接近直接操纵的设计——渲染出的文本点击变输入框:`editable: false | { name; autoFocus?; autoSelect?; pattern?; placeholder?; required? }`。**没有拖拽/排序**;文档明言复杂表单不适合 widget,推荐 client action 弹自家 modal 再 sendCustomAction 回传。

## C. 事件模型(核心)

**声明**(flight_options.widget 真实模板输出):

```json
{ "type": "ListViewItem", "key": "opt_123",
  "onClickAction": {
    "type": "select_flight",
    "handler": "server",
    "payload": { "id": "opt_123", "leg": "outbound" } },
  "children": [ ... ] }
```

ActionConfig 完整 schema(actions.py):

```python
Handler = Literal["client", "server"]
LoadingBehavior = Literal["auto", "none", "self", "container"]

class ActionConfig(BaseModel):
    type: str
    payload: Any = None
    handler: Handler = "server"
    loadingBehavior: LoadingBehavior = "auto"
    streaming: bool = True
```

**关键设计:action 不是聊天 turn,是独立线协议请求**:

```python
class ThreadsCustomActionReq(BaseReq):
    type: Literal["threads.custom_action"]
    params: ThreadCustomActionParams   # { thread_id, item_id, action: {type, payload} }
```

服务端不进 `respond()`(用户消息通道),进专门的 `action()` 方法(签名带触发的 WidgetItem):

```python
async def action(self, thread, action, sender: WidgetItem | None, context) -> AsyncIterator[ThreadStreamEvent]:
    if action.type == "send_message":
        await send_to_chat(action.payload["text"])
        # 让模型下一轮"看见"这次交互:手动写 HiddenContextItem(不下发客户端)
        hidden = HiddenContextItem(..., content=f"User sent message: {action.payload['text']}")
        await self.store.add_thread_item(thread.id, hidden, context)
        # 原地刷新 widget:
        async for event in stream_widget(thread, updated_widget, generate_id=...):
            yield event
```

三个重要结论:

1. **action() 返回与 respond() 相同的事件流**——可流回消息、只更新 widget、或纯副作用。**widget 原地更新不需要完整 agent turn**
2. **模型可见性是手动的**:action 不自动进模型上下文,官方模式写 HiddenContextItem
3. 另有 `threads.sync_custom_action` 同步变体(响应 `{updated_item}`,不开流直接换 item)

**客户端处理**:`handler: "client"` 路由到宿主回调,可再链回服务端:

```ts
useChatKit({
	widgets: {
		onAction: async (action, widgetItem) => {
			if (action.type === 'save_profile') {
				const result = await saveProfile(action.payload);
				await chatkit.sendCustomAction({ type: 'save_profile_complete', payload: { ...result } }, widgetItem.id);
			}
		},
	},
});
```

加载反馈声明式:`loadingBehavior: auto|self|container|none`(auto 按绑定位置推断:Button→self,Select.onChange→none,Card.confirm→container 整卡淡出并 inert)。

相邻机制:`ClientEffectEvent(name, data)` = 服务端→客户端 fire-and-forget UI 副作用(不落 thread);`ClientToolCall` = 推理中途暂停模型 round-trip 到浏览器(结果作为 function_call_output 回喂,每 turn 限一次)。

## D. 数据模型/绑定

**运行时零绑定——树即终态;绑定只在服务端模板阶段**。`.widget` 文件格式:

```json
{ "version": "1.0", "name": "Channel message",
  "template": "{\"type\":\"Card\",…\"value\":{{ (user.name) | tojson }}…}",   // Jinja2
  "jsonSchema": { "type": "object", "properties": { "user": {…} } },          // 数据契约
  "outputJsonPreview": { … },
  "encodedWidget": "…base64(Builder 的 JSX 源 + zod schema)…" }
```

服务端 `WidgetTemplate.from_file(...).build({...})` 渲染成纯 JSON 树下发。Builder 里作者写 JSX + zod,导出编译成 Jinja JSON 模板。

**表单值收集进 action payload,不存在双向 model**。字段靠 `name` 属性,支持点号路径嵌套(`name="todo.title"` → `payload["todo"]["title"]`)。编辑态由客户端 DOM 持有(defaultValue 非受控初值),提交瞬间快照:

```jsx
<Form direction="col" onSubmitAction={{ type: 'update_todo', payload: { id: todo.id } }}>
	<Text value={todo.title} editable={{ name: 'title', required: true }} />
	<Text value={todo.description} editable={{ name: 'description' }} />
	<Button label="Save" submit />
</Form>
```

规则:"Form 内发出的**任何** action 都注入全部字段最新值"(不止 submit)。payload 键冲突时表单值被丢弃并发 error 事件(文档自认 "probably a bug")。

## E. 流式/更新协议

Widget 是 thread item(`WidgetItem { type: "widget", widget: WidgetRoot, copy_text }`),更新走 ThreadItemUpdatedEvent,三种 widget 专用 patch:

```python
class WidgetStreamingTextValueDelta(BaseModel):
    type: Literal["widget.streaming_text.value_delta"]
    component_id: str; delta: str; done: bool

class WidgetComponentUpdated(BaseModel):
    type: Literal["widget.component.updated"]
    component_id: str; component: WidgetComponent     # 整节点替换

class WidgetRootUpdated(BaseModel):
    type: Literal["widget.root.updated"]
    widget: WidgetRoot                                # 整树替换
```

**服务端编程模型是"yield 整棵新树,框架做 diff"**:`stream_widget(thread, widget_or_async_generator)` 每 yield 一版完整 widget,SDK 自动 diff 发最小事件。文本级流式限制(verbatim):"Currently, only `<Text>` and `<Markdown>` components marked with an `id` have their text updates streamed. Other diffs will forgo the streaming UI and replace and rerender parts of the widget client-side." 同一 widget item 可在任意后续时刻被 patch,不限于生成它的那条消息。

## F. 约束/校验

1. 树校验:服务端 Pydantic + 客户端 TS 类型;.widget 的 jsonSchema 校验**模板输入数据**非输出树
2. 输入校验:仅 `required?/pattern?`(Input/Textarea/Text.editable)、DatePicker min/max。客户端原生表单校验,无自定义错误文案、无跨字段校验;复杂校验官方劝退("走 client action 弹自家 modal")
3. 服务端:"Treat action payloads as untrusted input from the client"——校验责任归集成方

## G. 安全

文档没有专门安全章节(防仿冒系统 UI/签名/验证:docs silent)。结构性事实:

- 目录封闭:封闭联合类型,无 HTML/JS/CSS 注入口,图标封闭枚举,样式只有令牌化属性——但没有机制阻止用 Card+Button 模仿确认对话框
- 图片域名白名单:`ThreadMetadata.allowed_image_domains`
- payload 不可信(见 F);widget 内容由服务端生成存储,客户端不能伪造 widget 本身(但 action payload 可伪造)
- 渲染器闭源,sanitization 不可审查;无签名/来源验证的任何记载

## 对我们最有信息量的五个答案

1. action 是独立协议通道而非聊天 turn,handler 二分 client/server
2. widget 更新 = 服务端 yield 整树 + 框架 diff 成三档 patch(text delta / component / root),`id` 是流式锚点、`key` 是 diff 锚点
3. 表单无数据模型——值在提交瞬间按 name 快照进 payload,点号路径展开
4. 交互后的模型可见性不自动,靠 HiddenContextItem 手工回写
5. 作者体验分层:Builder 写 JSX+zod → 导出 Jinja+JSONSchema 的 .widget → 运行时只传纯 JSON 树
