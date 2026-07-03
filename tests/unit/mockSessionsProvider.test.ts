/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { MockSessionsProvider } from '../../src/sessions/contrib/mockProvider/browser/mockSessionsProvider.js';
import { SessionInteractivity, SessionStatus, type ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';

test('mock provider creates a running session from first prompt', async () => {
	const provider = new MockSessionsProvider();
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
	assert.deepEqual(session.messages.get().map((message: ISessionMessage) => message.text), ['hello']);
	assert.equal(session.messages.get()[0]?.role, 'user');
	assert.deepEqual(events, [{ added: [session], removed: [], changed: [] }]);
	disposable.dispose();
});

test('mock provider appends follow-up turns to session messages', async () => {
	const provider = new MockSessionsProvider();
	const session = await provider.startSession('hello');

	await provider.sendMessage(session.sessionId, 'follow up');

	assert.deepEqual(session.messages.get().map((message: ISessionMessage) => message.text), [
		'hello',
		'follow up',
		'Mock response for: follow up'
	]);
	assert.deepEqual(session.messages.get().map((message: ISessionMessage) => message.role), [
		'user',
		'user',
		'assistant'
	]);
});
