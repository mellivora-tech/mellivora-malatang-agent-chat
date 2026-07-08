/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { FileSessionsProvider } from '../../src/sessions/contrib/fileProvider/browser/fileSessionsProvider.js';
import { SessionInteractivity, SessionStatus } from '../../src/sessions/services/sessions/common/session.js';
import type { IAgentBridge, IAgentEventPayload } from '../../src/sessions/services/agent/common/agent.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionSnapshot, ISessionsBridge } from '../../src/sessions/services/sessions/common/sessionsBridge.js';

interface IAppendCall {
	readonly ref: ISessionRef;
	readonly entry: ISessionEntry;
}

interface IFakeBridge extends ISessionsBridge {
	readonly creates: ISessionHeader[];
	readonly appends: IAppendCall[];
	readonly deletes: ISessionRef[];
	failAppends: boolean;
	failCreates: boolean;
}

function createFakeBridge(snapshots: readonly ISessionSnapshot[] = []): IFakeBridge {
	const creates: ISessionHeader[] = [];
	const appends: IAppendCall[] = [];
	const deletes: ISessionRef[] = [];
	// A tiny store folding state entries so tests can rehydrate a second
	// provider over the same bridge and observe persisted lifecycle state.
	const store = new Map<string, ISessionSnapshot>(snapshots.map(snapshot => [snapshot.sessionId, snapshot]));
	const bridge: IFakeBridge = {
		creates,
		appends,
		deletes,
		failAppends: false,
		failCreates: false,
		delete: async ref => {
			deletes.push(ref);
			store.delete(ref.sessionId);
		},
		list: async () => [...store.values()],
		create: async header => {
			if (bridge.failCreates) {
				throw new Error('create failed');
			}
			creates.push(header);
			store.set(header.sessionId, {
				sessionId: header.sessionId,
				sessionType: header.sessionType,
				icon: header.icon,
				createdAt: header.createdAt,
				updatedAt: header.createdAt,
				interactivity: header.interactivity,
				title: '',
				status: 2,
				isArchived: false,
				isRead: true,
				isPinned: false,
				messages: [],
				...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
				...(header.workspace !== undefined ? { workspace: header.workspace } : {}),
			});
		},
		append: async (ref, entry) => {
			if (bridge.failAppends) {
				throw new Error('append failed');
			}
			appends.push({ ref, entry });
			const existing = store.get(ref.sessionId);
			if (!existing) {
				return;
			}
			if (entry.type === 'message') {
				store.set(ref.sessionId, {
					...existing,
					messages: [...existing.messages, { id: entry.id, role: entry.role, text: entry.text, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) }],
				});
			} else {
				store.set(ref.sessionId, {
					...existing,
					...(entry.status !== undefined ? { status: entry.status } : {}),
					...(entry.title !== undefined ? { title: entry.title } : {}),
					...(entry.isArchived !== undefined ? { isArchived: entry.isArchived } : {}),
					...(entry.isRead !== undefined ? { isRead: entry.isRead } : {}),
					...(entry.isPinned !== undefined ? { isPinned: entry.isPinned } : {}),
				});
			}
		},
	};
	return bridge;
}

function createSnapshot(sessionId: string, overrides: Partial<ISessionSnapshot> = {}): ISessionSnapshot {
	return {
		sessionId,
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-06T00:00:00.000Z',
		updatedAt: '2026-07-06T01:00:00.000Z',
		interactivity: 'full',
		title: `title-${sessionId}`,
		status: 2,
		isArchived: false,
		isRead: true,
		isPinned: false,
		messages: [{ id: 'm1', role: 'user', text: 'hello' }],
		...overrides,
	};
}

test('initialize hydrates sessions from the bridge snapshots', async () => {
	const bridge = createFakeBridge([
		createSnapshot('s1', { workspace: { label: 'my-app', description: '/tmp/my-app' } }),
		createSnapshot('s2', { interactivity: 'read-only', status: 3 }),
	]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	const events: unknown[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	await provider.initialize();

	const sessions = provider.getSessions();
	assert.equal(sessions.length, 2);
	const first = sessions[0]!;
	assert.equal(first.sessionId, 's1');
	assert.equal(first.title.get(), 'title-s1');
	assert.equal(first.status.get(), SessionStatus.NeedsInput);
	assert.equal(first.interactivity.get(), SessionInteractivity.Full);
	assert.deepEqual(first.workspace.get(), { label: 'my-app', description: '/tmp/my-app' });
	assert.ok(first.createdAt instanceof Date);
	assert.equal(first.createdAt.toISOString(), '2026-07-06T00:00:00.000Z');
	assert.deepEqual(
		first.messages.get().map(message => message.id),
		['m1'],
	);
	assert.equal(sessions[1]!.status.get(), SessionStatus.Completed);
	assert.equal(sessions[1]!.interactivity.get(), SessionInteractivity.ReadOnly);
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], { added: sessions, removed: [], changed: [] });
});

