# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 CONFIRMED correctness findings from the 2026-07-06 high-effort code review: permanently-stuck InProgress sessions blocking follow-up sends, inert Stop button, orphaned ChangesView/FilesView, missing macOS activate handler, message loss on failed sends, absurd mock timestamps, colliding session IDs, grid ignoring visibility state and minimum-width contracts, and Enter not submitting on the new-session landing.

**Architecture:** The mock provider gains a real session lifecycle (InProgress → scheduled mock reply → NeedsInput, cancellable via a new `stopSession`), plumbed through `SessionsManagementService` → `SessionsService` → `ConversationView`. The reply delay is injectable via the `AGENT_CHAT_MOCK_DELAY_MS` env var (preload → `agentWindow` global) so Playwright can freeze or accelerate the lifecycle. The grid's existing-but-dead minimum-width machinery becomes the real layout path.

**Tech Stack:** Electron 42.5.0, TypeScript ESM (NodeNext), native DOM Part/View classes, `node:test` unit tests (run compiled from `dist/`), Playwright Electron e2e.

## Global Constraints

- Provider only mock data; no real model/network/backend provider.
- Do not use React, Vue, Svelte, Zustand, Lucide, or Vite app scaffold.
- CSS token names aligned to the `--vscode-agents-*` family already used in `src/sessions/browser/parts/media/*.css`.
- Do not import source modules from the VS Code sibling repository at runtime.
- TypeScript is `strict` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — never assign a possibly-`undefined` value to an optional property; build option objects with conditional spreads.
- Unit tests import from `'../../src/...'` with `.js` extensions and run compiled: `npm run build && node --test dist/tests/unit/<name>.test.js`.
- Full gate: `npm run verify` (typecheck + unit + Playwright e2e with screenshots at 1440x900 and 1280x720).
- Work on the current branch `codex/agents-window-rebuild`.

## Verification commands

```bash
npm run typecheck                                            # tsc --noEmit
npm run build                                                # tsc + copy assets to dist/
node --test dist/tests/unit/<file>.test.js                   # single unit file (after build)
npm run test:unit                                            # build + all unit tests
npx playwright test -g "<test name>"                         # single e2e test (after build)
npm run verify                                               # everything
```

---

## File Structure

```text
Modify: src/sessions/contrib/mockProvider/browser/mockSessionsProvider.ts   (lifecycle, ids, timestamps, stop)
Modify: src/sessions/services/sessions/common/sessionsProvider.ts           (stopSession contract)
Modify: src/sessions/services/sessions/common/sessionsManagement.ts         (stopSession contract)
Modify: src/sessions/services/sessions/browser/sessionsManagementService.ts (stopSession routing)
Modify: src/sessions/services/sessions/browser/sessionsService.ts           (stopSession)
Modify: src/preload/preload.ts                                              (mock delay env hook)
Modify: src/sessions/browser/workbench.ts                                   (pass delay to provider)
Modify: src/sessions/browser/parts/conversationView.ts                      (send guard, error, stop)
Modify: src/sessions/browser/parts/media/sessionView.css                    (send error style)
Modify: src/sessions/browser/parts/newSessionView.ts                        (Enter submits)
Modify: src/sessions/browser/parts/auxiliaryBarPart.ts                      (Review tab → ChangesView)
Delete: src/sessions/contrib/files/browser/filesView.ts                     (orphaned dead code)
Modify: src/sessions/base/browser/grid.ts                                   (visibility + min widths)
Create: src/main/appLifecycle.ts                                            (testable app lifecycle)
Modify: src/main/main.ts                                                    (activate handler)
Modify: tests/unit/mockSessionsProvider.test.ts
Modify: tests/unit/sessionsManagementService.test.ts
Create: tests/unit/workbenchGrid.test.ts
Create: tests/unit/appLifecycle.test.ts
Modify: tests/e2e/agents-window.spec.ts
```

---

### Task 1: Mock provider session lifecycle (real timestamps, unique IDs, scheduled replies, stop)

Fixes findings: stuck-InProgress root cause, hardcoded `2026-07-03T09:00Z` timestamps, colliding session IDs. Adds `stopSession` + `whenIdle` at the provider level.

**Files:**
- Modify: `src/sessions/contrib/mockProvider/browser/mockSessionsProvider.ts`
- Modify: `tests/unit/mockSessionsProvider.test.ts`
- Modify: `tests/unit/sessionsManagementService.test.ts` (only the last test, which uses the real mock provider)

**Interfaces:**
- Consumes: existing `ISessionsProvider`, `SessionStatus`, `SessionInteractivity`, `observableValue`.
- Produces (later tasks rely on these exact signatures):
  - `new MockSessionsProvider(options?: IMockSessionsProviderOptions)` where `IMockSessionsProviderOptions = { readonly responseDelayMs?: number }` (default `3000`).
  - `stopSession(sessionId: string): Promise<ISession>` — cancels any pending reply; if the session was `InProgress`, sets `NeedsInput` and fires a `changed` event; otherwise no-op.
  - `whenIdle(): Promise<void>` — resolves once no mock reply is pending (test helper).
  - `registerMockSessionsProvider(providersService: ISessionsProvidersService, options?: IMockSessionsProviderOptions): MockSessionsProvider`.
  - Behavior: `startSession`/`sendMessage` leave the session `InProgress` and schedule one assistant reply (`Mock response for: <query>`) after `responseDelayMs`; when it lands, status becomes `SessionStatus.NeedsInput`.

- [ ] **Step 1: Rewrite the provider unit tests to describe the new lifecycle**

