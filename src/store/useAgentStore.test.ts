import { act } from '@testing-library/react';
import { createMockAgentProvider } from '../domain/mockProvider';
import type { AgentProvider, AgentSession, ChatMessage, FileChange, SessionFile } from '../domain/types';
import { createAgentStore, resetAgentStoreForTests, useAgentStore } from './useAgentStore';

test('initializes sessions and selects the first session', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));

	await act(async () => {
		await store.getState().initialize();
	});

	expect(store.getState().sessionOrder).toEqual(['session-auth', 'session-build', 'session-release']);
	expect(store.getState().activeSessionId).toBe('session-auth');
});

test('creates and selects a new session', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));
	await act(async () => {
		await store.getState().initialize();
		await store.getState().createSession();
	});

	expect(store.getState().activeSessionId).toBe('session-new-4');
	expect(store.getState().sessionsById['session-new-4'].title).toBe('New Session 4');
});

test('sends a message and applies streaming provider events', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));
	await act(async () => {
		await store.getState().initialize();
		store.getState().setDraft('session-auth', 'hello');
		await store.getState().sendMessage('session-auth');
	});

	const state = store.getState();
	const messages = state.messagesBySessionId['session-auth'];
	expect(messages.at(-2)?.role).toBe('user');
	expect(messages.at(-1)?.role).toBe('assistant');
	expect(messages.at(-1)?.streaming).toBe(false);
	expect(state.sessionsById['session-auth'].status).toBe('completed');
	expect(state.draftsBySessionId['session-auth']).toBe('');
	expect(state.toolCallsBySessionId['session-auth']).toHaveLength(1);
});

test('marks a failed turn as failed and clears in-flight state', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));
	await act(async () => {
		await store.getState().initialize();
		store.getState().setDraft('session-auth', '/fail');
		await store.getState().sendMessage('session-auth');
	});

	const state = store.getState();
	const messages = state.messagesBySessionId['session-auth'];
	expect(messages.at(-1)).toMatchObject({
		role: 'assistant',
		content: 'The mock provider failed this turn on request.',
		streaming: false,
		failed: true
	});
	expect(state.sessionsById['session-auth'].status).toBe('failed');
	expect(state.inFlightTurnsBySessionId['session-auth']).toBeUndefined();
	expect(state.toolCallsBySessionId['session-auth'] ?? []).toHaveLength(0);
});

test('resetAgentStoreForTests restores createSession to a fresh provider', async () => {
	resetAgentStoreForTests();
	const store = useAgentStore;
	await act(async () => {
		await store.getState().initialize();
		await store.getState().createSession();
	});
	expect(store.getState().activeSessionId).toBe('session-new-4');
	expect(store.getState().sessionsById['session-new-4'].title).toBe('New Session 4');

	resetAgentStoreForTests();
	await act(async () => {
		await store.getState().initialize();
		await store.getState().createSession();
	});
	expect(store.getState().activeSessionId).toBe('session-new-4');
	expect(store.getState().sessionsById['session-new-4'].title).toBe('New Session 4');
});

test('initialize() resets stale tool calls, drafts, and in-flight turns', async () => {
	resetAgentStoreForTests();
	const store = useAgentStore;
	store.setState({
		toolCallsBySessionId: {
			'session-auth': [
				{
					id: 'tool-stale',
					sessionId: 'session-auth',
					turnId: 'turn-stale',
					title: 'Stale Tool',
					description: 'Leftover state',
					status: 'pending'
				}
			]
		},
		draftsBySessionId: {
			'session-auth': 'stale draft'
		},
		inFlightTurnsBySessionId: {
			'session-auth': 'turn-stale'
		}
	});

	await act(async () => {
		await store.getState().initialize();
	});

	expect(store.getState().toolCallsBySessionId).toEqual({});
	expect(store.getState().draftsBySessionId).toEqual({});
	expect(store.getState().inFlightTurnsBySessionId).toEqual({});
});

