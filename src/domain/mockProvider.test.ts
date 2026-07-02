import { createMockAgentProvider } from './mockProvider';
import { seedFileChangesBySessionId, seedFilesBySessionId } from './mockData';

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
	const sessionUpdates = [];

	for await (const event of provider.sendMessage(sessions[0].id, { text: 'hello' })) {
		events.push(event.type);
		if (event.type === 'session.updated') {
			sessionUpdates.push(event);
		}
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
	expect(sessionUpdates).toEqual([
		expect.objectContaining({
			type: 'session.updated',
			sessionId: sessions[0].id,
			turnId: 'turn-1',
			session: expect.objectContaining({
				id: sessions[0].id,
				status: 'running'
			})
		}),
		expect.objectContaining({
			type: 'session.updated',
			sessionId: sessions[0].id,
			turnId: 'turn-1',
			session: expect.objectContaining({
				id: sessions[0].id,
				status: 'completed'
			})
		})
	]);
});

test('cancelTurn resolves for known in-flight turn ids', async () => {
	const provider = createMockAgentProvider({ chunkDelayMs: 0 });
	const sessions = await provider.listSessions();
	const iterator = provider.sendMessage(sessions[0].id, { text: 'cancel me' })[Symbol.asyncIterator]();
	const first = await iterator.next();

	expect(first.value.type).toBe('message.created');
	await expect(provider.cancelTurn(sessions[0].id, first.value.turnId)).resolves.toBeUndefined();

	const events = [];
	while (true) {
		const nextEvent = await iterator.next();
		if (nextEvent.done) {
			break;
		}
		events.push(nextEvent.value.type);
	}

	expect(events).toEqual(['session.updated', 'tool.pending']);
});

test('createSession does not mutate shared seed fixtures', async () => {
	const seedFileChangesFixture = JSON.parse(JSON.stringify(seedFileChangesBySessionId));
	const seedFilesFixture = JSON.parse(JSON.stringify(seedFilesBySessionId));
	const provider = createMockAgentProvider({ chunkDelayMs: 0 });

	await provider.createSession({ title: 'Fresh session' });

	expect(seedFileChangesBySessionId).toEqual(seedFileChangesFixture);
	expect(seedFilesBySessionId).toEqual(seedFilesFixture);
});