Replace the entire content of `tests/unit/mockSessionsProvider.test.ts` with:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { MockSessionsProvider } from '../../src/sessions/contrib/mockProvider/browser/mockSessionsProvider.js';
import { SessionInteractivity, SessionStatus, type ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';

const texts = (messages: readonly ISessionMessage[]) => messages.map(message => message.text);
const roles = (messages: readonly ISessionMessage[]) => messages.map(message => message.role);

test('mock provider creates a running session from first prompt', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const events: unknown[] = [];
	const disposable = provider.onDidChangeSessions(event => events.push(event));
	const before = provider.getSessions().length;
	const session = await provider.startSession('hello');

	assert.equal(provider.getSessions().length, before + 1);
	assert.equal(session.title.get(), 'hello');
	assert.equal(session.status.get(), SessionStatus.InProgress);
	assert.equal(session.workspace.get()?.label, 'mellivora-malatang');
	assert.equal(session.workspace.get()?.branchName, 'codex/agents-window-rebuild');
	assert.equal(session.interactivity.get(), SessionInteractivity.Full);
	assert.deepEqual(texts(session.messages.get()), ['hello']);
	assert.equal(session.messages.get()[0]?.role, 'user');
	assert.deepEqual(events[0], { added: [session], removed: [], changed: [] });

	await provider.whenIdle();
	disposable.dispose();
});

test('started session receives a mock reply and settles to needs-input', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const session = await provider.startSession('hello');

	assert.equal(session.status.get(), SessionStatus.InProgress);

	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(texts(session.messages.get()), ['hello', 'Mock response for: hello']);
	assert.deepEqual(roles(session.messages.get()), ['user', 'assistant']);
});

test('mock provider appends follow-up turns to session messages', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const session = await provider.startSession('hello');
	await provider.whenIdle();

	await provider.sendMessage(session.sessionId, 'follow up');

	assert.equal(session.status.get(), SessionStatus.InProgress);
	assert.deepEqual(texts(session.messages.get()), ['hello', 'Mock response for: hello', 'follow up']);

	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(texts(session.messages.get()), [
		'hello',
		'Mock response for: hello',
		'follow up',
		'Mock response for: follow up'
	]);
});

test('sessions started in the same instant get unique ids', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const [first, second] = await Promise.all([
		provider.startSession('重构侧边栏'),
		provider.startSession('修复布局')
	]);

	assert.notEqual(first.sessionId, second.sessionId);
	await provider.whenIdle();
});

test('started sessions carry a real creation timestamp', async () => {
	const before = Date.now();
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const session = await provider.startSession('hello');

	assert.ok(session.createdAt.getTime() >= before);
	assert.ok(session.createdAt.getTime() <= Date.now());
	await provider.whenIdle();
});

test('stopSession cancels the pending reply and settles to needs-input', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 60_000 });
	const session = await provider.startSession('hello');

	const stopped = await provider.stopSession(session.sessionId);

	assert.equal(stopped.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(texts(session.messages.get()), ['hello']);

	await provider.whenIdle();
});

