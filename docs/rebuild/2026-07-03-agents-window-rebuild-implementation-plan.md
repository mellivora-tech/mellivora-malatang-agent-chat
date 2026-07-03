# Agents Window Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Electron desktop Agent Chat client whose architecture and visual structure follow VS Code `src/vs/sessions` Agents Window, using only mock provider data.

**Architecture:** The app is a small VS Code-style workbench, not a React SPA. Renderer startup creates an `AgentWorkbench`, eager part services register `TitlebarPart`, `SidebarPart`, `SessionsPart`, `AuxiliaryBarPart`, hidden `EditorPart`, and hidden `PanelPart`; session data flows through `MockSessionsProvider -> SessionsManagementService -> SessionsService -> SessionsPartService -> UI`.

**Tech Stack:** Electron `42.5.0`, TypeScript ESM, native DOM classes, CSS variables/tokens, `@vscode/codicons`, VS Code-style lifecycle/event/observable/service primitives, Playwright screenshot verification.

## Global Constraints

- Provider only mock data; no real model/network/backend provider.
- Desktop App only.
- UI must replicate VS Code Agents Window structure from `/Users/sgx/workspace/code/learning-projects/mellivora-malatang/src/vs/sessions`.
- Do not use React, Vue, Svelte, Zustand, Lucide, or Vite app scaffold.
- Use Codicons for icons.
- Use TypeScript ESM and native DOM `Part`/`View` classes.
- Use CSS token names aligned to `agents.*`, `agentsPanel.*`, `agentsChatInput.*`, and `agents.fontSize.*`.
- Do not import source modules from the VS Code sibling repository at runtime.
- Keep implementation files focused; prefer small modules over large page files.
- Verification must include TypeScript checking and Playwright screenshots at `1440x900` and `1280x720`.

---

## File Structure

Repository root: `/Users/sgx/workspace/code/learning-projects/mellivora-malatang-agent-chat`

Create this structure:

```text
package.json
tsconfig.json
playwright.config.ts
.gitignore
scripts/copy-assets.mjs
src/main/main.ts
src/preload/preload.ts
src/sessions/sessions.common.main.ts
src/sessions/sessions.desktop.main.ts
src/sessions/electron-browser/sessions.html
src/sessions/electron-browser/sessions.ts
src/sessions/electron-browser/sessions.main.ts
src/sessions/base/browser/dom.ts
src/sessions/base/browser/grid.ts
src/sessions/base/common/event.ts
src/sessions/base/common/lifecycle.ts
src/sessions/base/common/observable.ts
src/sessions/base/common/uri.ts
src/sessions/platform/actions/actions.ts
src/sessions/platform/contextkey/contextkey.ts
src/sessions/platform/instantiation/instantiation.ts
src/sessions/platform/storage/storage.ts
src/sessions/platform/theme/theme.ts
src/sessions/browser/workbench.ts
src/sessions/browser/part.ts
src/sessions/browser/parts/titlebarPart.ts
src/sessions/browser/parts/sidebarPart.ts
src/sessions/browser/parts/sessionsPart.ts
src/sessions/browser/parts/sessionView.ts
src/sessions/browser/parts/sessionHeader.ts
src/sessions/browser/parts/chatCompositeBar.ts
src/sessions/browser/parts/chatView.ts
src/sessions/browser/parts/auxiliaryBarPart.ts
src/sessions/browser/parts/editorPart.ts
src/sessions/browser/parts/panelPart.ts
src/sessions/browser/media/style.css
src/sessions/browser/parts/media/titlebarpart.css
src/sessions/browser/parts/media/sidebarPart.css
src/sessions/browser/parts/media/sessionsPart.css
src/sessions/browser/parts/media/sessionView.css
src/sessions/browser/parts/media/chatCompositeBar.css
src/sessions/browser/parts/media/auxiliaryBarPart.css
src/sessions/common/contextkeys.ts
src/sessions/common/sizes.ts
src/sessions/common/theme.ts
src/sessions/services/sessions/common/session.ts
src/sessions/services/sessions/common/sessionsProvider.ts
src/sessions/services/sessions/common/sessionsManagement.ts
src/sessions/services/sessions/browser/sessionsProvidersService.ts
src/sessions/services/sessions/browser/sessionsManagementService.ts
src/sessions/services/sessions/browser/visibleSessions.ts
src/sessions/services/sessions/browser/sessionsService.ts
src/sessions/services/sessions/browser/sessionsPartService.ts
src/sessions/contrib/mockProvider/browser/mockSessionsProvider.ts
src/sessions/contrib/mockProvider/browser/mockSessions.contribution.ts
src/sessions/contrib/sessions/browser/sessionsList.ts
src/sessions/contrib/changes/browser/changesView.ts
src/sessions/contrib/files/browser/filesView.ts
tests/unit/visibleSessions.test.ts
tests/unit/sessionsManagementService.test.ts
tests/e2e/agents-window.spec.ts
```

---

### Task 1: Electron TypeScript Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `scripts/copy-assets.mjs`
- Create: `src/main/main.ts`
- Create: `src/preload/preload.ts`
- Create: `src/sessions/electron-browser/sessions.html`
- Create: `src/sessions/electron-browser/sessions.ts`
- Create: `src/sessions/electron-browser/sessions.main.ts`
- Create: `src/sessions/sessions.common.main.ts`
- Create: `src/sessions/sessions.desktop.main.ts`