test('initialize() hydrates provider snapshots instead of seed fixtures', async () => {
	const snapshotMessages: ChatMessage[] = [
		{
			id: 'msg-provider-1',
			sessionId: 'session-provider',
			turnId: 'turn-provider-1',
			role: 'assistant',
			content: 'Loaded from provider snapshot',
			createdAt: '2026-07-02T00:00:00.000Z'
		}
	];
	const snapshotFileChanges: FileChange[] = [
		{
			id: 'change-provider-1',
			sessionId: 'session-provider',
			path: 'provider-only.ts',
			status: 'added',
			additions: 7,
			deletions: 0
		}
	];
	const snapshotFiles: SessionFile[] = [
		{
			id: 'file-provider-1',
			sessionId: 'session-provider',
			path: 'provider-only.ts',
			type: 'file',
			depth: 0
		}
	];
	const session: AgentSession = {
		id: 'session-provider',
		title: 'Provider Snapshot Session',
		providerName: 'Custom Provider',
		status: 'idle',
		workspaceLabel: 'provider-workspace',
		updatedAt: '2026-07-02T00:00:00.000Z',
		pinned: false,
		unread: false,
		archived: false
	};
	const provider: AgentProvider = {
		async listSessions() {
			return [session];
		},
		async getSessionSnapshot(sessionId) {
			expect(sessionId).toBe('session-provider');
			return {
				messages: snapshotMessages,
				fileChanges: snapshotFileChanges,
				files: snapshotFiles
			};
		},
		async createSession() {
			return session;
		},
		sendMessage(): AsyncIterable<never> {
			throw new Error('not implemented');
		},
		async cancelTurn() {}
	};
	const store = createAgentStore(provider);

	await act(async () => {
		await store.getState().initialize();
	});

	expect(store.getState().messagesBySessionId).toEqual({
		'session-provider': snapshotMessages
	});
	expect(store.getState().fileChangesBySessionId).toEqual({
		'session-provider': snapshotFileChanges
	});
	expect(store.getState().filesBySessionId).toEqual({
		'session-provider': snapshotFiles
	});
	expect(store.getState().messagesBySessionId['session-auth']).toBeUndefined();
	expect(store.getState().fileChangesBySessionId['session-auth']).toBeUndefined();
	expect(store.getState().filesBySessionId['session-auth']).toBeUndefined();
});

test('ignores late events for a canceled turn', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));
	await act(async () => {
		await store.getState().initialize();
	});

	store.setState(state => ({
		sessionsById: {
			...state.sessionsById,
			'session-auth': {
				...state.sessionsById['session-auth'],
				status: 'running'
			}
		},
		messagesBySessionId: {
			...state.messagesBySessionId,
			'session-auth': [
				...(state.messagesBySessionId['session-auth'] ?? []),
				{
					id: 'msg-canceled',
					sessionId: 'session-auth',
					turnId: 'turn-canceled',
					role: 'assistant',
					content: 'partial',
					createdAt: '2026-07-02T00:00:00.000Z',
					streaming: true
				}
			]
		},
		toolCallsBySessionId: {
			...state.toolCallsBySessionId,
			'session-auth': [
				{
					id: 'tool-canceled',
					sessionId: 'session-auth',
					turnId: 'turn-canceled',
					title: 'Inspect Mock Workspace',
					description: 'Late events should be ignored',
					status: 'pending'
				}
			]
		},
		inFlightTurnsBySessionId: {
			...state.inFlightTurnsBySessionId,
			'session-auth': 'turn-canceled'
		}
	}));

	await act(async () => {
		await store.getState().cancelTurn('session-auth');
	});

	act(() => {
		store.getState().applyEvent({
			type: 'message.delta',
			sessionId: 'session-auth',
			turnId: 'turn-canceled',
			messageId: 'msg-canceled',
			delta: ' should not land'
		});
		store.getState().applyEvent({
			type: 'tool.pending',
			sessionId: 'session-auth',
			turnId: 'turn-canceled',
			toolCall: {
				id: 'tool-late',
				sessionId: 'session-auth',
				turnId: 'turn-canceled',
				title: 'Late Tool',
				description: 'Should be ignored',
				status: 'pending'
			}
		});
		store.getState().applyEvent({
			type: 'tool.completed',
			sessionId: 'session-auth',
			turnId: 'turn-canceled',
			toolCallId: 'tool-canceled'
		});
		store.getState().applyEvent({
			type: 'message.completed',
			sessionId: 'session-auth',
			turnId: 'turn-canceled',
			messageId: 'msg-canceled'
		});
		store.getState().applyEvent({
			type: 'session.updated',
			sessionId: 'session-auth',
			session: {
				...store.getState().sessionsById['session-auth'],
				status: 'running'
			}
		});
	});

	expect(store.getState()).toMatchObject({
		sessionsById: {
			'session-auth': {
				status: 'idle'
			}
		},
		inFlightTurnsBySessionId: {}
	});
	expect(store.getState().messagesBySessionId['session-auth']).toContainEqual(
		expect.objectContaining({
			id: 'msg-canceled',
			content: 'partial',
			streaming: false
		})
	);
	expect(store.getState().toolCallsBySessionId['session-auth']).toEqual([
		expect.objectContaining({
			id: 'tool-canceled',
			status: 'failed'
		})
	]);
});