test('stopSession on an idle session is a no-op', async () => {
	const provider = new MockSessionsProvider({ responseDelayMs: 1 });
	const session = await provider.startSession('hello');
	await provider.whenIdle();
	const events: unknown[] = [];
	const disposable = provider.onDidChangeSessions(event => events.push(event));

	await provider.stopSession(session.sessionId);

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(events, []);
	disposable.dispose();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test dist/tests/unit/mockSessionsProvider.test.js`
Expected: build fails typecheck OR tests FAIL (`MockSessionsProvider` constructor takes no options; `whenIdle`/`stopSession` do not exist). If `tsc` fails first that counts as the failing state.

- [ ] **Step 3: Implement the provider lifecycle**

In `src/sessions/contrib/mockProvider/browser/mockSessionsProvider.ts`:

3a. Add below the imports (keep the existing `IMutableSession` interface unchanged):

```ts
export interface IMockSessionsProviderOptions {
	readonly responseDelayMs?: number;
}

interface IPendingReply {
	readonly timer: ReturnType<typeof setTimeout>;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

const DEFAULT_RESPONSE_DELAY_MS = 3000;

function minutesAgo(minutes: number): Date {
	return new Date(Date.now() - minutes * 60_000);
}
```

3b. Change `createSession` to take the timestamp from its caller. Replace:

```ts
}): IMutableSession {
	const now = new Date('2026-07-03T09:00:00.000Z');
```

with a new required option and usage — add `timestamp: Date;` to the options object type (after `sessionId: string;`), delete the `const now = ...` line, and replace both uses of `now` with `options.timestamp`:

```ts
		createdAt: options.timestamp,
		...
		updatedAt: observableValue(options.timestamp),
```

3c. Give each of the four seed sessions an explicit relative timestamp (add one `timestamp:` line to each `createSession({...})` call in the `sessions` array):

| seed sessionId | add |
|---|---|
| `session-in-progress` | `timestamp: minutesAgo(2),` |
| `session-completed` | `timestamp: minutesAgo(120),` |
| `session-needs-input` | `timestamp: minutesAgo(45),` |
| `session-archived` | `timestamp: minutesAgo(3 * 24 * 60),` |

3d. Add constructor and state fields to `MockSessionsProvider` (after the `sessions` array field):

```ts
	private readonly responseDelayMs: number;
	private sequence = 0;
	private readonly pendingReplies = new Map<string, IPendingReply>();

	constructor(options: IMockSessionsProviderOptions = {}) {
		this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
	}
```

3e. Replace `startSession` and `sendMessage` entirely, and add the new methods:

```ts
	async startSession(query: string): Promise<ISession> {
		const timestamp = new Date();
		const idBase = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
		this.sequence += 1;
		const session = createSession({
			sessionId: `session-started-${idBase}-${this.sequence}`,
			timestamp,
			icon: 'codicon-new-session',
			status: SessionStatus.InProgress,
			title: query,
			description: 'Agent is working on the first prompt.',
			workspace: {
				label: 'mellivora-malatang',
				description: '~/workspace/code/learning-projects',
				branchName: 'codex/agents-window-rebuild'
			},
			messages: [{ id: `started-user-${this.sequence}`, role: 'user', text: query }],
			interactivity: SessionInteractivity.Full,
			changesSummary: {
				files: 5,
				additions: 3431,
				deletions: 815
			},
			isRead: false
		});

		this.sessions.unshift(session);
		this.onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		this.scheduleAssistantReply(session, query);
		return session;
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		this.sequence += 1;
		session.messages.set([
			...session.messages.get(),
			{ id: `${sessionId}-user-${this.sequence}`, role: 'user', text: query }
		]);
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(new Date());
		session.isRead.set(false);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.scheduleAssistantReply(session, query);
		return session;
	}

	async stopSession(sessionId: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		this.cancelPendingReply(sessionId);
		if (session.status.get() === SessionStatus.InProgress) {
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(new Date());
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		}

		return session;
	}

	async whenIdle(): Promise<void> {
		while (this.pendingReplies.size > 0) {
			await Promise.all([...this.pendingReplies.values()].map(pending => pending.promise));
		}
	}

	private getMutableSession(sessionId: string): IMutableSession {
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		return session;
	}

	private scheduleAssistantReply(session: IMutableSession, query: string): void {
		this.cancelPendingReply(session.sessionId);
		let resolve!: () => void;
		const promise = new Promise<void>(r => {
			resolve = r;
		});
		const timer = setTimeout(() => {
			this.pendingReplies.delete(session.sessionId);
			this.sequence += 1;
			session.messages.set([
				...session.messages.get(),
				{ id: `${session.sessionId}-assistant-${this.sequence}`, role: 'assistant', text: `Mock response for: ${query}` }
			]);
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(new Date());
			session.isRead.set(false);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			resolve();
		}, this.responseDelayMs);
		this.pendingReplies.set(session.sessionId, { timer, promise, resolve });
	}

	private cancelPendingReply(sessionId: string): void {
		const pending = this.pendingReplies.get(sessionId);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timer);
		this.pendingReplies.delete(sessionId);
		pending.resolve();
	}
```

3f. Update the registration helper at the bottom of the file:

```ts
export function registerMockSessionsProvider(
	providersService: ISessionsProvidersService,
	options: IMockSessionsProviderOptions = {}
): MockSessionsProvider {
	const provider = new MockSessionsProvider(options);
	providersService.registerProvider(provider);
	return provider;
}
```

3g. In `src/sessions/contrib/mockProvider/browser/mockSessions.contribution.ts`, also re-export the options type:

```ts
export { MockSessionsProvider, registerMockSessionsProvider } from './mockSessionsProvider.js';
export type { IMockSessionsProviderOptions } from './mockSessionsProvider.js';
```

- [ ] **Step 4: Run the provider tests to verify they pass**

Run: `npm run build && node --test dist/tests/unit/mockSessionsProvider.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Keep the sessions-service test fast and idle-clean**

In `tests/unit/sessionsManagementService.test.ts`, in the test `'sessions service starts a session and marks it active'`, change:

```ts
	const provider = registerMockSessionsProvider(providersService);
```

to:

```ts
	const provider = registerMockSessionsProvider(providersService, { responseDelayMs: 1 });
```

and add as the last line of the test body:

```ts
	await provider.whenIdle();
```

- [ ] **Step 6: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/contrib/mockProvider tests/unit/mockSessionsProvider.test.ts tests/unit/sessionsManagementService.test.ts
git commit -m "fix: give mock sessions a real lifecycle with unique ids and timestamps"
```

---

### Task 2: Plumb stopSession through the service chain

Fixes the "no stop API exists" half of the inert-Stop-button finding.

**Files:**
- Modify: `src/sessions/services/sessions/common/sessionsProvider.ts`
- Modify: `src/sessions/services/sessions/common/sessionsManagement.ts`
- Modify: `src/sessions/services/sessions/browser/sessionsManagementService.ts`
- Modify: `src/sessions/services/sessions/browser/sessionsService.ts`
- Test: `tests/unit/sessionsManagementService.test.ts`

**Interfaces:**
- Consumes: `MockSessionsProvider.stopSession` from Task 1.
- Produces: `stopSession(sessionId: string): Promise<ISession>` on `ISessionsProvider`, `ISessionsManagementService`, and `ISessionsService`. Task 3/4's `ConversationView` calls `ISessionsService.stopSession`.

- [ ] **Step 1: Write the failing routing test**

In `tests/unit/sessionsManagementService.test.ts`, add after the `'sendMessage routes to the provider that owns the session'` test:

```ts
test('stopSession routes to the provider that owns the session', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	await management.stopSession('session-b');

	assert.deepEqual(first.sentRequests, []);
	assert.deepEqual(second.sentRequests, ['stop:session-b']);
});
```

And add to the `TestProvider` class (after `sendMessage`):

```ts
	async stopSession(sessionId: string): Promise<ISession> {
		this.requests.push(`stop:${sessionId}`);
		return this.sessions[0]!;
	}
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test dist/tests/unit/sessionsManagementService.test.js`
Expected: FAIL — typecheck error `Property 'stopSession' does not exist on type 'ISessionsManagementService'` (a `tsc` failure counts as the failing state).

- [ ] **Step 3: Add stopSession to the contracts and services**

3a. `src/sessions/services/sessions/common/sessionsProvider.ts` — add to `ISessionsProvider` after `sendMessage`:

```ts
	stopSession(sessionId: string): Promise<ISession>;
```

3b. `src/sessions/services/sessions/common/sessionsManagement.ts` — add to `ISessionsManagementService` after `sendMessage`:

```ts
	stopSession(sessionId: string): Promise<ISession>;
```

3c. `src/sessions/services/sessions/browser/sessionsManagementService.ts` — add to `SessionsManagementService` after `sendMessage`:

```ts
	async stopSession(sessionId: string): Promise<ISession> {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const provider = this.providersService.getProvider(session.providerId);
		if (!provider) {
			throw new Error(`Unknown provider: ${session.providerId}`);
		}

		return provider.stopSession(sessionId);
	}
