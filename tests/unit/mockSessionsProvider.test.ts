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
