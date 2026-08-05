# UI 代码审查整改清单

> 生成时间：2026-08-05  
> 覆盖范围：`src/sessions/browser/`、`src/sessions/services/*/browser/`、`src/sessions/base/browser/`、`src/sessions/contrib/`

## 最高优先级（建议本周内修复）

### Services / State

- [ ] **修复 `DerivedObservable.get()` 不缓存**  
      文件：`src/sessions/base/common/observable.ts:58-61`  
      动作：`get()` 直接返回 `this.currentValue`，不要每次调用 `read()`。

- [ ] **处理 Workbench 初始化失败**  
      文件：`src/sessions/browser/workbench.ts:139-141,156`  
      动作：`void initialize()` 改 `catch(reportFailure(...))` 或统一 await 并展示启动错误。

- [ ] **处理 data browse 异步错误**  
      文件：`src/sessions/browser/parts/auxiliaryBarPart.ts:163`  
      动作：`await tab?.dataView?.applyBrowseRequest(browse)` 并 catch 错误。

- [ ] **处理 git 分支刷新/切换错误**  
      文件：`src/sessions/browser/parts/conversationContext.ts:65,75,252`  
      动作：`refreshBranches()` / `checkout()` 加 try/catch，渲染 `branchError`。

### React / Components

- [ ] **修复 `SurfacePanel.tsx` 嵌套组件导致 remount**  
      文件：`src/sessions/browser/parts/agentUi/components/SurfacePanel.tsx:204`  
      动作：把 `SurfaceNodeView` 移到模块顶层，通过 props/context 传递状态函数。

### CSS / Theme

- [ ] **放宽 `ThemeId` 限制，让自定义 presets 可注册**  
      文件：`src/sessions/platform/theme/theme.ts:16` + `src/sessions/common/themePresets.ts`  
      动作：`ThemeId` 改为 `string` 或给 presets 单独注册路径。

- [ ] **修复 sidebar 搜索框无条件 focus outline**  
      文件：`src/sessions/browser/parts/media/sidebarPart.css:1070-1074`  
      动作：把 `outline` 移到 `.sessions-settings-search:focus-visible`。

- [ ] **删除 `sessionView.css` 重复 overflow 规则**  
      文件：`src/sessions/browser/parts/media/sessionView.css:727-734`  
      动作：删除 `.conversation-work-step-chip` 中重复的 overflow 块。

## 中优先级（建议本月内处理）

### Services / State

- [ ] **`subscribe()` 同步 emit 当前值**  
      文件：`src/sessions/base/common/observable.ts:63-79`  
      动作：在 `subscribe()` 内立即调用 `listener(currentValue)`。  
      **状态：经探索后本次跳过**，避免破坏现有订阅语义；未来如需可新增 opt-in helper。

- [x] **合并 `sessionsService` 重复 `syncPart`**  
      文件：`src/sessions/services/sessions/browser/sessionsService.ts:62-69`  
      动作：用 microtask coalescing 合并同一事件循环内的多次调用。

- [x] **清理 `auxiliaryBarPart` / `sidebarPart` 重复注册泄漏**  
      文件：`src/sessions/browser/parts/auxiliaryBarPart.ts:169-188`、`src/sessions/browser/parts/sidebarPart.ts:35-48`  
      动作：由 `part.ts` create guard 统一防御。

- [x] **移除 workbench sash 未清理的监听器**  
      文件：`src/sessions/browser/workbench.ts:187-252`  
      动作：`Workbench extends Disposable`，sash 监听器注册到 `sashDisposables`。

- [x] **`settingsPrefs` system-mode 媒体监听泄漏**  
      文件：`src/sessions/browser/parts/settingsPrefs.ts:151,174-179`  
      动作：每次 `applyUiPreferences` 先移除旧监听器，再按需重新注册。

- [x] **处理 actionbar action 错误**  
      文件：`src/sessions/base/browser/ui/actionbar/actionbar.ts:143-156`  
      动作：`run()` 内部 catch 并 `reportFailure`；`render()` 加 guard。

- [x] **处理 `part.ts` `create()` 可被多次调用**  
      文件：`src/sessions/browser/part.ts:26-29`  
      动作：加 `created` guard。

### React / Components

- [x] **拆分 `conversationView.ts`**（部分完成）  
      文件：`src/sessions/browser/parts/conversationView.ts`（1838 行）  
      动作：已提取风险最低的 `TimelineRail` 到 `timelineRail.ts`；剩余 `ApprovalDock`、`TranscriptView`、`ComposerView` 因与主视图深度交织，建议单独 PR 继续拆分。