```

3d. `src/sessions/services/sessions/browser/sessionsService.ts` — add to the `ISessionsService` interface after `sendMessage`:

```ts
	stopSession(sessionId: string): Promise<ISession>;
```

and to the `SessionsService` class after its `sendMessage` method:

```ts
	async stopSession(sessionId: string): Promise<ISession> {
		return this.managementService.stopSession(sessionId);
	}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/services tests/unit/sessionsManagementService.test.ts
git commit -m "feat: plumb stopSession through provider, management, and sessions services"
```

---

### Task 3: Injectable mock reply delay (env → preload → workbench)

Test hook required by Tasks 4-6 e2e: `AGENT_CHAT_MOCK_DELAY_MS=120000` freezes the running state; small values accelerate replies. No user-visible behavior change when unset.

**Files:**
- Modify: `src/preload/preload.ts`
- Modify: `src/sessions/browser/workbench.ts`

**Interfaces:**
- Consumes: `registerMockSessionsProvider(providersService, options)` from Task 1.
- Produces: `window.agentWindow.mockResponseDelayMs?: number` global, honored at workbench startup. E2e tests set it via `electron.launch({ env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '...' } })`.

- [ ] **Step 1: Expose the env var in preload**

Replace the `exposeInMainWorld` call in `src/preload/preload.ts` with:

```ts
const mockResponseDelayMs = Number.parseInt(process.env['AGENT_CHAT_MOCK_DELAY_MS'] ?? '', 10);

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {})
});
```

- [ ] **Step 2: Honor it at workbench startup**

In `src/sessions/browser/workbench.ts`:

2a. Extend the globals type:

```ts
type AgentWindowGlobals = typeof globalThis & {
	readonly agentWindow?: {
		readonly platform?: NodeJS.Platform;
		readonly mockResponseDelayMs?: number;
	};
};
```

2b. In `startup()`, replace `registerMockSessionsProvider(this.providersService);` with:

```ts
		const mockResponseDelayMs = (globalThis as AgentWindowGlobals).agentWindow?.mockResponseDelayMs;
		registerMockSessionsProvider(
			this.providersService,
			mockResponseDelayMs === undefined ? {} : { responseDelayMs: mockResponseDelayMs }
		);
```

- [ ] **Step 3: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/preload/preload.ts src/sessions/browser/workbench.ts
git commit -m "feat: allow overriding mock reply delay via AGENT_CHAT_MOCK_DELAY_MS"
```

---

### Task 4: Composer fixes — follow-up sends, draft preservation, working Stop button

Fixes: send guard permanently blocking follow-ups, message loss + unhandled rejection on failed send, inert Stop button.

**Files:**
- Modify: `src/sessions/browser/parts/conversationView.ts`
- Modify: `src/sessions/browser/parts/media/sessionView.css`
- Test: `tests/e2e/agents-window.spec.ts`

**Interfaces:**
- Consumes: `ISessionsService.stopSession` (Task 2), env delay hook (Task 3).
- Produces: `ISessionMessageSender` gains `stopSession(sessionId: string): Promise<unknown>` (structurally satisfied by `SessionsService`); a `.conversation-send-error` element inside `.conversation-composer`.

- [ ] **Step 1: Stabilize existing running-state e2e tests against the auto-reply**

The mock now replies after 3s by default, flipping the composer from `running` to `idle`. Every existing e2e test that starts a session through the UI and asserts the running shell must pin the delay high. Find them:

Run: `grep -n "electron.launch" tests/e2e/agents-window.spec.ts`

For each test that afterwards fills `.new-session-input` and clicks/submits (at minimum: `'starting a conversation creates a running session shell'`, `'starting multiple conversations keeps a single active conversation page'`, and any test asserting `.sessions-project-task-spinner` or `.conversation-composer.running` after starting a session), change the launch call to:

```ts
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000' }
		});
```

Tests that only read seed sessions (screenshot shell test, historical-messages test) need no change.

- [ ] **Step 2: Add the new failing e2e tests**

Add after the `'starting a conversation creates a running session shell'` test:

```ts
test('conversation supports stop and follow-up turns', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '500' }
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.conversation-message.assistant .conversation-message-text').last())
			.toHaveText('Mock response for: hello');
		await expect(page.locator('.conversation-send-button')).toBeVisible();
		await expect(page.locator('.conversation-stop-button')).toBeHidden();

		await page.locator('.conversation-input').fill('follow up');
		await page.locator('.conversation-input').press('Enter');
		await expect(page.locator('.conversation-message.user .conversation-message-bubble').last())
			.toHaveText('follow up');
		await expect(page.locator('.conversation-message.assistant .conversation-message-text').last())
			.toHaveText('Mock response for: follow up');

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('stop button ends the running state', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000' }
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.conversation-stop-button')).toBeVisible();
		await page.locator('.conversation-stop-button').click();

		await expect(page.locator('.conversation-send-button')).toBeVisible();
		await expect(page.locator('.conversation-stop-button')).toBeHidden();
		await expect(page.locator('.conversation-thinking-row')).toHaveCount(0);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});
```

- [ ] **Step 3: Run the new e2e tests to verify they fail**

Run: `npm run build && npx playwright test -g "conversation supports stop and follow-up turns"`
Expected: FAIL — the follow-up Enter is swallowed by the InProgress guard... unless the reply already landed. Note: with the Task 1 lifecycle the follow-up may actually pass; the stop test is the hard failure:

Run: `npx playwright test -g "stop button ends the running state"`
Expected: FAIL — clicking Stop does nothing; `.conversation-send-button` never becomes visible.

- [ ] **Step 4: Implement the ConversationView changes**

In `src/sessions/browser/parts/conversationView.ts`:

4a. Extend the sender contract:

```ts
export interface ISessionMessageSender {
	sendMessage(sessionId: string, query: string): Promise<unknown>;
	stopSession(sessionId: string): Promise<unknown>;
}
```

4b. Add fields next to `private isSending = false;`:

```ts
	private isStopping = false;
```

