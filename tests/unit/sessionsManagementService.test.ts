import test from 'node:test';
import assert from 'node:assert/strict';

import { Emitter } from '../../src/sessions/base/common/event.js';
import { observableValue } from '../../src/sessions/base/common/observable.js';
import { ChatInteractivity, SessionStatus, type IChat, type IChatMessage, type ISession } from '../../src/sessions/services/sessions/common/session.js';
import { SessionsManagementService } from '../../src/sessions/services/sessions/browser/sessionsManagementService.js';
import { SessionsProvidersService } from '../../src/sessions/services/sessions/browser/sessionsProvidersService.js';
import type { ISessionChangeEvent, ISessionsProvider } from '../../src/sessions/services/sessions/common/sessionsProvider.js';

function createChat(id: string): IChat {
	return {
		id,
		title: observableValue(id),
		messages: observableValue<readonly IChatMessage[]>([]),
		status: observableValue(SessionStatus.InProgress),
		interactivity: observableValue(ChatInteractivity.Full)
	};
}

function createSession(sessionId: string, providerId: string): ISession {
	const chat = createChat(`${sessionId}-chat`);

	return {
		sessionId,
		providerId,
		sessionType: providerId,
		icon: 'codicon-copilot',
		createdAt: new Date('2026-07-03T00:00:00.000Z'),
		workspace: observableValue(undefined),
		title: observableValue(sessionId),
		updatedAt: observableValue(new Date('2026-07-03T00:00:00.000Z')),
		status: observableValue(SessionStatus.InProgress),
		description: observableValue(undefined),
		changesSummary: observableValue(undefined),
		isArchived: observableValue(false),
		isRead: observableValue(true),
		chats: observableValue([chat]),
		activeChat: observableValue(chat)
	};
}

class TestProvider implements ISessionsProvider {
	readonly onDidChangeSessions;

	private readonly emitter = new Emitter<ISessionChangeEvent>();
	private readonly requests: string[] = [];

	constructor(
		readonly id: string,
		private readonly sessions: readonly ISession[]
	) {
		this.onDidChangeSessions = this.emitter.event;
		this.label = id;
	}

	readonly label: string;
	readonly icon = 'codicon-copilot';
	readonly order = 0;

	getSessions(): readonly ISession[] {
		return this.sessions;
	}

	async sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession> {
		this.requests.push(`${sessionId}:${chatId}:${query}`);
		return this.sessions[0]!;
	}

	get sentRequests(): readonly string[] {
		return this.requests;
	}
}

test('registered provider sessions are aggregated', () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	assert.deepEqual(management.getSessions().map(session => session.sessionId), ['session-a', 'session-b']);
});

test('sendRequest routes to the provider that owns the session', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	await management.sendRequest('session-b', 'chat-1', 'hello');

	assert.deepEqual(first.sentRequests, []);
	assert.deepEqual(second.sentRequests, ['session-b:chat-1:hello']);
});

test('duplicate provider id throws', () => {
	const providers = new SessionsProvidersService();

	providers.registerProvider(new TestProvider('provider-a', [createSession('session-a', 'provider-a')]));

	assert.throws(() => providers.registerProvider(new TestProvider('provider-a', [createSession('session-b', 'provider-a')])));
});
