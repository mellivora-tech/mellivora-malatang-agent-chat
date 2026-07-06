/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { FileSessionsProvider } from '../../src/sessions/contrib/fileProvider/browser/fileSessionsProvider.js';
import { SessionInteractivity, SessionStatus } from '../../src/sessions/services/sessions/common/session.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionSnapshot, ISessionsBridge } from '../../src/sessions/services/sessions/common/sessionsBridge.js';

interface IAppendCall {
	readonly ref: ISessionRef;
	readonly entry: ISessionEntry;
}

interface IFakeBridge extends ISessionsBridge {
	readonly creates: ISessionHeader[];
	readonly appends: IAppendCall[];
	failAppends: boolean;
	failCreates: boolean;
}

function createFakeBridge(snapshots: readonly ISessionSnapshot[] = []): IFakeBridge {
	const creates: ISessionHeader[] = [];
	const appends: IAppendCall[] = [];
	const bridge: IFakeBridge = {
		creates,
		appends,
		failAppends: false,
		failCreates: false,
		list: async () => snapshots,
		create: async header => {
			if (bridge.failCreates) {
				throw new Error('create failed');
			}
			creates.push(header);
		},
		append: async (ref, entry) => {
			if (bridge.failAppends) {
				throw new Error('append failed');
			}
			appends.push({ ref, entry });
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