and a `private readonly sendError: HTMLElement;` declaration next to `private readonly reconnectStatus: HTMLElement;`.

4c. In the constructor, after the `inputWrap` block (after the send button is created) and before `this._registerEventListeners();`, create the error element as the last child of the composer:

```ts
		this.sendError = append(this.composer, document.createElement('div'));
		this.sendError.className = 'conversation-send-error';
		this.sendError.setAttribute('role', 'alert');
		this.sendError.hidden = true;
```

4d. In `_registerEventListeners()`, add:

```ts
		this.stopButton.addEventListener('click', () => {
			void this.stop();
		});
```

4e. In `openSession()`, after `this.header.openSession(session);` add:

```ts
		this.setSendError(undefined);
```

4f. Replace `send()` entirely and add `stop()`/`setSendError()`:

```ts
	private async send(): Promise<void> {
		const query = this.input.value.trim();
		const session = this.session;
		if (
			!query
			|| !session
			|| this.isSending
			|| session.interactivity.get() !== SessionInteractivity.Full
		) {
			return;
		}

		this.isSending = true;
		this.setSendError(undefined);
		this.updateComposerState();

		try {
			await this.messageSender?.sendMessage(session.sessionId, query);
			this.input.value = '';
		} catch {
			this.setSendError('Message failed to send. Your draft was kept — try again.');
		} finally {
			this.isSending = false;
			this.updateComposerState();
		}
	}

	private async stop(): Promise<void> {
		const session = this.session;
		if (!session || this.isStopping) {
			return;
		}

		this.isStopping = true;
		this.stopButton.disabled = true;

		try {
			await this.messageSender?.stopSession(session.sessionId);
		} catch {
			this.setSendError('Could not stop the session.');
		} finally {
			this.isStopping = false;
			this.stopButton.disabled = false;
		}
	}

	private setSendError(message: string | undefined): void {
		this.sendError.textContent = message ?? '';
		this.sendError.hidden = !message;
	}
```

Key changes vs. the old `send()`: the `session.status.get() === SessionStatus.InProgress` guard is gone (typing while running queues a follow-up, matching the placeholder copy), and the input is only cleared after a successful send.

4g. In `updateComposerState()`, change the send-button disabled line to:

```ts
		this.sendButton.disabled = !canType || !hasText;
```

(the button is hidden while running; the `isRunning ||` term otherwise blocks the Enter path's visual state after the fix).

4h. If `SessionStatus` is now an unused import, remove it from the import list — it is still used by `render()`/`conversationStatusId`, so it should stay; verify with `npm run typecheck`.

- [ ] **Step 5: Style the error element**

Append to `src/sessions/browser/parts/media/sessionView.css`:

```css
.conversation-send-error {
	margin: 4px auto 0;
	max-width: var(--vscode-agents-size-composer-width);
	color: var(--vscode-agents-color-status-error, #f14c4c);
	font-size: 12px;
}
```

- [ ] **Step 6: Run the e2e suite**

Run: `npm run build && npx playwright test`
Expected: PASS, including both new tests. If `assertRunningConversationShell` fails on a `running`-state assertion, the launch env from Step 1 is missing on that test — fix the env, not the helper.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/browser/parts/conversationView.ts src/sessions/browser/parts/media/sessionView.css tests/e2e/agents-window.spec.ts
git commit -m "fix: allow follow-up sends, preserve drafts on failure, wire stop button"
```

---

### Task 5: Enter starts a session on the new-session landing

**Files:**
- Modify: `src/sessions/browser/parts/newSessionView.ts`
- Test: `tests/e2e/agents-window.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: Enter (without Shift, not composing) submits the new-session composer, mirroring `ConversationView`'s keydown handling.

- [ ] **Step 1: Add the failing e2e test**

```ts
test('enter starts a session from the new session landing', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000' }
		});
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello enter');
		await page.locator('.new-session-input').press('Enter');

		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/mode-conversation/);
		await expect(page.locator('.conversation-context-title')).toHaveText('hello enter');
	} finally {
		await app?.close();
	}
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx playwright test -g "enter starts a session from the new session landing"`
Expected: FAIL — Enter inserts a newline; the workbench stays in `mode-new-session`.

- [ ] **Step 3: Implement the keydown handler**

In `src/sessions/browser/parts/newSessionView.ts`, immediately after the existing `composer.addEventListener('submit', ...)` block, add:

```ts
		input.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}

			event.preventDefault();
			composer.requestSubmit();
		});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx playwright test -g "enter starts a session from the new session landing"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/browser/parts/newSessionView.ts tests/e2e/agents-window.spec.ts
git commit -m "fix: submit new session composer on enter"
```

---

### Task 6: Review tab renders the live ChangesView; delete orphaned FilesView

Fixes: auxiliary bar showing static placeholder text instead of session change data; removes the orphaned `FilesView`.

**Files:**
- Modify: `src/sessions/browser/parts/auxiliaryBarPart.ts`
- Delete: `src/sessions/contrib/files/browser/filesView.ts`
- Test: `tests/e2e/agents-window.spec.ts` (the `assertRightSidePaneInteraction` / `assertSidePaneTab` helpers)

**Interfaces:**
- Consumes: existing `ChangesView(container: HTMLElement, options: { sessionsService?; sessionsPartService? })` from `src/sessions/contrib/changes/browser/changesView.ts`; `.changes-view` CSS already exists in `auxiliaryBarPart.css`.
- Produces: `.auxiliary-view[data-tab-id="review"]` contains a live `.changes-view` bound to the active session.

- [ ] **Step 1: Update the e2e helpers to expect live content (failing first)**

In `tests/e2e/agents-window.spec.ts`:

1a. Change `assertSidePaneTab`'s signature so the body text is optional, and wrap its existing body-text assertion:

```ts
async function assertSidePaneTab(page: Page, tabId: string, title: string, bodyText?: string): Promise<void> {
```

and around the existing `.auxiliary-view-body` text expectation:

```ts
	if (bodyText !== undefined) {
		await expect(page.locator('.auxiliary-view-body')).toHaveText(bodyText);
	}
```

(keep every other assertion in the helper unchanged).

1b. In `assertRightSidePaneInteraction`, replace:

```ts
	await page.locator('.auxiliary-empty-card').filter({ hasText: 'Review' }).click();
	await assertSidePaneTab(page, 'review', 'Review', 'Review changes');
```

with:

```ts
	await page.locator('.auxiliary-empty-card').filter({ hasText: 'Review' }).click();
	await assertSidePaneTab(page, 'review', 'Review');
	const changesView = page.locator('.auxiliary-view[data-tab-id="review"] .changes-view');
	await expect(changesView).toBeVisible();
	await expect(changesView.locator('.changes-view-subtitle')).toHaveText('hello');
	await expect(changesView.locator('.changes-summary-stat.files .changes-summary-value')).toHaveText('5');
```

(the caller starts the session with the query `hello`, and `startSession` seeds `changesSummary.files = 5`).

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx playwright test -g "starting a conversation creates a running session shell"`
Expected: FAIL — no `.changes-view` inside the review tab.

- [ ] **Step 3: Wire ChangesView into the Review tab**

In `src/sessions/browser/parts/auxiliaryBarPart.ts`:

3a. Add imports:

```ts
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ChangesView } from '../../contrib/changes/browser/changesView.js';
```

3b. Make the static `body` copy optional — change the tab config type to `readonly body?: string;` and delete the `body: 'Review changes'` line from the `review` entry (keep `body` on `terminal` and `browser`).

3c. Add a view-lifecycle store field to the class:

```ts
	private readonly viewDisposables = this._register(new DisposableStore());