**Interfaces:**
- Produces `npm run typecheck`, `npm run build`, and `npm start`.
- Produces renderer root HTML at `dist/sessions/electron-browser/sessions.html`.
- Produces a window with `BrowserWindow` loading the copied HTML.

- [ ] **Step 1: Create package and compiler config**

`package.json` must use these dependency names and scripts:

```json
{
  "name": "mellivora-malatang-agent-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main/main.js",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json && node scripts/copy-assets.mjs",
    "start": "npm run build && electron dist/main/main.js",
    "test": "npm run test:unit",
    "test:unit": "npm run build && node --test dist/tests/unit/*.test.js",
    "test:e2e": "npm run build && playwright test",
    "verify": "npm run typecheck && npm run test:unit && npm run test:e2e"
  },
  "dependencies": {
    "@vscode/codicons": "^0.0.46-21"
  },
  "devDependencies": {
    "@playwright/test": "^1.61.1",
    "@types/node": "24.x",
    "electron": "42.5.0",
    "typescript": "^6.0.0-dev.20260416"
  }
}
```

If `npm install` cannot resolve `typescript@^6.0.0-dev.20260416`, use the closest installable TypeScript version and record the exact installed version in this plan under the task notes before continuing.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "rootDir": ".",
    "outDir": "dist",
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "playwright.config.ts"]
}
```

- [ ] **Step 2: Add asset copy script**

`scripts/copy-assets.mjs` must copy HTML, CSS, and Codicons font:

```js
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const copies = [
  ['src/sessions/electron-browser/sessions.html', 'dist/sessions/electron-browser/sessions.html'],
  ['src/sessions/browser/media', 'dist/sessions/browser/media'],
  ['src/sessions/browser/parts/media', 'dist/sessions/browser/parts/media'],
  ['node_modules/@vscode/codicons/dist/codicon.css', 'dist/assets/codicons/codicon.css'],
  ['node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/assets/codicons/codicon.ttf']
];