- [x] **清理 `MessageRow.tsx` / `Markdown.tsx` 直接 DOM mutation**  
      文件：`src/sessions/browser/parts/agentUi/components/MessageRow.tsx:240,250`、`Markdown.tsx:24`  
      动作：`useBubbleCollapse` 改用 `useLayoutEffect` 并移除 `dataset` 直接写入；`Markdown` 改用 `useLayoutEffect`。

- [x] **移除 `PlanCard.tsx` / `FieldMappingView.tsx` 非必要断言**  
      文件：`src/sessions/browser/parts/agentUi/components/PlanCard.tsx:121,124,130`、`FieldMappingView.tsx:25-27`  
      动作：用 narrowing 替代 `sessionId!`，给 node data 类型更窄定义。

### CSS / Theme

- [x] **把 ad-hoc border `color-mix` 换为 token**  
      文件：`newSessionView.css`、`sessionView.css`、`sidebarPart.css`、`composerMentions.css`  
      动作：12 处 `color-mix(in srgb, text-primary 15%, transparent)` 已替换为 `var(--vscode-agents-color-panel-border)`。

- [x] **补全 `focus-visible`**  
      文件：`style.css`、 `auxiliaryBarPart.css`、 `composerMentions.css`、 `sessionView.css`、 `searchPalette.css`  
      动作：给 sash、auxiliary tab close、image remove button、search palette rows/tabs、context tooltip 等交互元素加 focus ring。

- [x] **添加 `prefers-reduced-motion` 回退**  
      文件：`style.css`  
      动作：全局重置 transition/animation。

- [x] **token 化硬编码尺寸**  
      文件：`sizes.ts`、`style.css`、`auxiliaryBarPart.css`、`sessionView.css`、`sidebarPart.css`  
      动作：注册 sash width、message avatar、auxiliary tab height、toggle switch、dialog widths、providers rail、body0 font 等 token 并替换。

- [x] **修复 `themeSeed.ts` light 表面强制纯白**  
      文件：`src/sessions/common/themeSeed.ts:218`  
      动作：light surface 也按 elevation step 渐变，并通过 snap-to-white 阈值保持 shipped light 主题像素一致；custom light seed 获得真实层次。

## 低优先级 / 优化项

- [ ] `actionbar.css` `.action-item` `display: block` 与 flex 属性冲突  
      文件：`src/sessions/base/browser/ui/actionbar/actionbar.css:25-30`
- [ ] `titlebarpart.css` `--workbench-aux-width` 无 fallback  
      文件：`src/sessions/browser/parts/media/titlebarpart.css:21-34`
- [ ] `runLogView.css` 按钮/行高硬编码、`runlog-refresh` 与 `runlog-step-btn` 重复规则  
      文件：`src/sessions/browser/parts/media/runLogView.css`
- [ ] `composerMentions.css` 字号用 `0.9em`/`0.85em` 而非 token  
      文件：`src/sessions/browser/parts/media/composerMentions.css:53-69,93`
- [ ] `sidebarPart.css` 多个 `em` 字号、重复 `min-height`、巨型选择器分组  
      文件：`src/sessions/browser/parts/media/sidebarPart.css`
- [ ] `conversationContextBar.css` 实际为空文件，样式散落在 `sessionView.css`  
      文件：`src/sessions/browser/parts/media/conversationContextBar.css`
- [ ] `newSessionView.css` watermark `78vw` 魔法数字  
      文件：`src/sessions/browser/parts/media/newSessionView.css:29`
- [ ] `dataBrowserView.css` 用 space token 作为 height  
      文件：`src/sessions/contrib/data/browser/media/dataBrowserView.css:23-33`
- [ ] `sessionView.css` 中 cursor 约定不一致（`pointer` vs `default`）  
      文件：`src/sessions/browser/parts/media/sessionView.css:1017-1030`
- [ ] 补充 UI 组件/交互测试（PlanCard、SurfacePanel、FieldMappingView、MessageRow）
- [ ] 拆分 `sessionView.css`（2241 行）和 `sidebarPart.css`（2780 行）

## 统计

| 维度               | 最高优先级 | 中优先级 | 低优先级 |
| ------------------ | ---------- | -------- | -------- |
| React / Components | 1          | 3        | -        |
| Services / State   | 4          | 8        | 若干     |
| CSS / Theme        | 3          | 9        | 若干     |

---

**下一步：** 告诉我先处理哪 1-2 项，我进入 plan mode 出方案。