```

3d. At the top of `renderContent()`, before `container.textContent = '';`, add:

```ts
		this.viewDisposables.clear();
```

3e. In `renderTabbedPane`, replace the body-creation block:

```ts
		const body = document.createElement('div');
		body.className = 'auxiliary-view-body';
		body.textContent = activeTab.body;
		view.appendChild(body);
```

with:

```ts
		const body = document.createElement('div');
		body.className = 'auxiliary-view-body';
		view.appendChild(body);

		if (activeTab.id === 'review') {
			this.viewDisposables.add(new ChangesView(body, {
				...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
				...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {})
			}));
		} else {
			body.textContent = activeTab.body ?? '';
		}
```

(the conditional spreads keep `exactOptionalPropertyTypes` happy).

- [ ] **Step 4: Delete the orphaned FilesView**

Run: `grep -rn "filesView\|FilesView" src tests`
Expected: only `src/sessions/contrib/files/browser/filesView.ts` itself. Then:

```bash
git rm src/sessions/contrib/files/browser/filesView.ts
```

If the grep shows other references, stop and wire them instead of deleting — that would mean the orphan analysis was wrong.

- [ ] **Step 5: Run e2e to verify pass**

Run: `npm run build && npx playwright test -g "starting a conversation creates a running session shell"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/browser/parts/auxiliaryBarPart.ts tests/e2e/agents-window.spec.ts
git commit -m "fix: render live changes view in review tab and drop orphaned files view"
```

---

### Task 7: Grid honors visibility state and minimum-width contracts

Fixes: `layout()` hardcoding editor/panel to hidden while `isPartVisible` reports otherwise; sessions part being crushed below its 640px minimum instead of the auxiliary bar shrinking/hiding.

**Files:**
- Modify: `src/sessions/base/browser/grid.ts`
- Create: `tests/unit/workbenchGrid.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: same public API (`WorkbenchGrid`, `setPartVisible`, `isPartVisible`, `layout`, `LayoutPriority`, `IGridView`); behavior contract: (a) `layout()` obeys `this.visibility` for every part; (b) top-row widths honor `minimumWidth`, extra space goes to the `LayoutPriority.High` view, and when minimums cannot fit, the lowest-priority view is dropped (display `none`) rather than crushing the High view; (c) a visible panel is laid out below the content row, spanning the width right of the sidebar.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/workbenchGrid.test.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { LayoutPriority, WorkbenchGrid, type IGridView } from '../../src/sessions/base/browser/grid.js';

interface ILayoutCall {
	readonly width: number;
	readonly height: number;
	readonly top: number;
	readonly left: number;
}

interface IFakeView {
	readonly view: IGridView;
	readonly calls: ILayoutCall[];
	readonly element: { readonly style: { display: string } };
}

function createFakeView(minimumWidth: number, minimumHeight: number, priority: LayoutPriority): IFakeView {
	const calls: ILayoutCall[] = [];
	const element = { style: { display: '' } };
	const view: IGridView = {
		element: element as unknown as HTMLElement,
		minimumWidth,
		minimumHeight,
		priority,
		layout: (width, height, top, left) => {
			calls.push({ width, height, top, left });
		}
	};
	return { view, calls, element };
}

function createGrid() {
	const titlebar = createFakeView(0, 52, LayoutPriority.Normal);
	const sidebar = createFakeView(170, 0, LayoutPriority.Low);
	const sessions = createFakeView(640, 0, LayoutPriority.High);
	const editor = createFakeView(320, 0, LayoutPriority.Normal);
	const auxiliaryBar = createFakeView(260, 0, LayoutPriority.Low);
	const panel = createFakeView(0, 120, LayoutPriority.Normal);
	const grid = new WorkbenchGrid(
		{
			titlebar: titlebar.view,
			sidebar: sidebar.view,
			sessions: sessions.view,
			editor: editor.view,
			auxiliaryBar: auxiliaryBar.view,
			panel: panel.view
		},
		{ sidebar: true, sessions: true, editor: false, auxiliaryBar: true, panel: false },
		{ titlebarHeight: 52, sidebarWidth: 270, auxiliaryBarWidth: 340, editorWidth: 360, panelHeight: 300 }
	);
	return { grid, titlebar, sidebar, sessions, editor, auxiliaryBar, panel };
}

