# VS Code Agents Window 架构梳理与重做约束

## 目标

本轮重做的目标不是做一个“VS Code 风格”的聊天页面，而是从空白仓库重建一个桌面 Agent Chat 客户端，视觉和结构对齐 VS Code 的 `Agents Window`。

边界：

- provider 只使用 mock 数据。
- 交付形态是桌面 App。
- UI 以 VS Code `src/vs/sessions` 的 Agents Window 为源码事实，不再沿用旧 React 原型。
- 技术栈和架构风格保持 VS Code 一致：TypeScript、Electron、原生 DOM parts、CSS token、service/contribution 组织。

## 源码事实入口

本次对齐的主参考路径来自 VS Code 仓库：

| 主题 | 源码路径 |
|---|---|
| Agents Window 总览 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/README.md` |
| 布局规格 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/LAYOUT.md` |
| per-session 布局状态 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/LAYOUT_CONTROLLER.md` |
| sessions list 行为 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/SESSIONS_LIST.md` |
| desktop 入口聚合 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/sessions.desktop.main.ts` |
| common 入口聚合 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/sessions.common.main.ts` |
| Electron renderer 启动 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/electron-browser/sessions.ts` |
| Electron workbench main | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/electron-browser/sessions.main.ts` |
| Workbench shell | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/browser/workbench.ts` |
| Sessions Part | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/browser/parts/sessionsPart.ts` |
| Session View | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/browser/parts/sessionView.ts` |
| Session 数据模型 | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/services/sessions/common/session.ts` |
| Provider contract | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/services/sessions/common/sessionsProvider.ts` |
| 颜色 token | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/common/theme.ts` |
| 字体 token | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/common/sizes.ts` |
| Agents Window CSS | `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions/browser/media/style.css` |

## VS Code 分层架构

VS Code 主体是分层架构：

| 层 | 职责 | 对本项目的影响 |
|---|---|---|
| `vs/base` | DOM、事件、生命周期、observable、grid/splitview 等基础能力 | 新项目需要保留 `Emitter`、`DisposableStore`、observable、grid/sash 这类基础模型 |
| `vs/platform` | DI、commands、menus、storage、theme、context key 等平台服务 | 新项目需要保留 service collection、menu/action registry、theme token、storage key 思路 |
| `vs/editor` | Monaco/editor 相关实现 | 本项目首版不复刻编辑器，只保留 editor part 的占位和 modal/card 布局语义 |
| `vs/workbench` | 标准 VS Code workbench parts、services、contributions | 新项目借鉴 parts/contribution 架构，但只实现 Agents Window 需要的子集 |
| `vs/sessions` | Agents Window 顶层层，和 `vs/workbench` 平级 | 新项目目录应直接按 `sessions` 语义组织，而不是 `components/` SPA 结构 |

关键约束：`vs/sessions` 可以 import `vs/workbench` 和更底层模块，但 `vs/workbench` 不能反向 import `vs/sessions`。这说明 Agents Window 不是普通 chat feature，而是一个独立 workbench experience。

## Agents Window 运行入口

真实桌面启动链路：

1. `electron-browser/sessions.html` 只挂载 CSS 和 `sessions.js`。
2. `electron-browser/sessions.ts` 从 preload 读取 window configuration，显示 splash，然后 dynamic import `vs/sessions/sessions.desktop.main.js`。
3. `sessions.desktop.main.ts` import `sessions.common.main.ts`，再导入 desktop services、parts 和 sessions contributions。
4. `electron-browser/sessions.main.ts` 创建 `SessionsMain`，初始化 native services，然后创建 `new AgenticWorkbench(...)`。
5. `browser/workbench.ts` 的 `Workbench.startup()` 执行：
   - `initServices()`
   - `initLayout()`
   - `renderWorkbench()`
   - `createWorkbenchLayout()`
   - `createWorkbenchManagement()`

新项目应保留这个形态：

- HTML 极薄。
- Renderer 入口负责配置、主题初值、启动 workbench。
- `desktop.main.ts` / `common.main.ts` 用 import 聚合 contributions。
- Workbench shell 负责 parts 生命周期和布局。

## Workbench 布局模型

真实布局不是三栏 CSS 页面，而是固定 workbench grid：

```text
root: vertical
├── Titlebar
└── Content Section: horizontal
    ├── Sidebar
    └── Right Section: vertical
        ├── Top Right: horizontal
        │   ├── Sessions Part
        │   ├── Editor hidden by default
        │   └── Auxiliary Bar
        └── Panel hidden by default