for (const [from, to] of copies) {
  await mkdir(join(root, dirname(to)), { recursive: true });
  await cp(join(root, from), join(root, to), { recursive: true });
}
```

- [ ] **Step 3: Add Electron main/preload**

`src/main/main.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = join(fileURLToPath(new URL('../..', import.meta.url)));

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Agent Chat',
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(distRoot, 'preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(join(distRoot, 'sessions/electron-browser/sessions.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

`src/preload/preload.ts`:

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('agentWindow', {
  platform: process.platform
});
```

- [ ] **Step 4: Add renderer startup files**

`src/sessions/electron-browser/sessions.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:;"
    />
    <link rel="stylesheet" href="../../assets/codicons/codicon.css" />
    <link rel="stylesheet" href="../browser/media/style.css" />
    <link rel="stylesheet" href="../browser/parts/media/titlebarpart.css" />
    <link rel="stylesheet" href="../browser/parts/media/sidebarPart.css" />
    <link rel="stylesheet" href="../browser/parts/media/sessionsPart.css" />
    <link rel="stylesheet" href="../browser/parts/media/sessionView.css" />
    <link rel="stylesheet" href="../browser/parts/media/chatCompositeBar.css" />
    <link rel="stylesheet" href="../browser/parts/media/auxiliaryBarPart.css" />
  </head>
  <body aria-label="Agent Chat"></body>
  <script type="module" src="./sessions.js"></script>
</html>
```

`src/sessions/electron-browser/sessions.ts`:

```ts
import { main } from '../sessions.desktop.main.js';

await main();
```

`src/sessions/electron-browser/sessions.main.ts`:

```ts
import { Workbench } from '../browser/workbench.js';

export class SessionsMain {
  async open(): Promise<void> {
    const workbench = new Workbench(document.body);
    workbench.startup();
  }
}
```

`src/sessions/sessions.common.main.ts`:

```ts
import './common/theme.js';
import './common/sizes.js';
import './services/sessions/browser/sessionsProvidersService.js';
import './services/sessions/browser/sessionsManagementService.js';
import './services/sessions/browser/sessionsService.js';
import './services/sessions/browser/sessionsPartService.js';
import './contrib/mockProvider/browser/mockSessions.contribution.js';
```

`src/sessions/sessions.desktop.main.ts`:

```ts
import './sessions.common.main.js';
import { SessionsMain } from './electron-browser/sessions.main.js';

export async function main(): Promise<void> {
  await new SessionsMain().open();
}
```

- [ ] **Step 5: Verify skeleton**

Run:

```bash
npm install
npm run typecheck
npm start
```

Expected:

- `npm run typecheck` exits 0.
- Electron opens a blank window.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore scripts src
git commit -m "chore: scaffold electron sessions shell"
```

---

### Task 2: VS Code-Style Base Primitives

**Files:**
- Create: `src/sessions/base/common/lifecycle.ts`
- Create: `src/sessions/base/common/event.ts`
- Create: `src/sessions/base/common/observable.ts`
- Create: `src/sessions/base/common/uri.ts`
- Create: `src/sessions/base/browser/dom.ts`
- Create: `src/sessions/base/browser/grid.ts`

**Interfaces:**
- Produces `IDisposable`, `Disposable`, `DisposableStore`, `MutableDisposable`.
- Produces `Emitter<T>` and `Event<T>`.
- Produces `ObservableValue<T>` used by sessions services.
- Produces minimal split/grid layout primitives with `LayoutPriority`.

- [ ] **Step 1: Implement lifecycle primitives**

Use these exports:

```ts
export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  add<T extends IDisposable>(disposable: T): T;
  clear(): void;
  dispose(): void;
}

export class Disposable implements IDisposable {
  protected _register<T extends IDisposable>(disposable: T): T;
  dispose(): void;
}

export class MutableDisposable<T extends IDisposable> implements IDisposable {
  get value(): T | undefined;
  set value(value: T | undefined);
  clear(): void;
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable;
```

- [ ] **Step 2: Implement event primitives**

Use these exports:

```ts
export type Event<T> = (listener: (event: T) => void) => IDisposable;

export class Emitter<T> implements IDisposable {
  readonly event: Event<T>;
  fire(event: T): void;
  dispose(): void;
}
```

Emitter must copy listeners before firing so listeners can dispose themselves during iteration.

- [ ] **Step 3: Implement observable primitives**

Use these exports:

```ts
export interface IObservable<T> {
  get(): T;
  subscribe(listener: (value: T) => void): IDisposable;
}

export class ObservableValue<T> implements IObservable<T> {
  constructor(value: T);
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): IDisposable;
}

export function observableValue<T>(value: T): ObservableValue<T>;
export function derived<T>(read: () => T, dependencies: readonly IObservable<unknown>[]): IObservable<T>;
```

- [ ] **Step 4: Implement DOM helpers**

Use these exports:

```ts
export function $(className: string, tagName?: keyof HTMLElementTagNameMap): HTMLElement;
export function append<T extends HTMLElement>(parent: HTMLElement, child: T): T;
export function clearNode(node: HTMLElement): void;
export function size(node: HTMLElement, width: number, height: number): void;
export function trackFocus(node: HTMLElement): { onDidFocus: Event<FocusEvent>; onDidBlur: Event<FocusEvent>; dispose(): void };
```

`$('.part.titlebar')` must create a `div` with classes `part` and `titlebar`.

- [ ] **Step 5: Implement grid primitives**

Use these exports:

```ts
export const enum LayoutPriority {
  Low = 0,
  Normal = 1,
  High = 2
}

export interface IGridView {
  readonly element: HTMLElement;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly priority: LayoutPriority;
  layout(width: number, height: number, top: number, left: number): void;
}
```

The first implementation can be a deterministic fixed Agents Window layout function, not a generic VS Code `SerializableGrid`. It must still honor the priority rule that `SessionsPart` absorbs horizontal resize.

- [ ] **Step 6: Verify**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/base
git commit -m "feat: add vscode-style base primitives"
```

---

### Task 3: Platform Services, Actions, Theme, Context Keys

**Files:**
- Create: `src/sessions/platform/instantiation/instantiation.ts`
- Create: `src/sessions/platform/actions/actions.ts`
- Create: `src/sessions/platform/theme/theme.ts`
- Create: `src/sessions/platform/contextkey/contextkey.ts`
- Create: `src/sessions/platform/storage/storage.ts`
- Create: `src/sessions/common/theme.ts`
- Create: `src/sessions/common/sizes.ts`
- Create: `src/sessions/common/contextkeys.ts`

**Interfaces:**
- Produces service registry and singleton lookup.
- Produces action/menu registry used by titlebar/sidebar/header.
- Produces CSS token application.

- [ ] **Step 1: Implement service registry**

Use these exports:

```ts
export type ServiceIdentifier<T> = symbol & { readonly __service?: T };

export function createDecorator<T>(id: string): ServiceIdentifier<T>;

export class ServiceCollection {
  set<T>(id: ServiceIdentifier<T>, instance: T): void;
  get<T>(id: ServiceIdentifier<T>): T;
  has<T>(id: ServiceIdentifier<T>): boolean;
}

export class InstantiationService {
  constructor(services: ServiceCollection);
  get<T>(id: ServiceIdentifier<T>): T;
}
```

Do not implement constructor injection decorators in this project. Services are wired explicitly by `Workbench`.

- [ ] **Step 2: Implement actions and menus**

Use these exports:

```ts
export interface IAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly enabled?: boolean;
  run(): void | Promise<void>;
}

export class MenuId {
  static readonly TitleBarLeft = new MenuId('TitleBarLeft');
  static readonly CommandCenter = new MenuId('CommandCenter');
  static readonly TitleBarRight = new MenuId('TitleBarRight');
  static readonly SidebarTitle = new MenuId('SidebarTitle');
  static readonly SessionHeaderTitle = new MenuId('SessionHeaderTitle');
  static readonly AuxiliaryBarTitle = new MenuId('AuxiliaryBarTitle');
  constructor(readonly id: string) {}
}

