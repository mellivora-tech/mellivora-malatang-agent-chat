# A2UI 协议规范深读笔记

> 读取版本:A2UI Protocol **v1.0(Status: Candidate**,Created 2025-11-20,Last Updated 2026-06-08),来自 `github.com/google/A2UI` main 分支 `specification/v1_0/`。生产版本为 v0.9.1(仓库 README),Google 博客介绍的是更早的 v0.8。核心文件:`docs/a2ui_protocol.md`(主规范 1305 行)、`json/common_types.json`(绑定/动作/校验类型系统)、`catalogs/basic/catalog.json`(组件目录 1376 行)、`docs/a2ui_custom_functions.md`、`evolution_guide.md`、`docs/public/concepts/actions.md`。

**总体架构一句话**:服务端(agent)→客户端单向 JSON 消息流(`createSurface` / `updateComponents` / `updateDataModel` / `deleteSurface` / `actionResponse` / `callFunction`),客户端→服务端回传 `action` / `functionResponse` / `error`。UI 结构(组件扁平表)与应用数据(每 surface 一棵 JSON data model)严格分离,靠 JSON Pointer 绑定。

## A. 组件目录

**Basic Catalog 全部 18 个组件**:

- 展示:`Text`(支持无 HTML/链接/图片的简化 Markdown)、`Image`、`Icon`(59 个闭合枚举名 + 自定义 SVG `{"path": "..."}`)、`Video`、`AudioPlayer`
- 布局:`Row`、`Column`、`List`、`Card`、`Tabs`、`Divider`、`Modal`
- 输入:`Button`、`TextField`、`CheckBox`、`ChoicePicker`、`Slider`、`DateTimeInput`

**粒度**:明确是**原子级**,不是模式级。没有 Form/Table/Chart/Header;Card 只是"带卡片样式的单子容器"。表单靠 `Column + TextField + Button` 组合。布局原语齐全:Row/Column 有 `justify`(`start/center/end/spaceBetween/spaceAround/spaceEvenly/stretch`)和 `align`,所有组件都有 `weight`(等价 flex-grow,只允许在 Row/Column 直接子级上设置)。样式几乎不可控——只有 `variant` 枚举(Text: `caption|body`,Button: `default|primary|borderless`),颜色/间距完全交给客户端原生主题(v1.0 特意删掉了 v0.9 的 `primaryColor`)。

**children/嵌套:扁平邻接表,全部按 ID 引用,禁止内联子组件**。整个 surface 是一个 flat list,必须恰有一个 `id: "root"`。多子用 `children`(ChildList),单子用 `child`(ComponentId):

```json
"components": [
  { "id": "root", "component": "Column", "children": ["user_name"] },
  { "id": "user_name", "component": "Text", "text": {"path": "/name"} }
]
```

Tabs 是唯一带内联结构的:`"tabs": [{"title": "...", "child": "some_component_id"}]`;Modal 用 `"trigger": "<id>", "content": "<id>"`。catalog 里反复强调 "Do NOT define the child component inline"。

**目录本身可换**(核心设计答案之一):envelope schema 通过 `$ref: "catalog.json#/$defs/anyComponent"` 占位引用目录,任何厂商可定义自己的 catalog(同构 JSON Schema:顶层 `components`/`functions` map,组件必须 `allOf: [ComponentCommon, 本地属性]`,`component` 字段做 discriminator 常量)。catalog 还有 `instructions` 字段——直接内嵌给 LLM 看的 Markdown 设计规则和 few-shot 例子。

## B. 交互能力

全部通过**专用输入组件 + 属性**表达,没有 `editable: true` 这种把展示组件变可编辑的机制:

| 交互     | 载体                                                                                              | 表达方式                   |
| -------- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| 点击     | `Button`(必填 `action`)                                                                           | `action` 属性              |
| 文本编辑 | `TextField`(`variant: longText/number/shortText/obscured`)                                        | `value` 双向绑定           |
| 勾选     | `CheckBox`                                                                                        | `value: DynamicBoolean`    |
| 单/多选  | `ChoicePicker`(`mutuallyExclusive/multipleSelection`,`displayStyle: checkbox/chips`,`filterable`) | `value: DynamicStringList` |
| 数值     | `Slider`(`min/max/steps` 离散吸附)                                                                | `value: DynamicNumber`     |
| 日期时间 | `DateTimeInput`(`enableDate/enableTime/min/max`)                                                  | ISO 8601 字符串            |
| 弹窗     | `Modal.trigger` 指向组件 ID                                                                       | 组件引用                   |
| Tab 切换 | `Tabs`(纯客户端本地,无事件)                                                                       | —                          |