```

默认可见性：

| Part | 默认状态 | 职责 |
|---|---|---|
| Titlebar | visible | session picker、窗口/布局 actions、account |
| Sidebar | visible | sessions list |
| Sessions Part | visible | 一个或多个 session views 的内部 grid |
| Editor | hidden | 显式 editor workflow，占位或 modal |
| Auxiliary Bar | visible | Changes、Files 等 session details |
| Panel | hidden | Terminal、debug output |

布局优先级：

| Part | Priority | 行为 |
|---|---|---|
| Sidebar | Low | 默认 300px，snap close，不能吸收 resize delta |
| Sessions Part | High | 唯一 flexible view，吸收横向 resize delta |
| Editor | Normal | 默认隐藏，显示后保持用户宽度 |
| Auxiliary Bar | Low | 默认约 340px，保持用户宽度 |

必须保留的视觉事实：

- Sidebar flush，不是 card。
- Sessions Part、Auxiliary Bar、Panel 是 card 外观。
- Shell 使用 `agents.background` 和右下角 tint gradient。
- Sessions Part 左 margin 约 10px，右/下 margin 随 aux/panel 可见性变化。
- Header/chat 内容居中限宽，chat viewport 本身保持 full width，让 scrollbar 贴右边。

## Parts 架构

真实 parts 不是 React components，而是带生命周期的 class：

| Part | 继承/角色 | 新项目映射 |
|---|---|---|
| `TitlebarPart` | extends `Part` | `browser/parts/titlebarPart.ts` |
| `SidebarPart` | extends `AbstractPaneCompositePart` | `browser/parts/sidebarPart.ts`，首版可用简化 pane composite |
| `SessionsPart` | extends `Part` | `browser/parts/sessionsPart.ts`，内部拥有 session view grid |
| `SessionView` | implements `ISerializableView` | `browser/parts/sessionView.ts` |
| `AuxiliaryBarPart` | extends `AbstractPaneCompositePart` | `browser/parts/auxiliaryBarPart.ts` |
| `EditorPart` | workbench editor part override | 首版 hidden/card placeholder |
| `PanelPart` | pane composite part | 首版 hidden/card placeholder |

`SessionsPart` 的关键职责：

- 自己不是 chat view。
- 内部有 `SerializableGrid<SessionView>`。
- 根据 `visibleSessions` reconcile slot 数量。
- slot 按位置复用，不因为 active session 改变而重建。
- active slot 加 `.is-active`，inactive session 降低视觉权重。
- 支持未来多 session 并排和 maximize。

`SessionView` 的关键职责：

- 组合 `SessionHeader`、`ChatCompositeBar`、`SessionReadOnlyBanner`、`ChatView`。
- Header 与 tabs 放在 centered content container，最大宽度约 950px。
- Chat content container 保持 full width。
- 根据 session 状态选择 view kind：
  - `newSession`
  - `newChatInSession`
  - `chat`

## Sessions 数据流

真实数据流分三层：

```text
ISessionsProvider
  -> ISessionsManagementService
  -> ISessionsService / VisibleSessions
  -> ISessionsPartService
  -> SessionsPart / SessionView
