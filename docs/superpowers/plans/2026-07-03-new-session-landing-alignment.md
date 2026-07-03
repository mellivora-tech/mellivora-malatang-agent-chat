# New Session Landing Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default Agent Chat window match the reference New Session landing state instead of opening directly into a session detail view.

**Architecture:** Add a small workbench mode observable to the existing sessions part service. `newSession` mode renders a new centered landing view and hides the auxiliary bar; opening a session switches to `sessionDetail` and reuses the existing session detail view.

**Tech Stack:** Electron `42.5.0`, TypeScript ESM, native DOM `Part` / `View` classes, CSS variables/tokens, `@vscode/codicons`, Playwright Electron screenshot verification.

## Global Constraints

- Provider remains mock-only.
- Desktop app only.
- No React, Vue, Svelte, Zustand, Lucide, or Vite scaffold.
- Use existing VS Code-style lifecycle/event/observable/service primitives.
- Default screenshot must visually correspond to the supplied New Session reference.

---

### Task 1: Test Default New Session Landing

**Files:**
- Modify: `tests/e2e/agents-window.spec.ts`

**Interfaces:**
- Produces failing e2e expectations before implementation:
  - `.sessions-new-session-view` is visible by default.
  - `.part.auxiliarybar` is hidden by default.
  - titlebar command center reads `New Session`.
  - sidebar top-level title reads `Sessions`.

- [x] **Step 1: Add expectations to the existing Playwright test.**
- [x] **Step 2: Run `npm run test:e2e` and verify it fails on missing New Session landing selectors.**

### Task 2: Add Workbench Mode and New Session View

**Files:**
- Modify: `src/sessions/services/sessions/browser/sessionsPartService.ts`
- Modify: `src/sessions/services/sessions/browser/sessionsService.ts`
- Modify: `src/sessions/browser/workbench.ts`
- Modify: `src/sessions/browser/parts/sessionsPart.ts`
- Create: `src/sessions/browser/parts/newSessionView.ts`
- Create: `src/sessions/browser/parts/media/newSessionView.css`
- Modify: `src/sessions/electron-browser/sessions.html`

**Interfaces:**
- `WorkbenchMode = 'newSession' | 'sessionDetail'`.
- `SessionsPartService.mode` defaults to `newSession`.
- `SessionsService.openSession(sessionId)` switches mode to `sessionDetail`.
- `SessionsPart.updateWorkbenchMode(mode)` swaps between `NewSessionView` and `SessionView`.

- [x] **Step 1: Implement mode observable in the part service.**
- [x] **Step 2: Render `NewSessionView` as the default SessionsPart content.**
- [x] **Step 3: Hide auxiliary bar while mode is `newSession`.**
- [x] **Step 4: Run e2e and get the new landing assertions green.**

### Task 3: Align Default Titlebar and Sidebar

**Files:**
- Modify: `src/sessions/browser/parts/titlebarPart.ts`
- Modify: `src/sessions/browser/parts/sidebarPart.ts`
- Modify: `src/sessions/contrib/sessions/browser/sessionsList.ts`
- Modify: `src/sessions/browser/parts/media/titlebarpart.css`
- Modify: `src/sessions/browser/parts/media/sidebarPart.css`

**Interfaces:**
- Titlebar command center displays `New Session` in `newSession` mode.
- Sidebar header displays `Sessions`, `New` button, filter, and search affordances.
- Sidebar keeps mock provider groups and Customizations rows.

- [x] **Step 1: Make titlebar observe mode and render New Session default.**
- [x] **Step 2: Replace default sidebar section structure with Sessions-style grouped navigation.**
- [x] **Step 3: Keep existing click-to-open behavior for session rows.**

### Task 4: Verify and Commit

**Files:**
- All files above.

- [x] **Step 1: Run `npm run verify`.**
- [x] **Step 2: Inspect `test-results/agents-window-1440x900.png` and `test-results/agents-window-1280x720.png`.**
- [x] **Step 3: Commit with `feat: align default new session landing`.**