test('sessions part absorbs extra width as the high priority view', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();

	grid.layout(1600, 900);

	assert.deepEqual(sessions.calls.at(-1), { width: 990, height: 900, top: 0, left: 270 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1260 });
});

test('auxiliary bar is dropped before sessions falls below its minimum width', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();

	grid.layout(960, 640);

	assert.equal(auxiliaryBar.element.style.display, 'none');
	assert.deepEqual(sessions.calls.at(-1), { width: 690, height: 640, top: 0, left: 270 });
});

test('setPartVisible(panel) lays out the panel below the content row', () => {
	const { grid, sessions, panel } = createGrid();

	grid.setPartVisible('panel', true);
	grid.layout(1600, 900);

	assert.equal(grid.isPartVisible('panel'), true);
	assert.notEqual(panel.element.style.display, 'none');
	assert.deepEqual(panel.calls.at(-1), { width: 1330, height: 300, top: 600, left: 270 });
	assert.equal(sessions.calls.at(-1)?.height, 600);
});

test('editor participates in the content row when visible', () => {
	const { grid, sessions, editor, auxiliaryBar } = createGrid();

	grid.setPartVisible('editor', true);
	grid.layout(1700, 900);

	assert.deepEqual(sessions.calls.at(-1), { width: 730, height: 900, top: 0, left: 270 });
	assert.deepEqual(editor.calls.at(-1), { width: 360, height: 900, top: 0, left: 1000 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1360 });
});

test('hidden editor and panel stay hidden and receive no layout', () => {
	const { grid, editor, panel } = createGrid();

	grid.layout(1600, 900);

	assert.equal(editor.element.style.display, 'none');
	assert.equal(panel.element.style.display, 'none');
	assert.equal(editor.calls.length, 0);
	assert.equal(panel.calls.length, 0);
});
```

Width math for reviewers: window 1600 → sidebar 270, right 1330; sessions min 640 (High) + aux 340 = 980, extra 350 goes to sessions → 990. Window 960 → right 690; 640+340 overflows, aux shrinks to its 260 minimum, still overflows, aux (lowest priority) is dropped, sessions takes all 690. Panel visible → content height 900−300=600, panel at top 600 spanning right width 1330.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test dist/tests/unit/workbenchGrid.test.js`
Expected: FAIL — panel/editor tests fail (hardcoded hidden); the 960px test fails (sessions crushed to 350, aux still visible).

- [ ] **Step 3: Rework the layout path**

In `src/sessions/base/browser/grid.ts`, keep everything through `isPartVisible` unchanged, then:

3a. Replace `layout()` with:

```ts
	layout(width: number, height: number): void {
		const safeWidth = Math.max(0, width);
		const safeHeight = Math.max(0, height);

		this.parts.titlebar.layout(safeWidth, this.dimensions.titlebarHeight, 0, 0);

		const sidebarWidth = this.visibility.sidebar
			? Math.min(safeWidth, Math.max(this.parts.sidebar.minimumWidth, this.dimensions.sidebarWidth))
			: 0;
		const rightWidth = Math.max(0, safeWidth - sidebarWidth);

		const panelHeight = this.visibility.panel
			? Math.min(safeHeight, Math.max(this.parts.panel.minimumHeight, this.dimensions.panelHeight))
			: 0;
		const contentHeight = Math.max(0, safeHeight - panelHeight);

		layoutOrHide(this.parts.sidebar, this.visibility.sidebar, sidebarWidth, safeHeight, 0, 0);

		const entries = this.collectTopRowEntries();
		const included = new Set(entries.map(entry => entry.name));
		for (const name of ['sessions', 'editor', 'auxiliaryBar'] as const) {
			if (!included.has(name)) {
				this.parts[name].element.style.display = 'none';
			}
		}

		const widths = computeHorizontalWidths(entries, rightWidth);
		layoutTopRow(entries, widths, contentHeight, 0, sidebarWidth);

		layoutOrHide(this.parts.panel, this.visibility.panel, rightWidth, panelHeight, contentHeight, sidebarWidth);
	}
```

3b. Replace the free function `layoutHorizontalViews` with `layoutTopRow` (zero-width entries are hidden, not laid out):

```ts
function layoutTopRow(
	entries: readonly IHorizontalEntry[],
	widths: readonly number[],
	height: number,
	top: number,
	left: number
): void {
	let offset = left;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const width = widths[index];
		if (!entry || width === undefined) {
			continue;
		}

		if (width === 0) {
			entry.view.element.style.display = 'none';
			continue;
		}

		entry.view.element.style.display = '';
		entry.view.layout(width, height, top, offset);
		offset += width;
	}
}
```

3c. In `computeHorizontalWidths`, replace the `else if (delta < 0)` branch with:

```ts
	} else if (delta < 0) {
		shrinkWidths(entries, widths, -delta);
		const shrunkTotal = widths.reduce((sum, value) => sum + value, 0);
		if (shrunkTotal > availableWidth) {
			if (entries.length > 1) {
				return dropLowestPriorityEntry(entries, availableWidth);
			}

			widths[0] = Math.min(widths[0] ?? 0, availableWidth);
		}
	}
```

3d. Add the drop helper after `computeHorizontalWidths`:

```ts
function dropLowestPriorityEntry(entries: readonly IHorizontalEntry[], availableWidth: number): number[] {
	let dropIndex = 0;
	let dropPriority = Number.POSITIVE_INFINITY;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry && entry.view.priority <= dropPriority) {
			dropPriority = entry.view.priority;
			dropIndex = index;
		}
	}

	const kept = entries.filter((_, index) => index !== dropIndex);
	const keptWidths = computeHorizontalWidths(kept, availableWidth);
	const widths: number[] = [];
	let keptCursor = 0;

	for (let index = 0; index < entries.length; index++) {
		widths.push(index === dropIndex ? 0 : keptWidths[keptCursor++] ?? 0);
	}

	return widths;
}
```