export function registerAction(menu: MenuId, action: IAction): void;
export function getMenuActions(menu: MenuId): readonly IAction[];
```

- [ ] **Step 3: Implement theme registry**

Use these exports:

```ts
export interface IColorToken {
  readonly id: string;
  readonly value: string;
}

export interface ISizeToken {
  readonly id: string;
  readonly value: string;
}

export function registerColor(id: string, value: string): IColorToken;
export function registerSize(id: string, value: string): ISizeToken;
export function applyThemeTokens(target: HTMLElement): void;
```

Token IDs must become CSS variables in the VS Code style:

`agentsPanel.background` -> `--vscode-agentsPanel-background`

- [ ] **Step 4: Register Agents Window tokens**

`src/sessions/common/theme.ts` must register at least:

```ts
export const agentsBackground = registerColor('agents.background', '#1e1e1e');
export const agentsPanelBackground = registerColor('agentsPanel.background', '#252526');
export const agentsPanelForeground = registerColor('agentsPanel.foreground', '#cccccc');
export const agentsPanelBorder = registerColor('agentsPanel.border', 'rgba(204, 204, 204, 0.15)');
export const agentsGradientTintColor = registerColor('agentsGradient.tintColor', '#0078d4');
export const agentsChatInputBackground = registerColor('agentsChatInput.background', '#1f1f1f');
export const agentsChatInputForeground = registerColor('agentsChatInput.foreground', '#cccccc');
export const agentsChatInputBorder = registerColor('agentsChatInput.border', 'rgba(204, 204, 204, 0.18)');
export const agentsBadgeBackground = registerColor('agentsBadge.background', '#0078d4');
export const agentsBadgeForeground = registerColor('agentsBadge.foreground', '#ffffff');
export const activeSessionViewBackground = registerColor('activeSessionView.background', '#252526');
export const inactiveSessionViewBackground = registerColor('inactiveSessionView.background', '#1e1e1e');
```

`src/sessions/common/sizes.ts` must register:

```ts
registerSize('agents.fontSize.heading1', '26px');
registerSize('agents.fontSize.heading2', '18px');
registerSize('agents.fontSize.heading3', '13px');
registerSize('agents.fontSize.body1', '13px');
registerSize('agents.fontSize.body2', '11px');
registerSize('agents.fontSize.label1', '12px');
registerSize('agents.fontSize.label2', '11px');
registerSize('agents.fontSize.label3', '10px');
registerSize('agents.fontWeight.regular', '400');
registerSize('agents.fontWeight.semiBold', '600');
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/platform src/sessions/common
git commit -m "feat: add platform registries and agent tokens"
```

---

### Task 4: Workbench Shell and Fixed Agents Layout

**Files:**
- Create: `src/sessions/browser/part.ts`
- Create: `src/sessions/browser/workbench.ts`
- Create: `src/sessions/browser/media/style.css`
- Create: placeholder part files:
  - `src/sessions/browser/parts/titlebarPart.ts`
  - `src/sessions/browser/parts/sidebarPart.ts`
  - `src/sessions/browser/parts/sessionsPart.ts`
  - `src/sessions/browser/parts/auxiliaryBarPart.ts`
  - `src/sessions/browser/parts/editorPart.ts`
  - `src/sessions/browser/parts/panelPart.ts`

**Interfaces:**
- Produces `.monaco-workbench.agent-sessions-workbench.shell-gradient-background`.
- Produces fixed Agents layout with real part instances.
- Produces visible titlebar/sidebar/sessions/auxiliary and hidden editor/panel.

- [ ] **Step 1: Implement `Part` base**

Use this shape:

```ts
export abstract class Part extends Disposable implements IGridView {
  readonly element: HTMLElement;
  abstract readonly minimumWidth: number;
  abstract readonly minimumHeight: number;
  abstract readonly priority: LayoutPriority;

  constructor(readonly id: string, className: string);
  create(parent: HTMLElement): void;
  layout(width: number, height: number, top: number, left: number): void;
  protected abstract render(container: HTMLElement): void;
}
```

`create(parent)` must append `this.element` to `parent` and call `render`.

- [ ] **Step 2: Implement placeholder parts**

Each placeholder part must extend `Part`, render a label, and expose priorities:

| File | class | id | priority |
|---|---|---|---|
| `titlebarPart.ts` | `TitlebarPart` | `workbench.parts.titlebar` | `Low` |
| `sidebarPart.ts` | `SidebarPart` | `workbench.parts.sidebar` | `Low` |
| `sessionsPart.ts` | `SessionsPart` | `workbench.parts.sessions` | `High` |
| `auxiliaryBarPart.ts` | `AuxiliaryBarPart` | `workbench.parts.auxiliarybar` | `Low` |
| `editorPart.ts` | `EditorPart` | `workbench.parts.editor` | `Normal` |
| `panelPart.ts` | `PanelPart` | `workbench.parts.panel` | `Normal` |

- [ ] **Step 3: Implement workbench startup**

`Workbench.startup()` must:

1. Add root class names.
2. Apply theme tokens to root.
3. Create part instances.
4. Render them into a single root.
5. Install resize listener.
6. Call `layout()`.

Layout constants:

```ts
const TITLEBAR_HEIGHT = 35;
const SIDEBAR_WIDTH = 300;
const AUXILIARY_WIDTH = 340;
const PANEL_HEIGHT = 300;
const CONTENT_MIN_WIDTH = 640;
```

Initial visibility:

```ts
{
  sidebar: true,
  sessions: true,
  editor: false,
  auxiliaryBar: true,
  panel: false
}
```

- [ ] **Step 4: Implement shell CSS**

`style.css` must include:

```css
html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: var(--vscode-agents-fontSize-body1);
  background: var(--vscode-agents-background);
  color: var(--vscode-agentsPanel-foreground);
}