test('initialize hydrates projectId and isPinned onto sessions', async () => {
	const bridge = createFakeBridge([createSnapshot('s1', { projectId: '3f2a8c1d', isPinned: true })]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();

	const session = provider.getSessions()[0]!;
	assert.equal(session.projectId, '3f2a8c1d');
	assert.equal(session.isPinned.get(), true);
});

test('startSession sets projectId on the created session', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const withProject = await provider.startSession('hello', { projectId: '3f2a8c1d' });
	const withoutProject = await provider.startSession('again');

	assert.equal(withProject.projectId, '3f2a8c1d');
	assert.equal(withoutProject.projectId, undefined);
	assert.equal(withProject.isPinned.get(), false);

	await provider.whenIdle();
});

test('initialize coerces a persisted in-progress status to needs-input', async () => {
	const bridge = createFakeBridge([createSnapshot('s1', { status: 1 })]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();

	assert.equal(provider.getSessions()[0]!.status.get(), SessionStatus.NeedsInput);
});

test('initialize is idempotent and session identity is stable', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();
	const first = provider.getSessions()[0];
	await provider.initialize();

	assert.equal(provider.getSessions().length, 1);
	assert.equal(provider.getSessions()[0], first);
});

test('startSession persists header, user message, and initial state in order', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello world');

	assert.equal(bridge.creates.length, 1);
	const header = bridge.creates[0]!;
	assert.equal(header.type, 'session');
	assert.equal(header.sessionId, session.sessionId);
	assert.equal(header.projectId, undefined);

	assert.equal(bridge.appends.length, 2);
	const [message, state] = bridge.appends;
	assert.equal(message!.entry.type, 'message');
	assert.deepEqual(message!.ref, { sessionId: session.sessionId });
	assert.equal((message!.entry as { text: string }).text, 'hello world');
	assert.equal(state!.entry.type, 'state');
	const stateEntry = state!.entry as { status?: number; title?: string; isRead?: boolean; changesSummary?: object };
	assert.equal(stateEntry.status, SessionStatus.InProgress);
	assert.equal(stateEntry.title, 'hello world');
	assert.equal(stateEntry.isRead, false);
	assert.deepEqual(stateEntry.changesSummary, { files: 5, additions: 3431, deletions: 815 });

	assert.equal(session.status.get(), SessionStatus.InProgress);
	assert.equal(provider.getSessions()[0], session);

	await provider.whenIdle();
});

test('startSession routes project sessions via the projectId option', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello', { projectId: '3f2a8c1d', workspace: { label: 'my-app', description: '/tmp/my-app' } });

	assert.equal(bridge.creates[0]!.projectId, '3f2a8c1d');
	assert.deepEqual(bridge.creates[0]!.workspace, { label: 'my-app', description: '/tmp/my-app' });
	assert.deepEqual(bridge.appends[0]!.ref, { sessionId: session.sessionId, projectId: '3f2a8c1d' });
	assert.deepEqual(session.workspace.get(), { label: 'my-app', description: '/tmp/my-app' });

	await provider.whenIdle();
});

test('the mock reply persists the assistant message and needs-input state', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello', 'Mock response for: hello'],
	);
	const entries = bridge.appends.map(call => call.entry);
	const assistant = entries.find(entry => entry.type === 'message' && entry.role === 'assistant');
	assert.ok(assistant);
	assert.equal((assistant as { text: string }).text, 'Mock response for: hello');
	const lastState = [...entries].reverse().find(entry => entry.type === 'state') as { status?: number };
	assert.equal(lastState.status, SessionStatus.NeedsInput);
});

test('sendMessage persists the follow-up turn before the reply', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.whenIdle();
	const appendCountBefore = bridge.appends.length;

	await provider.sendMessage(session.sessionId, 'follow up');

	const newEntries = bridge.appends.slice(appendCountBefore).map(call => call.entry);
	assert.equal(newEntries[0]?.type, 'message');
	assert.equal((newEntries[0] as { text: string }).text, 'follow up');
	assert.equal(newEntries[1]?.type, 'state');
	assert.equal((newEntries[1] as { status?: number }).status, SessionStatus.InProgress);

	await provider.whenIdle();
	assert.equal(session.status.get(), SessionStatus.NeedsInput);
});