3e. In `shrinkWidths`, delete the entire trailing `if (remaining > 0) { ... }` fallback block (reducing views below their minimums is now replaced by dropping the lowest-priority view).

- [ ] **Step 4: Run unit + e2e to verify no regression**

Run: `npm run test:unit && npx playwright test`
Expected: PASS — the default workbench (editor/panel invisible) produces the same layout as before; screenshots unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/base/browser/grid.ts tests/unit/workbenchGrid.test.ts
git commit -m "fix: make grid honor part visibility and minimum-width contracts"
```

---

### Task 8: macOS activate recreates the window

**Files:**
- Create: `src/main/appLifecycle.ts`
- Modify: `src/main/main.ts`
- Create: `tests/unit/appLifecycle.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IAppLifecycleHost { platform; getWindowCount(); createWindow(); quit() }`, `handleWindowAllClosed(host)`, `handleActivate(host)` — pure functions, no Electron imports, unit-testable under `node:test`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/appLifecycle.test.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleActivate, handleWindowAllClosed, type IAppLifecycleHost } from '../../src/main/appLifecycle.js';

function createHost(platform: NodeJS.Platform, windowCount: number) {
	let quitCalls = 0;
	let createCalls = 0;
	const host: IAppLifecycleHost = {
		platform,
		getWindowCount: () => windowCount,
		createWindow: async () => {
			createCalls += 1;
		},
		quit: () => {
			quitCalls += 1;
		}
	};
	return { host, quitCalls: () => quitCalls, createCalls: () => createCalls };
}

test('window-all-closed quits on non-darwin platforms', () => {
	const { host, quitCalls } = createHost('win32', 0);
	handleWindowAllClosed(host);
	assert.equal(quitCalls(), 1);
});

test('window-all-closed keeps the app alive on darwin', () => {
	const { host, quitCalls } = createHost('darwin', 0);
	handleWindowAllClosed(host);
	assert.equal(quitCalls(), 0);
});

test('activate recreates a window when none are open', () => {
	const { host, createCalls } = createHost('darwin', 0);
	handleActivate(host);
	assert.equal(createCalls(), 1);
});

test('activate does nothing while a window is open', () => {
	const { host, createCalls } = createHost('darwin', 1);
	handleActivate(host);
	assert.equal(createCalls(), 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test dist/tests/unit/appLifecycle.test.js`
Expected: FAIL — module `src/main/appLifecycle.ts` does not exist (build error).

- [ ] **Step 3: Implement the lifecycle module**

Create `src/main/appLifecycle.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IAppLifecycleHost {
	readonly platform: NodeJS.Platform;
	getWindowCount(): number;
	createWindow(): Promise<void>;
	quit(): void;
}

export function handleWindowAllClosed(host: IAppLifecycleHost): void {
	if (host.platform !== 'darwin') {
		host.quit();
	}
}

export function handleActivate(host: IAppLifecycleHost): void {
	if (host.getWindowCount() === 0) {
		void host.createWindow();
	}
}
```

- [ ] **Step 4: Wire it in main.ts**

In `src/main/main.ts`, add the import:

```ts
import { handleActivate, handleWindowAllClosed } from './appLifecycle.js';
```

and replace the bottom block (`app.whenReady()...` through the end of the file) with:

```ts
const lifecycleHost = {
	platform: process.platform,
	getWindowCount: () => BrowserWindow.getAllWindows().length,
	createWindow,
	quit: () => app.quit()
};

app.whenReady().then(createWindow);
app.on('window-all-closed', () => handleWindowAllClosed(lifecycleHost));
app.on('activate', () => handleActivate(lifecycleHost));
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm run build && node --test dist/tests/unit/appLifecycle.test.js`
Expected: PASS (4 tests). Manual spot-check (optional, macOS only): `npm start`, close the window, click the Dock icon — a new window opens.

- [ ] **Step 6: Commit**

```bash
git add src/main/appLifecycle.ts src/main/main.ts tests/unit/appLifecycle.test.ts
git commit -m "fix: recreate window on macos dock activate"
```

---

### Task 9: Full verification

**Files:** none new.

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck clean, all unit tests pass, all Playwright tests pass, fresh screenshots written to `test-results/agents-window-1440x900.png` and `test-results/agents-window-1280x720.png`.

- [ ] **Step 2: Visually inspect the screenshots**

Open both screenshots and confirm the shell is unchanged: titlebar, sidebar, conversation/new-session area render as before (the grid rework must be behavior-preserving for the default visibility set).

- [ ] **Step 3: Sanity-check seed time labels**

Run: `npx playwright test -g "agents window shell renders at desktop sizes"`
Expected: PASS. The sidebar's hardcoded `timeLabel` strings (`'2h'`, `'3d'`, `'now'`) come from `sessionsList.ts` static data, not provider timestamps, so Task 1's timestamp change must not have moved them — if this test fails on a time label, inspect `sessionsList.ts` line ~604 (`row.meta?.timeLabel ?? formatTimestamp(row.updatedAt)`) before touching assertions.

- [ ] **Step 4: Commit any stragglers and record status**

```bash
git status --short   # should be clean; commit anything intentional that remains
```

Append to this plan's Execution Status section (create it under the header): date, final command run, and result.

## Execution Status

- **Date:** 2026-07-06
- **Branch:** `codex/agents-window-rebuild`
- **Commands run:**
  - `npm run verify`
  - `npx playwright test -g "agents window shell renders at desktop sizes"`
- **Result:** PASS
  - Typecheck: clean
  - Unit tests: 33 passed, 0 failed
  - E2E tests: 9 passed, 0 failed
  - Seed time-labels sanity test: 1 passed
- **Screenshots:** `test-results/agents-window-1440x900.png` and `test-results/agents-window-1280x720.png` both show the expected shell layout (titlebar, sidebar, new-session landing) at each resolution.
- **Remaining concerns:** None.
