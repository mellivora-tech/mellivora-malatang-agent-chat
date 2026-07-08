import test from 'node:test';
import assert from 'node:assert/strict';

import { observableValue } from '../../src/sessions/base/common/observable.js';
import { SessionInteractivity, SessionStatus, type ISession, type ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';
import { VisibleSessions } from '../../src/sessions/services/sessions/browser/visibleSessions.js';

function createSession(sessionId: string): ISession {
	return {
		sessionId,
		providerId: 'mock',
		sessionType: 'mock',
		icon: 'codicon-copilot',
		createdAt: new Date('2026-07-03T00:00:00.000Z'),
		projectId: undefined,
		workspace: observableValue(undefined),
		title: observableValue(`Session ${sessionId}`),
		updatedAt: observableValue(new Date('2026-07-03T00:00:00.000Z')),
		status: observableValue(SessionStatus.InProgress),
		description: observableValue(undefined),
		changesSummary: observableValue(undefined),
		isArchived: observableValue(false),
		isRead: observableValue(true),
		isPinned: observableValue(false),
		messages: observableValue<readonly ISessionMessage[]>([]),
		interactivity: observableValue(SessionInteractivity.Full),
		pendingApproval: observableValue(undefined),
		reconnect: observableValue(undefined),
	};
}

test('first session becomes active', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const visibleSessions = new VisibleSessions([first, second]);

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-1');
	assert.deepEqual(
		visibleSessions.visibleSessions.get().map(session => session?.sessionId),
		['session-1'],
	);
});

test('opening another session replaces the visible session', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const visibleSessions = new VisibleSessions([first, second]);

	visibleSessions.openSession(second);

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-2');
	assert.deepEqual(
		visibleSessions.visibleSessions.get().map(session => session?.sessionId),
		['session-2'],
	);
});

test('opening only a session replaces existing visible sessions', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const third = createSession('session-3');
	const visibleSessions = new VisibleSessions([first, second, third]);

	visibleSessions.openSession(second);
	visibleSessions.openOnly(third);

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-3');
	assert.deepEqual(
		visibleSessions.visibleSessions.get().map(session => session?.sessionId),
		['session-3'],
	);
});

test('closing active session selects a remaining fallback', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const third = createSession('session-3');
	const visibleSessions = new VisibleSessions([first, second, third]);

	visibleSessions.openSession(second);
	visibleSessions.openSession(third);
	visibleSessions.closeSession('session-3');

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-1');
	assert.deepEqual(
		visibleSessions.visibleSessions.get().map(session => session?.sessionId),
		['session-1'],
	);
});