**直接操纵(drag-sort、drag-line、resize):spec 完全沉默**。横切属性 `Checkable`(`checks` 数组)混入所有输入组件和 Button——Button 的 checks 失败时自动禁用。

## C. 事件模型(最重要)

声明:交互组件的 `action` 属性,`Action` 类型二选一 `oneOf`——**服务端事件**或**本地函数**:

```json
// 服务端事件(agent roundtrip)
{ "id": "submit_button", "component": "Button", "child": "submit_button_label",
  "action": { "event": {
      "name": "submit_form",
      "context": { "itemId": "123", "email": { "path": "/formData/email" } }
  } } }

// 本地动作(agent 不知情;"The agent is not informed of local function calls")
{ "action": { "functionCall": { "call": "openUrl", "args": { "url": "${/url}" } } } }
```

`event` 完整键:`name`(必填)、`context`(DynamicValue:字面量/path 绑定/函数调用)、`wantResponse`(默认 false)、`responsePath`(JSON Pointer,把服务端响应写回本地 data model)。

**点击流程**:① 客户端对 context 所有 path/函数求值(本地模型同步更新,保证 context 解析时数据最新)② 组装 payload ③ 发给创建该 surface 的 agent。**事件开启新的 agent turn**;agent 随后在 UI 流上继续发 updateComponents/updateDataModel——patch 是 turn 的产物而非独立通道。

**事件 payload verbatim**:

```json
{
	"version": "v1.0",
	"action": {
		"name": "submitForm",
		"surfaceId": "contact_form_1",
		"sourceComponentId": "submit_button",
		"timestamp": "2026-06-02T08:57:23Z",
		"context": { "isSubscribed": true },
		"wantResponse": true,
		"actionId": "form_submit_773"
	}
}
```

**v1.0 新增第三条路——不开完整 turn 的轻量 RPC**:`wantResponse: true` 时服务端用 `actionResponse` 同步应答(典型 typeahead),值经 `responsePath` 直接写进客户端 data model:

```json
// client → server
{ "version": "v1.0", "action": { "name": "get_typeahead_suggestions", "surfaceId": "mysurface",
  "sourceComponentId": "myinput", "context": { "prefix": "app" },
  "wantResponse": true, "actionId": "get_typeahead_suggestions_1" } }
// server → client
{ "version": "v1.0", "actionId": "get_typeahead_suggestions_1",
  "actionResponse": { "value": ["apple", "application", "approved"] } }
```

反方向还有 server 主动调用客户端注册函数的 `callFunction`/`functionResponse`,受目录 `callableFrom: clientOnly|remoteOnly|clientOrRemote` 运行时边界校验,违规返回 `error {code: "INVALID_FUNCTION_CALL"}`。

**结论:三档交互延迟模型**——纯本地(双向绑定/Tabs/functionCall,零网络)→ 轻量 RPC(action + actionResponse,patch 数据不重建 UI)→ 完整 agent turn。

## D. 数据模型/绑定

**独立于组件树的 data model**:每 surface 一棵 JSON 树,`createSurface.dataModel` 初始化、`updateDataModel` 更新。

**绑定语法**:JSON Pointer(RFC 6901),可绑定属性都是 `Dynamic*` 三态类型:

```json
"text": {"path": "/user/name"}                 // 路径绑定
"text": "John Doe"                              // 字面量
"text": {"call": "formatString", "args": {"value": "Hello, ${/user/firstName}!"}}  // 函数
```

表达式能力刻意收窄为**目录注册函数**——无通用表达式语言,字符串插值走 `formatString` 的 `${...}` 迷你语法(`${/absolute}`、`${relative}`、`${formatDate(value:${/d}, format:'yyyy-MM-dd')}`、嵌套 `${upper(${now()})}`,转义 `\${`)。

**列表模板 + 作用域**:ChildList 模板形态创建 Collection Scope,模板内不带 `/` 前缀的路径按当前项相对解析,`@index(offset: 1)` 取序号:

```json
{ "id": "employee_list", "component": "List",
  "children": { "path": "/employees", "componentId": "employee_card_template" } },
{ "id": "name_text", "component": "Text", "text": { "path": "name" } },
{ "id": "company_text", "component": "Text", "text": { "path": "/company" } }
```

**双向绑定**:输入组件与 data model 双向——读(model→view)+ 写(用户每次击键**立即**写回本地 model),响应式(同绑路径的 Text 随输入实时更新)。

**编辑状态归客户端**("local to the client",击键零网络)。**agent 读回两条途径**:

1. **action context 手挑**:事件 context 显式引用路径,随 action 送达
2. **`sendDataModel: true` 全量快照**:客户端把该 surface 完整 data model 附在每条 client→server 消息(包括自然语言 query)的 metadata:

```json
"metadata": { "a2uiClientDataModel": {
  "version": "v1.0",
  "surfaces": { "booking-surface": { "reservationTime": "7:00 PM", "partySize": 4 } } } }
```

只发给创建该 surface 的 agent(防泄漏)。**没有 delta 同步协议**——全量或手挑,增量上行 spec 沉默。

下行更新语义(upsert):path 存在则替换、不存在则创建、value 为 null 则删键、path 省略或 `/` 则整树替换。

## E. 流式/更新协议

**JSONL 消息流 + 组件级 upsert**,不是 JSON Patch 也不是全量替换。每行一个 envelope:

```jsonl
{"version": "v1.0", "createSurface":{"surfaceId":"contact_form_1","catalogId":"https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"}}
{"version": "v1.0", "updateComponents":{"surfaceId":"contact_form_1","components":[{"id":"root","component":"Card","child":"form_container"}]}}
{"version": "v1.0", "updateDataModel":{"surfaceId":"contact_form_1","path":"/contact","value":{"firstName":"John"}}}
{"version": "v1.0", "deleteSurface":{"surfaceId":"contact_form_1"}}
```

更新粒度:**组件按 id 整体 upsert**(重发同 id 覆盖,无组件内字段级 patch);**数据按 JSON Pointer 定点替换**。传输层不限(AG-UI 为标准绑定,另有 A2A/MCP/SSE+JSON-RPC/WebSocket)。MIME `application/a2ui+json`。

**渐进渲染是一等设计**:扁平表允许乱序到达;root 未定义前缓冲,root 到达即渲染;未定义引用优雅处理(占位/空串/loading)。生成侧 prompt-generate-validate 循环:校验失败以标准格式回喂 LLM 自纠——`{"error": {"code": "VALIDATION_FAILED", "path": "/components/0/text", "message": "Expected stringOrPath, got integer"}}`。

## F. 约束/校验

**`checks` 数组(CheckRule)+ 目录函数,纯客户端执行**。规范形态 `{"condition": <DynamicBoolean>, "message": <string>}`,内置校验函数 `required/regex/length/numeric/email`,可 `and/or/not` 组合:

```json
"checks": [
  { "condition": { "call": "required", "args": { "value": { "path": "/formData/zip" } } },
    "message": "Zip code is required" }
]
```

Button 挂 checks **任一失败自动禁用**——表单有效性 gating 声明化。agent 侧对用户数据的再校验 spec 沉默。

## G. 安全

1. **声明式数据而非可执行代码**;函数只能按名引用目录注册项,未注册严格校验失败
2. **Catalog allow-listing**:schema 层 `unevaluatedProperties: false` + discriminator 常量 + `$ref` 白名单
3. **执行边界**:`callableFrom` 由客户端运行时强制
4. **身份归属防伪装**:surfaceProperties 的 `iconUrl`/`agentDisplayName` 标示归属;多 agent 下 orchestrator 覆写/验证为已验证身份("preventing malicious agents from impersonating trusted services")
5. **数据定向投递**:快照只发给创建 surface 的 server

局限:对"假系统对话框"没有白名单+归属标签之外的专门机制;Icon 允许任意自定义 SVG path 与闭合枚举意图相抵。

## 规范与示例的不一致(3 处,警惕)

1. **checks 语法自相矛盾**:common_types.json 要求 `{condition, message}` 且 additionalProperties: false;但主规范 Contact Form 例子写扁平 `{"call":"required","args":{...},"message":"..."}`;catalog instructions 的例子更是连必填 message 都没有——三种写法并存
2. **updateDataModel 删除语义两说**:v1.0 改为"置 null 删键",但同文档消息定义处仍写 "If omitted, the key is removed"(v0.9 遗留)
3. **本地 action 例子的隐式插值**:openUrl 例子 `"url": "${/url}"` 裸字符串依赖未声明的隐式 formatString

## 对我们最可借鉴的四个答案

1. 扁平邻接表 + root 缓冲 = 流式渐进渲染的最省心解
2. `Dynamic*`(字面量|path|函数调用)三态类型统一绑定与表达式,天然可 schema 校验
3. 本地双向绑定 + action context 手挑 + sendDataModel 全量快照的三档同步,避开 delta 协议复杂度
4. catalog(组件 schema + 函数注册 + LLM instructions 三合一)= 白名单 + prompt 载体 + 校验器输入