.monaco-workbench.agent-sessions-workbench {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--vscode-agents-background);
}

.agent-sessions-workbench.shell-gradient-background::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 128% 102% at 100% 100%,
      color-mix(in srgb, var(--vscode-agentsGradient-tintColor) 13%, var(--vscode-agents-background)) 0%,
      color-mix(in srgb, var(--vscode-agentsGradient-tintColor) 10%, var(--vscode-agents-background)) 17%,
      color-mix(in srgb, var(--vscode-agentsGradient-tintColor) 7%, var(--vscode-agents-background)) 31%,
      var(--vscode-agents-background) 60%);
}

.agent-sessions-workbench .part {
  position: absolute;
  box-sizing: border-box;
  z-index: 1;
}

.agent-sessions-workbench .part.sessionspart,
.agent-sessions-workbench .part.auxiliarybar,
.agent-sessions-workbench .part.panel,
.agent-sessions-workbench .part.editor {
  background: var(--vscode-agentsPanel-background);
  border: 1px solid var(--vscode-agentsPanel-border);
  border-radius: 8px;
  overflow: hidden;
}
```

- [ ] **Step 5: Verify workbench DOM**

Add a temporary manual check in devtools or Playwright later:

```js
document.querySelector('.monaco-workbench.agent-sessions-workbench .part.sessionspart')
```

Expected: returns an element.

Run:

```bash
npm run typecheck
npm start
```

Expected: Electron opens with a titlebar area, left sidebar, central card, right auxiliary card.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/browser
git commit -m "feat: add agents workbench layout"
```

---

### Task 5: Session Domain and Mock Provider Chain

**Files:**
- Create: `src/sessions/services/sessions/common/session.ts`
- Create: `src/sessions/services/sessions/common/sessionsProvider.ts`
- Create: `src/sessions/services/sessions/common/sessionsManagement.ts`
- Create: `src/sessions/services/sessions/browser/sessionsProvidersService.ts`
- Create: `src/sessions/services/sessions/browser/sessionsManagementService.ts`
- Create: `src/sessions/services/sessions/browser/visibleSessions.ts`
- Create: `src/sessions/services/sessions/browser/sessionsService.ts`
- Create: `src/sessions/services/sessions/browser/sessionsPartService.ts`
- Create: `src/sessions/contrib/mockProvider/browser/mockSessionsProvider.ts`
- Create: `src/sessions/contrib/mockProvider/browser/mockSessions.contribution.ts`
- Create: `tests/unit/visibleSessions.test.ts`
- Create: `tests/unit/sessionsManagementService.test.ts`

**Interfaces:**
- Produces `ISessionsProvider` compatible enough for mock.
- Produces session aggregation and active/visible sessions observable state.
- Produces one active mock session by default.

- [ ] **Step 1: Define session domain**

`session.ts` must include:

```ts
export const enum SessionStatus {
  Untitled = 0,
  InProgress = 1,
  NeedsInput = 2,
  Completed = 3,
  Error = 4
}

export const enum ChatInteractivity {
  Full = 'full',
  ReadOnly = 'read-only',
  Hidden = 'hidden'
}

export interface ISessionWorkspace {
  readonly label: string;
  readonly description?: string;
  readonly branchName?: string;
}

export interface ISessionChangesSummary {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface IChat {
  readonly id: string;
  readonly title: IObservable<string>;
  readonly messages: IObservable<readonly IChatMessage[]>;
  readonly status: IObservable<SessionStatus>;
  readonly interactivity: IObservable<ChatInteractivity>;
}

export interface IChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly detail?: string;
}

export interface ISession {
  readonly sessionId: string;
  readonly providerId: string;
  readonly sessionType: string;
  readonly icon: string;
  readonly createdAt: Date;
  readonly workspace: IObservable<ISessionWorkspace | undefined>;
  readonly title: IObservable<string>;
  readonly updatedAt: IObservable<Date>;
  readonly status: IObservable<SessionStatus>;
  readonly description: IObservable<string | undefined>;
  readonly changesSummary: IObservable<ISessionChangesSummary | undefined>;
  readonly isArchived: IObservable<boolean>;
  readonly isRead: IObservable<boolean>;
  readonly chats: IObservable<readonly IChat[]>;
  readonly activeChat: IObservable<IChat>;
}

export interface IActiveSession extends ISession {
  readonly isCreated: IObservable<boolean>;
  readonly sticky: IObservable<boolean>;
  readonly openChats: IObservable<readonly IChat[]>;
  readonly shouldShowChatTabs: IObservable<boolean>;
}
```

- [ ] **Step 2: Define provider and management contracts**

`sessionsProvider.ts`:

```ts
export interface ISessionChangeEvent {
  readonly added: readonly ISession[];
  readonly removed: readonly ISession[];
  readonly changed: readonly ISession[];
}

export interface ISessionsProvider {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly order: number;
  getSessions(): readonly ISession[];
  readonly onDidChangeSessions: Event<ISessionChangeEvent>;
  sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession>;
}
```

`sessionsManagement.ts`:

```ts
export interface ISessionsManagementService {
  getSessions(): readonly ISession[];
  getSession(sessionId: string): ISession | undefined;
  readonly onDidChangeSessions: Event<ISessionChangeEvent>;
  sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession>;
}
```

- [ ] **Step 3: Implement provider registry and management service**

`SessionsProvidersService` must:

- Keep providers in registration order sorted by `order`.
- Fire `{ added, removed }` events.
- Reject duplicate provider ids.

`SessionsManagementService` must:

- Aggregate `getSessions()` from all providers.
- Forward provider `onDidChangeSessions`.
- Route `sendRequest` to the owning provider.

- [ ] **Step 4: Implement visible sessions**

`VisibleSessions` must:

- Start with `[firstSession]` when sessions exist, else `[undefined]`.
- Expose `visibleSessions: IObservable<readonly (IActiveSession | undefined)[]>`.
- Expose `activeSession: IObservable<IActiveSession | undefined>`.
- Implement `openSession(session)`, `setActive(session)`, and `closeSession(sessionId)`.
- Wrap `ISession` into `IActiveSession`.
- `shouldShowChatTabs` is true when `chats.length > 1`.

- [ ] **Step 5: Implement mock provider**

Mock data must include:

- One active in-progress session with two chats.
- One completed session with changes summary.
- One needs-input session.
- One archived/done session.
- Workspace labels and branch names.
- Chat messages including user, assistant, and tool entries.

Use Codicon names as strings such as `codicon-copilot`, `codicon-folder`, `codicon-git-branch`, `codicon-diff-multiple`.

- [ ] **Step 6: Wire services in `Workbench`**

`Workbench.startup()` must create:

```ts
const services = new ServiceCollection();
const providers = new SessionsProvidersService();
const management = new SessionsManagementService(providers);
const sessionsPartService = new SessionsPartService();
const sessions = new SessionsService(management, sessionsPartService);
services.set(ISessionsProvidersService, providers);
services.set(ISessionsManagementService, management);
services.set(ISessionsService, sessions);
services.set(ISessionsPartService, sessionsPartService);
```

Then import/register `MockSessionsProvider`.

- [ ] **Step 7: Unit tests**

`visibleSessions.test.ts` must assert:

- First session becomes active.
- Opening another session changes active.
- Closing active session selects a fallback.
- Multiple chats make `shouldShowChatTabs` true.

`sessionsManagementService.test.ts` must assert:

- Registered provider sessions are aggregated.
- `sendRequest` routes to the provider that owns the session.
- Duplicate provider id throws.

- [ ] **Step 8: Verify**

Run:

```bash
npm run typecheck
```

If unit test runner has been added by this point, also run:

```bash
npm test
```

Expected: typecheck exits 0; tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/sessions/services src/sessions/contrib/mockProvider tests/unit
git commit -m "feat: add mock sessions provider chain"
```

---

### Task 6: Sessions Part and Session View

**Files:**
- Modify: `src/sessions/browser/parts/sessionsPart.ts`
- Create: `src/sessions/browser/parts/sessionView.ts`
- Create: `src/sessions/browser/parts/sessionHeader.ts`
- Create: `src/sessions/browser/parts/chatCompositeBar.ts`
- Create: `src/sessions/browser/parts/chatView.ts`
- Create: `src/sessions/browser/parts/media/sessionsPart.css`
- Create: `src/sessions/browser/parts/media/sessionView.css`
- Create: `src/sessions/browser/parts/media/chatCompositeBar.css`

**Interfaces:**
- `SessionsPart.updateVisibleSessions(visible, active)` renders session slots.
- `SessionView.openSession(session)` swaps between new-session and chat view.
- Header/tabs/chat are separate widgets, matching VS Code structure.

- [ ] **Step 1: Implement `SessionsPart` passive renderer**

Use this public API:

```ts
export class SessionsPart extends Part {
  readonly priority = LayoutPriority.High;
  updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void;
  focusSession(sessionId: string | undefined): void;
}
```

Implementation rules:

- Keep a private `slots: SessionView[]`.
- Desired count is `Math.max(visible.length, 1)`.
- Add slots to the right.
- Remove only trailing slots.
- Rebind slots by position using `slot.openSession(session)`.
- Add `.is-active` to active slot; if only one slot exists, it is active.

- [ ] **Step 2: Implement `SessionView` composition**

DOM structure:

```html
<div class="session-view">
  <div class="session-view-centered-content">
    <div class="chat-composite-bar session-header-bar"></div>
    <div class="chat-composite-bar session-chat-tabs-bar"></div>
  </div>
  <div class="session-view-content"></div>