test('stopSession cancels the pending reply and persists needs-input', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 60_000 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	assert.equal(session.status.get(), SessionStatus.InProgress);

	await provider.stopSession(session.sessionId);

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; status?: number };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.status, SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello'],
	);

	await provider.whenIdle();
});

test('setSessionPinned persists a pinned state entry and updates the observable', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const events: unknown[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	const session = await provider.setSessionPinned('s1', true);

	assert.equal(session.isPinned.get(), true);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; isPinned?: boolean };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.isPinned, true);
	assert.deepEqual(events, [{ added: [], removed: [], changed: [session] }]);
});

test('setSessionArchived persists an archived state entry', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.setSessionArchived('s1', true);

	assert.equal(session.isArchived.get(), true);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; isArchived?: boolean };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.isArchived, true);
});

test('pin and archive round-trip through a rehydrated provider', async () => {
	const bridge = createFakeBridge([createSnapshot('s1'), createSnapshot('s2')]);
	const first = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await first.initialize();
	await first.setSessionPinned('s1', true);
	await first.setSessionArchived('s2', true);

	const second = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await second.initialize();

	const sessions = second.getSessions();
	assert.equal(sessions.find(session => session.sessionId === 's1')?.isPinned.get(), true);
	assert.equal(sessions.find(session => session.sessionId === 's2')?.isArchived.get(), true);
});

test('deleteSession removes the session, calls bridge.delete, and fires removed', async () => {
	const bridge = createFakeBridge([createSnapshot('s1'), createSnapshot('s2')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const events: { removed: readonly { sessionId: string }[] }[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	await provider.deleteSession('s1');

	assert.deepEqual(
		provider.getSessions().map(session => session.sessionId),
		['s2'],
	);
	assert.deepEqual(bridge.deletes, [{ sessionId: 's1' }]);
	assert.equal(events.length, 1);
	assert.deepEqual(
		events[0]!.removed.map(session => session.sessionId),
		['s1'],
	);
});

test('deleteSession cancels a pending reply', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 60_000 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.deleteSession(session.sessionId);

	// whenIdle resolves immediately because the pending reply was cancelled.
	await provider.whenIdle();
	assert.equal(provider.getSessions().length, 0);
});

test('startSession rejects when the bridge create fails', async () => {
	const bridge = createFakeBridge();
	bridge.failCreates = true;
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	await assert.rejects(() => provider.startSession('hello'), /create failed/);
	assert.equal(provider.getSessions().length, 0);
});

test('reply append failures are logged without breaking the session', async t => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const errorSpy = t.mock.method(console, 'error', () => undefined);

	const session = await provider.startSession('hello');
	bridge.failAppends = true;
	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello', 'Mock response for: hello'],
	);
	assert.ok(errorSpy.mock.callCount() >= 1);
});

test('agent runs assemble a work block with tool steps and persist it', async () => {
	const bridge = createFakeBridge();

	// A scripted agent bridge: capture the event listener, drive one run.
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	let runSessionId = '';
	const agent: IAgentBridge = {
		run: async sessionId => {
			runSessionId = sessionId;
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'read_file', input: { path: 'src/a.ts' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false } });
			emit({ event: { type: 'assistant_delta', text: 'Hello' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};

	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();

	const session = await provider.startSession('do something');
	// The scripted run is synchronous but fires through microtasks; yield twice.
	await new Promise(resolve => setTimeout(resolve, 10));

	assert.equal(runSessionId, session.sessionId);
	const messages = session.messages.get();
	const work = messages.find(message => message.role === 'work');
	assert.ok(work, 'a work message exists');
	assert.ok(typeof work.durationMs === 'number', 'work block settled with a total duration');
	const toolSteps = (work.steps ?? []).filter(step => step.kind === 'tool');
	assert.deepEqual(
		toolSteps.map(step => step.label),
		['read_file src/a.ts'],
	);
	assert.ok(messages.indexOf(work) < messages.findIndex(message => message.role === 'assistant'), 'work block precedes the reply');
	assert.equal(messages.find(message => message.role === 'assistant')?.text, 'Hello');

	const persistedWork = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'work');
	assert.ok(persistedWork, 'work entry persisted');
	assert.ok((persistedWork.entry as { steps?: readonly unknown[] }).steps?.length === 1, 'persisted steps');
});
