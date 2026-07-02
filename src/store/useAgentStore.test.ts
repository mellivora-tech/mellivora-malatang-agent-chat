import { act } from '@testing-library/react';
import { createMockAgentProvider } from '../domain/mockProvider';
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