</div>
```

Public API:

```ts
export class SessionView extends Disposable {
  readonly element: HTMLElement;
  openSession(session: IActiveSession | undefined): void;
  setActive(active: boolean): void;
  focus(): void;
  layout(width: number, height: number): void;
}
```

- [ ] **Step 3: Implement session header**

Header must render:

- Status/dot icon.
- Session title.
- Meta row with workspace, branch, changes summary.
- Toolbar buttons: Run, Open in VS Code, New Chat.

Use classes from VS Code CSS:

```text
chat-composite-bar-header
chat-composite-bar-session-icon
chat-composite-bar-header-main
chat-composite-bar-title-row
chat-composite-bar-session-title
chat-composite-bar-meta-row
chat-composite-bar-title-actions
```

- [ ] **Step 4: Implement chat composite bar**

Show tabs only when `session.shouldShowChatTabs.get()` is true.

DOM classes:

```text
chat-composite-bar-tabs-row
chat-composite-bar-tabs
chat-composite-bar-tab
chat-composite-bar-tab active
```

Tabs must render chat title and close icon for non-main chat. Close can be visual-only in first implementation.

- [ ] **Step 5: Implement chat view**

Chat view must render:

- Transcript list.
- Tool invocation rows.
- Composer at bottom.
- Send button using `codicon-arrow-up`.

The UI can be non-functional except that typing and clicking send appends a mock user message through `SessionsManagementService.sendRequest`.

- [ ] **Step 6: Implement CSS from VS Code shape**

Must preserve:

- Header/tabs centered with max width `950px`.
- Session content full width.
- Inactive session opacity rules.
- Header border bottom with 12% foreground mix.
- Chat input uses `agentsChatInput.*`.

- [ ] **Step 7: Verify**

Run:

```bash
npm run typecheck
npm start
```

Expected:

- Central card shows active mock session.
- Header, meta row, tabs, transcript, and composer are visible.
- Sidebar/auxiliary can still be placeholder if Task 7 is not complete.

- [ ] **Step 8: Commit**

```bash
git add src/sessions/browser/parts
git commit -m "feat: render sessions part and chat view"
```

---

### Task 7: Titlebar, Sidebar Sessions List, Auxiliary Bar

**Files:**
- Modify: `src/sessions/browser/parts/titlebarPart.ts`
- Modify: `src/sessions/browser/parts/sidebarPart.ts`
- Modify: `src/sessions/browser/parts/auxiliaryBarPart.ts`
- Create: `src/sessions/contrib/sessions/browser/sessionsList.ts`
- Create: `src/sessions/contrib/changes/browser/changesView.ts`
- Create: `src/sessions/contrib/files/browser/filesView.ts`
- Create: `src/sessions/browser/parts/media/titlebarpart.css`
- Create: `src/sessions/browser/parts/media/sidebarPart.css`
- Create: `src/sessions/browser/parts/media/auxiliaryBarPart.css`

**Interfaces:**
- Titlebar renders left/center/right areas.
- Sidebar renders VS Code-style sessions list.
- Auxiliary renders Files/Changes tabs.

- [ ] **Step 1: Implement titlebar**

DOM structure:

```html
<div class="part titlebar">
  <div class="titlebar-container sessions-titlebar-container has-center">
    <div class="titlebar-drag-region"></div>
    <div class="titlebar-left"></div>
    <div class="titlebar-center"></div>
    <div class="titlebar-right"></div>
  </div>
</div>
```

Center command box must show:

```text
<provider icon> <session title> <workspace> (<branch>) +additions -deletions
```

Right side must show icon buttons for remote, terminal, auxiliary toggle, account.

- [ ] **Step 2: Implement sidebar sessions list**

Sections:

```text
Sessions
Pinned
Chats
agent-chat
Done
```

Each row must show:

- Status icon.
- Title.
- Workspace badge when not redundant.
- Diff stats.
- Timestamp/status description.

Clicking a row calls `SessionsService.openSession`.

- [ ] **Step 3: Implement auxiliary bar**

Top tabs:

```text
Changes | Files
```

Changes view uses active session `changesSummary`.

Files view renders a mock tree:

```text
agent-chat
  src/
    sessions/
      browser/
      services/
  package.json
```

- [ ] **Step 4: Implement part CSS**

Match VS Code facts:

- Titlebar center uses 1fr auto 1fr grid.
- Sidebar background is transparent/flush.
- Sidebar footer can host account row later.
- Auxiliary card title uses pill-like active tab.
- Auxiliary background uses `agentsPanel.background`.

- [ ] **Step 5: Verify**

Run:

```bash
npm run typecheck
npm start
```

Expected:

- Titlebar is visually centered.
- Sidebar rows navigate sessions.
- Auxiliary bar displays Changes/Files card.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/browser/parts/titlebarPart.ts src/sessions/browser/parts/sidebarPart.ts src/sessions/browser/parts/auxiliaryBarPart.ts src/sessions/contrib src/sessions/browser/parts/media
git commit -m "feat: add agents titlebar sidebar and auxiliary bar"
```

---

### Task 8: Visual Fidelity Pass

**Files:**
- Modify: `src/sessions/browser/media/style.css`
- Modify: `src/sessions/browser/parts/media/titlebarpart.css`
- Modify: `src/sessions/browser/parts/media/sidebarPart.css`
- Modify: `src/sessions/browser/parts/media/sessionsPart.css`
- Modify: `src/sessions/browser/parts/media/sessionView.css`
- Modify: `src/sessions/browser/parts/media/chatCompositeBar.css`
- Modify: `src/sessions/browser/parts/media/auxiliaryBarPart.css`
- Modify as needed: part TS files where DOM class names are missing

