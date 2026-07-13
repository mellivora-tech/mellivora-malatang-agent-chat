import test from 'node:test';
import assert from 'node:assert/strict';

import { Emitter } from '../../src/sessions/base/common/event.js';
import { observableValue } from '../../src/sessions/base/common/observable.js';
import { SessionInteractivity, SessionStatus, type ISession, type ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';
import { SessionsManagementService } from '../../src/sessions/services/sessions/browser/sessionsManagementService.js';
import { SessionsPartService } from '../../src/sessions/services/sessions/browser/sessionsPartService.js';
import { SessionsProvidersService } from '../../src/sessions/services/sessions/browser/sessionsProvidersService.js';
import { SessionsService } from '../../src/sessions/services/sessions/browser/sessionsService.js';
import type { ISessionChangeEvent, ISessionsProvider, IStartSessionOptions } from '../../src/sessions/services/sessions/common/sessionsProvider.js';

function createSession(sessionId: string, providerId: string): ISession {
	return {
		sessionId,
		providerId,
		sessionType: providerId,
		icon: 'codicon-copilot',
		createdAt: new Date('2026-07-03T00:00:00.000Z'),
		projectId: undefined,
		workspace: observableValue(undefined),
		title: observableValue(sessionId),
		updatedAt: observableValue(new Date('2026-07-03T00:00:00.000Z')),
		status: observableValue(SessionStatus.InProgress),
		description: observableValue(undefined),
		changesSummary: observableValue(undefined),
		isArchived: observableValue(false),
		isRead: observableValue(true),
		isPinned: observableValue(false),
		messages: observableValue<readonly ISessionMessage[]>([]),
		planComments: observableValue([]),
		interactivity: observableValue(SessionInteractivity.Full),
		pendingApproval: observableValue(undefined),
		reconnect: observableValue(undefined),
		permissionMode: observableValue('ask' as const),
		contextUsage: observableValue(undefined),
	};
}

class TestProvider implements ISessionsProvider {
	readonly onDidChangeSessions;

	private readonly emitter = new Emitter<ISessionChangeEvent>();
	private readonly requests: string[] = [];
	private readonly starts: string[] = [];
	readonly startOptions: (IStartSessionOptions | undefined)[] = [];

	constructor(
		readonly id: string,
		private readonly sessions: ISession[],
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

	async startSession(query: string, options?: IStartSessionOptions): Promise<ISession> {
		const session = createSession(`started-${query}`, this.id);
		this.sessions.push(session);
		this.starts.push(query);
		this.requests.push(`start:${query}`);
		this.startOptions.push(options);
		return session;
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		this.requests.push(`${sessionId}:${query}`);
		return this.sessions[0]!;
	}

	async stopSession(sessionId: string): Promise<ISession> {
		this.requests.push(`stop:${sessionId}`);
		return this.sessions[0]!;
	}

	async setSessionPermissionMode(sessionId: string): Promise<ISession> {
		this.requests.push(`mode:${sessionId}`);
		return this.sessions[0]!;
	}

	async setMessageFeedback(sessionId: string): Promise<ISession> {
		this.requests.push(`feedback:${sessionId}`);
		return this.sessions[0]!;
	}

	async setPlanState(sessionId: string): Promise<ISession> {
		this.requests.push(`planState:${sessionId}`);
		return this.sessions[0]!;
	}

	async setPlanComment(sessionId: string): Promise<ISession> {
		this.requests.push(`planComment:${sessionId}`);
		return this.sessions[0]!;
	}

	async forkSession(sessionId: string): Promise<ISession> {
		this.requests.push(`fork:${sessionId}`);
		return this.sessions[0]!;
	}

	async renameSession(sessionId: string, title: string): Promise<ISession> {
		this.requests.push(`rename:${sessionId}:${title}`);
		return this.sessions[0]!;
	}

	async setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession> {
		this.requests.push(`pin:${sessionId}:${isPinned}`);
		return this.sessions[0]!;
	}

	async setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession> {
		this.requests.push(`archive:${sessionId}:${isArchived}`);
		return this.sessions[0]!;
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.requests.push(`delete:${sessionId}`);
	}

	get sentRequests(): readonly string[] {
		return this.requests;
	}

	get startedQueries(): readonly string[] {
		return this.starts;
	}
}

test('registered provider sessions are aggregated', () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	assert.deepEqual(
		management.getSessions().map(session => session.sessionId),
		['session-a', 'session-b'],
	);
});

test('sendMessage routes to the provider that owns the session', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	await management.sendMessage('session-b', 'hello');

	assert.deepEqual(first.sentRequests, []);
	assert.deepEqual(second.sentRequests, ['session-b:hello']);
});

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

test('setSessionPinned and setSessionArchived route to the owning provider', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	await management.setSessionPinned('session-b', true);
	await management.setSessionArchived('session-b', true);
	await management.deleteSession('session-b');

	assert.deepEqual(first.sentRequests, []);
	assert.deepEqual(second.sentRequests, ['pin:session-b:true', 'archive:session-b:true', 'delete:session-b']);
});

test('startSession delegates to the first registered provider', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const first = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);
	const second = new TestProvider('provider-b', [createSession('session-b', 'provider-b')]);

	providers.registerProvider(first);
	providers.registerProvider(second);

	const session = await management.startSession('hello');

	assert.equal(session.sessionId, 'started-hello');
	assert.deepEqual(first.startedQueries, ['hello']);
	assert.deepEqual(second.startedQueries, []);
});

test('startSession forwards options to the provider', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);
	const provider = new TestProvider('provider-a', [createSession('session-a', 'provider-a')]);

	providers.registerProvider(provider);

	const workspace = { label: 'Seeded Project', description: '/tmp/seeded' };
	await management.startSession('hello', { workspace });

	assert.deepEqual(provider.startOptions, [{ workspace }]);
});

test('startSession throws when no provider is registered', async () => {
	const providers = new SessionsProvidersService();
	const management = new SessionsManagementService(providers);

	await assert.rejects(() => management.startSession('hello'), /No sessions provider is registered/);
});

test('duplicate provider id throws', () => {
	const providers = new SessionsProvidersService();

	providers.registerProvider(new TestProvider('provider-a', [createSession('session-a', 'provider-a')]));

	assert.throws(() => providers.registerProvider(new TestProvider('provider-a', [createSession('session-b', 'provider-a')])));
});

test('sessions service starts a session and marks it active', async () => {
	const providersService = new SessionsProvidersService();
	const management = new SessionsManagementService(providersService);
	const sessionsPartService = new SessionsPartService();
	const sessionsService = new SessionsService(management, sessionsPartService);
	const provider = new TestProvider('test', []);
	providersService.registerProvider(provider);

	const session = await sessionsService.startSession('hello');

	assert.equal(typeof sessionsPartService.showConversation, 'function');
	assert.equal(session.sessionId, 'started-hello');
	assert.equal(sessionsService.activeSession.get()?.sessionId, session.sessionId);
	assert.deepEqual(
		sessionsService.visibleSessions.get().map(candidate => candidate?.sessionId),
		[session.sessionId],
	);
	assert.equal(sessionsPartService.mode.get(), 'conversation');
	assert.equal(
		provider.getSessions().some(candidate => candidate.sessionId === session.sessionId),
		true,
	);
});
