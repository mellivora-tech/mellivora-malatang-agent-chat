import test from 'node:test';
import assert from 'node:assert/strict';

import { observableValue } from '../../src/sessions/base/common/observable.js';
import { ChatInteractivity, SessionStatus, type IChat, type IChatMessage, type ISession } from '../../src/sessions/services/sessions/common/session.js';
import { VisibleSessions } from '../../src/sessions/services/sessions/browser/visibleSessions.js';

function createChat(id: string, title: string): IChat {
	return {
		id,
		title: observableValue(title),
		messages: observableValue<readonly IChatMessage[]>([]),
		status: observableValue(SessionStatus.InProgress),
		interactivity: observableValue(ChatInteractivity.Full)
	};
}

function createSession(sessionId: string, chatCount = 1): ISession {
	const chats = Array.from({ length: chatCount }, (_, index) => createChat(`${sessionId}-chat-${index + 1}`, `Chat ${index + 1}`));

	return {
		sessionId,
		providerId: 'mock',
		sessionType: 'mock',
		icon: 'codicon-copilot',
		createdAt: new Date('2026-07-03T00:00:00.000Z'),
		workspace: observableValue(undefined),
		title: observableValue(`Session ${sessionId}`),
		updatedAt: observableValue(new Date('2026-07-03T00:00:00.000Z')),
		status: observableValue(SessionStatus.InProgress),
		description: observableValue(undefined),
		changesSummary: observableValue(undefined),
		isArchived: observableValue(false),
		isRead: observableValue(true),
		chats: observableValue(chats),
		activeChat: observableValue(chats[0]!)
	};
}

test('first session becomes active', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const visibleSessions = new VisibleSessions([first, second]);

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-1');
	assert.deepEqual(visibleSessions.visibleSessions.get().map(session => session?.sessionId), ['session-1']);
});

test('opening another session changes active session', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const visibleSessions = new VisibleSessions([first, second]);

	visibleSessions.openSession(second);

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-2');
	assert.deepEqual(visibleSessions.visibleSessions.get().map(session => session?.sessionId), ['session-1', 'session-2']);
});

test('closing active session selects a fallback', () => {
	const first = createSession('session-1');
	const second = createSession('session-2');
	const third = createSession('session-3');
	const visibleSessions = new VisibleSessions([first, second, third]);

	visibleSessions.openSession(second);
	visibleSessions.openSession(third);
	visibleSessions.closeSession('session-3');

	assert.equal(visibleSessions.activeSession.get()?.sessionId, 'session-2');
	assert.deepEqual(visibleSessions.visibleSessions.get().map(session => session?.sessionId), ['session-1', 'session-2']);
});

test('multiple chats make shouldShowChatTabs true', () => {
	const session = createSession('session-1', 2);
	const visibleSessions = new VisibleSessions([session]);

	assert.equal(visibleSessions.activeSession.get()?.shouldShowChatTabs.get(), true);
});