**Interfaces:**
- Produces visual match to VS Code Agents Window shell at desktop sizes.

- [ ] **Step 1: Match global shell**

Check:

- Root class includes `.monaco-workbench.agent-sessions-workbench.shell-gradient-background`.
- Gradient tint appears in lower-right.
- No activity bar/status bar/banner.
- Notifications are absent in mock app.

- [ ] **Step 2: Match workbench margins**

Use these initial margins:

```text
sessionspart: margin 0 4px 4px 10px
auxiliarybar: margin 0 10px 4px 4px
panel: hidden
sidebar: flush
```

When panel hidden, sessions bottom margin should visually drop to match VS Code's `nopanel` state.

- [ ] **Step 3: Match titlebar**

Titlebar:

- Height around `35px`.
- Left/right flex tracks symmetric.
- Center command box does not shift when right icons change.
- Icons use Codicons.
- Drag region does not cover buttons.

- [ ] **Step 4: Match session header**

Header:

- Top padding `6px 10px 0`.
- Title row height `26px`.
- Meta row height `22px`.
- Header bottom border `color-mix(... 12%)`.
- Title font `agents.fontSize.heading3` and semi-bold.

- [ ] **Step 5: Match chat and composer**

Chat:

- Transcript content centered around `950px`.
- Scrollbar edge remains at session view right edge.
- Composer bottom-aligned and centered.
- Send button circular with `codicon-arrow-up`.

- [ ] **Step 6: Verify manually**

Run:

```bash
npm start
```

Compare against VS Code Agents Window reference. Record visible gaps in this plan under Task 8 notes before moving on.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/browser
git commit -m "style: align agents window visual structure"
```

---

### Task 9: Playwright Screenshot Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/agents-window.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces screenshots for `1440x900` and `1280x720`.
- Fails if primary UI regions are missing or blank.

- [ ] **Step 1: Add Playwright config**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure'
  }
});
```

- [ ] **Step 2: Add Electron e2e test**

`tests/e2e/agents-window.spec.ts` must:

- Launch Electron using `electron.launch({ args: ['dist/main/main.js'] })`.
- Resize first window to `1440x900`, screenshot to `test-results/agents-window-1440x900.png`.
- Assert selectors exist:
  - `.monaco-workbench.agent-sessions-workbench`
  - `.part.titlebar`
  - `.part.sidebar`
  - `.part.sessionspart`
  - `.session-view`
  - `.part.auxiliarybar`
- Resize to `1280x720`, screenshot to `test-results/agents-window-1280x720.png`.

- [ ] **Step 3: Add visual blank check**

The test must evaluate:

```ts
const boxes = await page.locator('.part.sessionspart, .part.sidebar, .part.auxiliarybar').evaluateAll(nodes =>
  nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, text: node.textContent?.trim().length ?? 0 };
  })
);
```

Assert every box has width > 100, height > 100, and text length > 0.

- [ ] **Step 4: Verify**

Run:

```bash
npm run verify
```

Expected:

- TypeScript passes.
- Playwright passes.
- Screenshots are written under `test-results`.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/e2e package.json package-lock.json
git commit -m "test: add agents window screenshot verification"
```

---

### Task 10: Acceptance Review and Drift Checklist

**Files:**
- Modify: `docs/rebuild/2026-07-03-vscode-agents-window-architecture.md`
- Modify: `docs/rebuild/2026-07-03-agents-window-rebuild-implementation-plan.md`

**Interfaces:**
- Produces documented acceptance evidence.
- Produces a list of known visual gaps instead of hiding them.

- [ ] **Step 1: Run final verification**

Run:

```bash
npm run verify
```

Expected:

- exit 0.
- `test-results/agents-window-1440x900.png` exists.
- `test-results/agents-window-1280x720.png` exists.

- [ ] **Step 2: Inspect screenshots**

Open both screenshots and check:

- Titlebar center alignment.
- Sidebar width and row density.
- Sessions card margin/radius/border.
- Session header meta row.
- Chat tabs visibility.
- Composer alignment.
- Auxiliary bar card shape and title tabs.
- No text overlap at both viewports.

- [ ] **Step 3: Update architecture doc with results**

Add an `Implementation Notes` section with:

```md
## Implementation Notes

- Verified at `1440x900`: yes/no, screenshot path.
- Verified at `1280x720`: yes/no, screenshot path.
- Known visual gaps:
  - ...
- Known architecture gaps:
  - ...
```

Use concrete gaps only. If there are no gaps, write `None observed in the verified screenshots.`

- [ ] **Step 4: Commit**

```bash
git add docs/rebuild
git commit -m "docs: record agents window rebuild verification"
```

---

## Execution Choice

Plan complete and saved to `docs/rebuild/2026-07-03-agents-window-rebuild-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session with checkpoints.

Recommended path: **Inline Execution for Tasks 1-4**, because the repo is empty and foundation decisions need tight control; then **Subagent-Driven for Tasks 5-9** once the architecture boundaries are stable.