test('ignores late turn-scoped session updates from a canceled turn after the next turn starts', async () => {
	const store = createAgentStore(createMockAgentProvider({ chunkDelayMs: 0 }));
	await act(async () => {
		await store.getState().initialize();
	});

	store.setState(state => ({
		sessionsById: {
			...state.sessionsById,
			'session-auth': {
				...state.sessionsById['session-auth'],
				status: 'running',
				updatedAt: '2026-07-02T00:00:00.000Z'
			}
		},
		messagesBySessionId: {
			...state.messagesBySessionId,
			'session-auth': [
				...(state.messagesBySessionId['session-auth'] ?? []),
				{
					id: 'msg-turn-a',
					sessionId: 'session-auth',
					turnId: 'turn-a',
					role: 'assistant',
					content: 'partial from A',
					createdAt: '2026-07-02T00:00:00.000Z',
					streaming: true
				}
			]
		},
		inFlightTurnsBySessionId: {
			...state.inFlightTurnsBySessionId,
			'session-auth': 'turn-a'
		}
	}));

	await act(async () => {
		await store.getState().cancelTurn('session-auth');
	});

	act(() => {
		store.getState().applyEvent({
			type: 'message.created',
			sessionId: 'session-auth',
			turnId: 'turn-b',
			message: {
				id: 'msg-turn-b',
				sessionId: 'session-auth',
				turnId: 'turn-b',
				role: 'assistant',
				content: '',
				createdAt: '2026-07-02T00:00:02.000Z',
				streaming: true
			}
		});
		store.getState().applyEvent({
			type: 'session.updated',
			sessionId: 'session-auth',
			turnId: 'turn-b',
			session: {
				...store.getState().sessionsById['session-auth'],
				status: 'running',
				updatedAt: '2026-07-02T00:00:02.000Z'
			}
		});
		store.getState().applyEvent({
			type: 'session.updated',
			sessionId: 'session-auth',
			turnId: 'turn-a',
			session: {
				...store.getState().sessionsById['session-auth'],
				status: 'running',
				updatedAt: '2026-07-02T00:00:01.000Z'
			}
		});
	});

	expect(store.getState()).toMatchObject({
		sessionsById: {
			'session-auth': {
				status: 'running',
				updatedAt: '2026-07-02T00:00:02.000Z'
			}
		},
		inFlightTurnsBySessionId: {
			'session-auth': 'turn-b'
		}
	});
	expect(store.getState().messagesBySessionId['session-auth']).toContainEqual(
		expect.objectContaining({
			id: 'msg-turn-b',
			turnId: 'turn-b',
			streaming: true
		})
	);
});
