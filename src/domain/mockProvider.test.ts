import { createMockAgentProvider } from './mockProvider';

test('lists deterministic seed sessions', async () => {
	const provider = createMockAgentProvider({ chunkDelayMs: 0 });

	const sessions = await provider.listSessions();

	expect(sessions.map(session => session.title)).toEqual([
		'Refactor Auth Flow',
		'Investigate Build Failure',
		'Draft Release Notes'
	]);
});

test('streams message and tool events in deterministic order', async () => {
	const provider = createMockAgentProvider({ chunkDelayMs: 0 });
	const sessions = await provider.listSessions();
	const events = [];

	for await (const event of provider.sendMessage(sessions[0].id, { text: 'hello' })) {
		events.push(event.type);
	}

	expect(events).toEqual([
		'message.created',
		'session.updated',
		'tool.pending',
		'message.delta',
		'message.delta',
		'message.delta',
		'tool.completed',
		'message.completed',
		'session.updated'
	]);
});

test('cancelTurn resolves for known in-flight turn ids', async () => {
	const provider = createMockAgentProvider({ chunkDelayMs: 0 });
	const sessions = await provider.listSessions();
	const iterator = provider.sendMessage(sessions[0].id, { text: 'cancel me' })[Symbol.asyncIterator]();
	const first = await iterator.next();

	expect(first.value.type).toBe('message.created');
	await expect(provider.cancelTurn(sessions[0].id, first.value.turnId)).resolves.toBeUndefined();
	await iterator.return?.();
});