```

各层职责：

| 层 | 真实职责 | 新项目约束 |
|---|---|---|
| `ISessionsProvider` | provider contract，拥有 session list、workspace、create/send/archive/rename 等能力 | 只实现 `MockSessionsProvider`，但接口不要直接变成 UI mock JSON |
| `ISessionsManagementService` | 聚合所有 providers，处理 session CRUD 和 provider 事件 | 保留 service 边界，首版实现 mock 聚合 |
| `ISessionsService` | 视图态：active session、visible sessions、open/close/pin/focus/restore | 保留 observable view-state，不让 view 直接 mutate provider |
| `SessionsPartService` | part facade：update visible sessions、focus、maximize | 保留 passive renderer 模式 |
| `SessionsPart` | 纯渲染/reconcile | 不读取 provider，不拥有数据源 |

数据模型要从源码简化，但保留语义：

- `ISession`
- `IActiveSession`
- `IChat`
- `ISessionWorkspace`
- `ISessionChangesSummary`
- `SessionStatus`
- `ChatInteractivity`
- `ISessionCapabilities`

## Sessions List 语义

Sidebar 里的 sessions list 不是普通列表。真实语义包括：

- section 顺序：Pinned、Chats、Groups、Regular、Done/Archived。
- row 内容：status icon、title、workspace badge、diff stats、status/timestamp、approval row。
- grouping：By Workspace / By Date。
- sorting：By Created / By Updated。
- filtering：session type、status、archived、read、agent host。
- active session 永远可见。
- pin/read/group/reorder 属于 UI-only 本地状态，不同步给 provider。

首版可只实现视觉和核心交互子集，但 DOM 结构和样式必须按真实 list 设计，不再用普通 sidebar card list。

## Theme 与尺寸 token

新项目必须创建 VS Code 风格 token 层：

| Token 类别 | 来源 |
|---|---|
| shell background | `agents.background` |
| panel card background | `agentsPanel.background` |
| panel foreground | `agentsPanel.foreground` |
| panel border | `agentsPanel.border` |
| gradient tint | `agentsGradient.tintColor` |
| chat input | `agentsChatInput.*` |
| new session button | `agentsNewSessionButton.*` |
| badges | `agentsBadge.*`、`agentsUnreadBadge.*` |
| session view active/inactive | `activeSessionView.*`、`inactiveSessionView.*` |
| font sizes | `agents.fontSize.heading1/2/3/body1/body2/label1/label2/label3` |
| font weights | `agents.fontWeight.regular/semiBold` |

首版不要使用 Lucide 图标；图标应使用 VS Code Codicons。

## 技术栈约束

旧原型的问题是使用了普通前端 app 技术栈：React、Zustand、Lucide、Vite 风格 component tree。这个方向与 VS Code Agents Window 的真实架构不一致，本轮禁止继续使用。

新的技术栈：

| 分类 | 选择 | 说明 |
|---|---|---|
| Runtime | Electron desktop | 对齐 VS Code 桌面交付形态 |
| Language | TypeScript ESM | 对齐 VS Code 源码 |
| UI | 原生 DOM class + CSS | 不使用 React/Vue/Svelte |
| Component model | `Part` / `View` class lifecycle | 对齐 workbench parts |
| State | `Emitter`、`DisposableStore`、observable value | 对齐 VS Code 事件/生命周期模型 |
| DI | `ServiceCollection` + service identifiers + singleton registry | 对齐 VS Code platform/instantiation 思路 |
| Actions | command/action/menu registry | 对齐 titlebar、sidebar、header、auxiliary actions |
| Theme | CSS variables + registered token table | 对齐 `theme.ts` / `sizes.ts` |
| Icons | `@vscode/codicons` | 不使用 Lucide |
| Layout | grid/splitview/sash model | 不用纯 CSS grid 伪装整体 workbench |
| Tests | Playwright screenshot/e2e + TypeScript unit tests | 对齐 UI 验收需求 |
| Build | npm scripts + TypeScript + Electron bundling | 不使用 React/Vite app scaffold |

版本基准从当前 VS Code 仓库 `package.json` 读取：

- `electron`: `42.5.0`
- `typescript`: `^6.0.0-dev.20260416`
- `@playwright/test`: `^1.61.1`
- `@vscode/codicons`: repo dependency

如果外部 npm 无法安装 VS Code 当前 dev 版 TypeScript，则实现时应先以本机可安装的最近版本启动，但文档中记录偏差；不要因此换回 React/Vite。

## 新仓库目录设计

建议新仓库结构直接映射 `src/vs/sessions`：

```text
src/
  main/
    main.ts
  preload/
    preload.ts
  sessions/
    sessions.desktop.main.ts
    sessions.common.main.ts
    electron-browser/
      sessions.html
      sessions.ts
      sessions.main.ts
    browser/
      workbench.ts
      layoutPolicy.ts
      parts/
        titlebarPart.ts
        sidebarPart.ts
        sessionsPart.ts
        sessionView.ts
        sessionHeader.ts
        chatCompositeBar.ts
        chatView.ts
        auxiliaryBarPart.ts
        editorPart.ts
        panelPart.ts
      media/
        style.css
      parts/media/
        titlebarpart.css
        sidebarPart.css
        sessionsPart.css
        sessionView.css
        chatCompositeBar.css
        auxiliaryBarPart.css
    common/
      theme.ts
      sizes.ts
      contextkeys.ts
    platform/
      actions/
      instantiation/
      lifecycle/
      observable/
      theme/
    services/
      sessions/common/
        session.ts
        sessionsProvider.ts
        sessionsManagement.ts
      sessions/browser/
        sessionsProvidersService.ts
        sessionsManagementService.ts
        sessionsService.ts
        visibleSessions.ts
        sessionsPartService.ts
    contrib/
      mockProvider/browser/
        mockSessionsProvider.ts
        mockSessions.contribution.ts
      sessions/browser/
        sessionsList.ts
        sessionsView.ts
      changes/browser/
        changesView.ts
      files/browser/
        filesView.ts
```

这不是最终文件清单，而是架构边界。实现计划再把它拆成可测试任务。

## 第一阶段验收标准

第一阶段先验证“架构正确”，再追视觉细节：

- 没有 React/Zustand/Lucide/Vite scaffold。
- Electron app 可以打开空 workbench。
- DOM 根节点使用 VS Code 风格类名：`.monaco-workbench.agent-sessions-workbench`。
- Workbench 有真实 parts 生命周期。
- `SessionsPart` 是 central flexible view，`priority = High`。
- `MockSessionsProvider` 通过 provider service 注册，不被 UI 直接 import。
- Sidebar、Sessions Part、Auxiliary Bar 的 DOM 层级和 CSS class 名接近 VS Code。
- screenshot 对比目标尺寸：`1440x900`、`1280x720`。

## 后续计划

下一步不是直接写 UI，而是先写完整 implementation plan，按任务拆：

1. Scaffold Electron + TypeScript ESM + Codicons。
2. 实现最小 platform primitives：lifecycle、event、observable、instantiation、actions、theme。
3. 实现 Workbench shell 和 fixed grid layout。
4. 实现 parts：titlebar、sidebar、sessions part、auxiliary bar、editor/panel placeholder。
5. 实现 sessions service chain 和 mock provider。
6. 实现 session view、header、chat tabs、chat transcript、composer 的 1:1 视觉。
7. 实现 sidebar sessions list 的 section/row 视觉。
8. 加 Playwright screenshot 验收，逐轮修正与 VS Code Agents Window 的差异。

实现前需要最终确认：是否接受“架构/技术栈与 VS Code 保持一致，但只实现 mock provider 和视觉所需子集”的边界。
