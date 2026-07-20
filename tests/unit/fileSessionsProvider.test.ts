/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { FileSessionsProvider, formatSessionContext, humanizeAgentRunError, toTranscript } from '../../src/sessions/contrib/fileProvider/browser/fileSessionsProvider.js';
import type { ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../src/sessions/services/sessions/common/session.js';
import type { IAgentBridge, IAgentEventPayload } from '../../src/sessions/services/agent/common/agent.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionSnapshot, ISessionsBridge } from '../../src/sessions/services/sessions/common/sessionsBridge.js';

interface IAppendCall {
	readonly ref: ISessionRef;
	readonly entry: ISessionEntry;
}

interface IFakeBridge extends ISessionsBridge {
	readonly creates: ISessionHeader[];
	readonly appends: IAppendCall[];
	readonly deletes: ISessionRef[];
	failAppends: boolean;
	failCreates: boolean;
}

function createFakeBridge(snapshots: readonly ISessionSnapshot[] = []): IFakeBridge {
	const creates: ISessionHeader[] = [];
	const appends: IAppendCall[] = [];
	const deletes: ISessionRef[] = [];
	// A tiny store folding state entries so tests can rehydrate a second
	// provider over the same bridge and observe persisted lifecycle state.
	const store = new Map<string, ISessionSnapshot>(snapshots.map(snapshot => [snapshot.sessionId, snapshot]));
	const bridge: IFakeBridge = {
		creates,
		appends,
		deletes,
		failAppends: false,
		failCreates: false,
		delete: async ref => {
			deletes.push(ref);
			store.delete(ref.sessionId);
		},
		list: async () => [...store.values()],
		create: async header => {
			if (bridge.failCreates) {
				throw new Error('create failed');
			}
			creates.push(header);
			store.set(header.sessionId, {
				sessionId: header.sessionId,
				sessionType: header.sessionType,
				icon: header.icon,
				createdAt: header.createdAt,
				updatedAt: header.createdAt,
				interactivity: header.interactivity,
				title: '',
				status: 2,
				isArchived: false,
				isRead: true,
				isPinned: false,
				messages: [],
				...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
				...(header.workspace !== undefined ? { workspace: header.workspace } : {}),
			});
		},
		append: async (ref, entry) => {
			if (bridge.failAppends) {
				throw new Error('append failed');
			}
			appends.push({ ref, entry });
			const existing = store.get(ref.sessionId);
			if (!existing) {
				return;
			}
			if (entry.type === 'message') {
				store.set(ref.sessionId, {
					...existing,
					messages: [...existing.messages, { id: entry.id, role: entry.role, text: entry.text, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) }],
				});
			} else if (entry.type === 'feedback' || entry.type === 'planState' || entry.type === 'planComment') {
				// Feedback/planState/planComment entries fold onto messages in the real store; the fake keeps them raw.
			} else {
				store.set(ref.sessionId, {
					...existing,
					...(entry.status !== undefined ? { status: entry.status } : {}),
					...(entry.title !== undefined ? { title: entry.title } : {}),
					...(entry.isArchived !== undefined ? { isArchived: entry.isArchived } : {}),
					...(entry.isRead !== undefined ? { isRead: entry.isRead } : {}),
					...(entry.isPinned !== undefined ? { isPinned: entry.isPinned } : {}),
				});
			}
		},
	};
	return bridge;
}

function createSnapshot(sessionId: string, overrides: Partial<ISessionSnapshot> = {}): ISessionSnapshot {
	return {
		sessionId,
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-06T00:00:00.000Z',
		updatedAt: '2026-07-06T01:00:00.000Z',
		interactivity: 'full',
		title: `title-${sessionId}`,
		status: 2,
		isArchived: false,
		isRead: true,
		isPinned: false,
		messages: [{ id: 'm1', role: 'user', text: 'hello' }],
		...overrides,
	};
}

test('initialize hydrates sessions from the bridge snapshots', async () => {
	const bridge = createFakeBridge([
		createSnapshot('s1', { workspace: { label: 'my-app', description: '/tmp/my-app' } }),
		createSnapshot('s2', { interactivity: 'read-only', status: 3 }),
	]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	const events: unknown[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	await provider.initialize();

	const sessions = provider.getSessions();
	assert.equal(sessions.length, 2);
	const first = sessions[0]!;
	assert.equal(first.sessionId, 's1');
	assert.equal(first.title.get(), 'title-s1');
	assert.equal(first.status.get(), SessionStatus.NeedsInput);
	assert.equal(first.interactivity.get(), SessionInteractivity.Full);
	assert.deepEqual(first.workspace.get(), { label: 'my-app', description: '/tmp/my-app' });
	assert.ok(first.createdAt instanceof Date);
	assert.equal(first.createdAt.toISOString(), '2026-07-06T00:00:00.000Z');
	assert.deepEqual(
		first.messages.get().map(message => message.id),
		['m1'],
	);
	assert.equal(sessions[1]!.status.get(), SessionStatus.Completed);
	assert.equal(sessions[1]!.interactivity.get(), SessionInteractivity.ReadOnly);
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], { added: sessions, removed: [], changed: [] });
});

test('initialize hydrates projectId and isPinned onto sessions', async () => {
	const bridge = createFakeBridge([createSnapshot('s1', { projectId: '3f2a8c1d', isPinned: true })]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();

	const session = provider.getSessions()[0]!;
	assert.equal(session.projectId, '3f2a8c1d');
	assert.equal(session.isPinned.get(), true);
});

test('startSession sets projectId on the created session', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const withProject = await provider.startSession('hello', { projectId: '3f2a8c1d' });
	const withoutProject = await provider.startSession('again');

	assert.equal(withProject.projectId, '3f2a8c1d');
	assert.equal(withoutProject.projectId, undefined);
	assert.equal(withProject.isPinned.get(), false);

	await provider.whenIdle();
});

test('initialize coerces a persisted in-progress status to needs-input', async () => {
	const bridge = createFakeBridge([createSnapshot('s1', { status: 1 })]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();

	assert.equal(provider.getSessions()[0]!.status.get(), SessionStatus.NeedsInput);
});

test('initialize is idempotent and session identity is stable', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });

	await provider.initialize();
	const first = provider.getSessions()[0];
	await provider.initialize();

	assert.equal(provider.getSessions().length, 1);
	assert.equal(provider.getSessions()[0], first);
});

test('startSession persists header, user message, and initial state in order', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello world');

	assert.equal(bridge.creates.length, 1);
	const header = bridge.creates[0]!;
	assert.equal(header.type, 'session');
	assert.equal(header.sessionId, session.sessionId);
	assert.equal(header.projectId, undefined);

	assert.equal(bridge.appends.length, 2);
	const [message, state] = bridge.appends;
	assert.equal(message!.entry.type, 'message');
	assert.deepEqual(message!.ref, { sessionId: session.sessionId });
	assert.equal((message!.entry as { text: string }).text, 'hello world');
	assert.equal(state!.entry.type, 'state');
	const stateEntry = state!.entry as { status?: number; title?: string; isRead?: boolean; changesSummary?: object };
	assert.equal(stateEntry.status, SessionStatus.InProgress);
	assert.equal(stateEntry.title, 'hello world');
	assert.equal(stateEntry.isRead, false);
	// The initial state carries no changes summary — real stats come from git later.
	assert.equal(stateEntry.changesSummary, undefined);

	assert.equal(session.status.get(), SessionStatus.InProgress);
	assert.equal(provider.getSessions()[0], session);

	await provider.whenIdle();
});

test('startSession routes project sessions via the projectId option', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello', { projectId: '3f2a8c1d', workspace: { label: 'my-app', description: '/tmp/my-app' } });

	assert.equal(bridge.creates[0]!.projectId, '3f2a8c1d');
	assert.deepEqual(bridge.creates[0]!.workspace, { label: 'my-app', description: '/tmp/my-app' });
	assert.deepEqual(bridge.appends[0]!.ref, { sessionId: session.sessionId, projectId: '3f2a8c1d' });
	assert.deepEqual(session.workspace.get(), { label: 'my-app', description: '/tmp/my-app' });

	await provider.whenIdle();
});

test('the no-model reply prompts the user to configure a model', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello', 'No model is configured yet, so I can’t answer. Add a model in Settings › Models, then send your message again.'],
	);
	const entries = bridge.appends.map(call => call.entry);
	const assistant = entries.find(entry => entry.type === 'message' && entry.role === 'assistant');
	assert.ok(assistant);
	assert.equal((assistant as { text: string }).text, 'No model is configured yet, so I can’t answer. Add a model in Settings › Models, then send your message again.');
	const lastState = [...entries].reverse().find(entry => entry.type === 'state') as { status?: number };
	assert.equal(lastState.status, SessionStatus.NeedsInput);
});

test('sendMessage persists the follow-up turn before the reply', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.whenIdle();
	const appendCountBefore = bridge.appends.length;

	await provider.sendMessage(session.sessionId, 'follow up');

	const newEntries = bridge.appends.slice(appendCountBefore).map(call => call.entry);
	assert.equal(newEntries[0]?.type, 'message');
	assert.equal((newEntries[0] as { text: string }).text, 'follow up');
	assert.equal(newEntries[1]?.type, 'state');
	assert.equal((newEntries[1] as { status?: number }).status, SessionStatus.InProgress);

	await provider.whenIdle();
	assert.equal(session.status.get(), SessionStatus.NeedsInput);
});

test('stopSession cancels the pending reply and persists needs-input', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 60_000 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	assert.equal(session.status.get(), SessionStatus.InProgress);

	await provider.stopSession(session.sessionId);

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; status?: number };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.status, SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello'],
	);

	await provider.whenIdle();
});

test('setSessionPinned persists a pinned state entry and updates the observable', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const events: unknown[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	const session = await provider.setSessionPinned('s1', true);

	assert.equal(session.isPinned.get(), true);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; isPinned?: boolean };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.isPinned, true);
	assert.deepEqual(events, [{ added: [], removed: [], changed: [session] }]);
});

test('setSessionArchived persists an archived state entry', async () => {
	const bridge = createFakeBridge([createSnapshot('s1')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	const session = await provider.setSessionArchived('s1', true);

	assert.equal(session.isArchived.get(), true);
	const lastEntry = bridge.appends.at(-1)!.entry as { type: string; isArchived?: boolean };
	assert.equal(lastEntry.type, 'state');
	assert.equal(lastEntry.isArchived, true);
});

test('pin and archive round-trip through a rehydrated provider', async () => {
	const bridge = createFakeBridge([createSnapshot('s1'), createSnapshot('s2')]);
	const first = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await first.initialize();
	await first.setSessionPinned('s1', true);
	await first.setSessionArchived('s2', true);

	const second = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await second.initialize();

	const sessions = second.getSessions();
	assert.equal(sessions.find(session => session.sessionId === 's1')?.isPinned.get(), true);
	assert.equal(sessions.find(session => session.sessionId === 's2')?.isArchived.get(), true);
});

test('deleteSession removes the session, calls bridge.delete, and fires removed', async () => {
	const bridge = createFakeBridge([createSnapshot('s1'), createSnapshot('s2')]);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const events: { removed: readonly { sessionId: string }[] }[] = [];
	provider.onDidChangeSessions(event => events.push(event));

	await provider.deleteSession('s1');

	assert.deepEqual(
		provider.getSessions().map(session => session.sessionId),
		['s2'],
	);
	assert.deepEqual(bridge.deletes, [{ sessionId: 's1' }]);
	assert.equal(events.length, 1);
	assert.deepEqual(
		events[0]!.removed.map(session => session.sessionId),
		['s1'],
	);
});

test('deleteSession cancels a pending reply', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 60_000 });
	await provider.initialize();

	const session = await provider.startSession('hello');
	await provider.deleteSession(session.sessionId);

	// whenIdle resolves immediately because the pending reply was cancelled.
	await provider.whenIdle();
	assert.equal(provider.getSessions().length, 0);
});

test('startSession rejects when the bridge create fails', async () => {
	const bridge = createFakeBridge();
	bridge.failCreates = true;
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();

	await assert.rejects(() => provider.startSession('hello'), /create failed/);
	assert.equal(provider.getSessions().length, 0);
});

test('reply append failures are logged without breaking the session', async t => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const errorSpy = t.mock.method(console, 'error', () => undefined);

	const session = await provider.startSession('hello');
	bridge.failAppends = true;
	await provider.whenIdle();

	assert.equal(session.status.get(), SessionStatus.NeedsInput);
	assert.deepEqual(
		session.messages.get().map(message => message.text),
		['hello', 'No model is configured yet, so I can’t answer. Add a model in Settings › Models, then send your message again.'],
	);
	assert.ok(errorSpy.mock.callCount() >= 1);
});

test('agent runs assemble a work block with tool steps and persist it', async () => {
	const bridge = createFakeBridge();

	// A scripted agent bridge: capture the event listener, drive one run.
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	let runSessionId = '';
	const agent: IAgentBridge = {
		run: async sessionId => {
			runSessionId = sessionId;
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'thinking_delta', text: '先看一下文件结构' } });
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'read_file', input: { path: 'src/a.ts' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false } });
			emit({ event: { type: 'assistant_delta', text: 'Hello' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};

	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();

	const session = await provider.startSession('do something');
	// The scripted run is synchronous but fires through microtasks; yield twice.
	await new Promise(resolve => setTimeout(resolve, 10));

	assert.equal(runSessionId, session.sessionId);
	const messages = session.messages.get();
	const work = messages.find(message => message.role === 'work');
	assert.ok(work, 'a work message exists');
	assert.ok(typeof work.durationMs === 'number', 'work block settled with a total duration');
	const toolSteps = (work.steps ?? []).filter(step => step.kind === 'tool');
	assert.deepEqual(
		toolSteps.map(step => step.label),
		['read_file src/a.ts'],
	);
	const thinkingSteps = (work.steps ?? []).filter(step => step.kind === 'thinking');
	assert.ok(
		thinkingSteps.some(step => step.detail?.includes('先看一下文件结构')),
		'streamed reasoning lands on the thinking step detail',
	);
	assert.ok(messages.indexOf(work) < messages.findIndex(message => message.role === 'assistant'), 'work block precedes the reply');
	assert.equal(messages.find(message => message.role === 'assistant')?.text, 'Hello');

	const persistedWork = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'work');
	assert.ok(persistedWork, 'work entry persisted');
	assert.ok(((persistedWork.entry as { steps?: readonly unknown[] }).steps?.length ?? 0) >= 2, 'persisted steps include thinking and tool');
});

test('a work_digest event materializes a hidden digest message, persisted after the reply', async () => {
	const bridge = createFakeBridge();

	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'read_file', input: { path: 'src/a.ts' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false } });
			emit({ event: { type: 'assistant_delta', text: 'Done' } });
			emit({ event: { type: 'work_digest', text: '<work-digest>Read: src/a.ts</work-digest>', filesRead: 1, filesWritten: 0, toolCalls: 1 } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};

	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();

	const session = await provider.startSession('do something');
	await new Promise(resolve => setTimeout(resolve, 10));

	const messages = session.messages.get();
	const digest = messages.find(message => message.role === 'digest');
	assert.ok(digest, 'a hidden digest message was added to the session');
	assert.equal(digest.text, '<work-digest>Read: src/a.ts</work-digest>');
	assert.ok(messages.findIndex(m => m.role === 'assistant') < messages.indexOf(digest), 'the digest trails the reply');

	// Persisted as a digest entry, after the assistant reply on disk.
	const entryRoles = bridge.appends.filter(call => call.entry.type === 'message').map(call => (call.entry as { role: string }).role);
	assert.ok(entryRoles.includes('digest'), 'digest entry persisted');
	assert.ok(entryRoles.indexOf('assistant') < entryRoles.indexOf('digest'), 'digest persisted after the reply');

	// The next run's transcript carries the digest as an assistant turn.
	const transcript = toTranscript(session.messages.get());
	assert.ok(
		transcript.some(m => m.role === 'assistant' && (m.content[0] as { text?: string }).text === '<work-digest>Read: src/a.ts</work-digest>'),
		'digest rides the transcript for the next run',
	);
});

test('propose_plan materializes a plan card; a new version supersedes the old; setPlanState persists', async () => {
	const bridge = createFakeBridge();
	const PLAN_INPUT = {
		title: 'SSH sudo 支持',
		sections: [{ kind: 'files', heading: '改动文件', items: ['sshTool.ts'] }],
	};

	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			// Two calls in one run — the LAST one wins.
			emit({ event: { type: 'tool_use', toolUseId: 'p0', name: 'propose_plan', input: { title: 'draft-discarded', sections: PLAN_INPUT.sections } } });
			emit({ event: { type: 'tool_result', toolUseId: 'p0', content: 'ok', isError: false } });
			emit({ event: { type: 'tool_use', toolUseId: 'p1', name: 'propose_plan', input: PLAN_INPUT } });
			emit({ event: { type: 'tool_result', toolUseId: 'p1', content: 'ok', isError: false } });
			emit({ event: { type: 'assistant_delta', text: '请评审。' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('出方案');
	await new Promise(resolve => setTimeout(resolve, 10));

	// Run 1: one plan message, v1 draft, from the LAST propose_plan call.
	const afterV1 = session.messages.get().filter(message => message.role === 'plan');
	assert.equal(afterV1.length, 1);
	assert.equal(afterV1[0]?.plan?.version, 1);
	assert.equal(afterV1[0]?.plan?.state, 'draft');
	assert.equal(afterV1[0]?.plan?.title, 'SSH sudo 支持', 'last call of the run wins');
	assert.equal(afterV1[0]?.plan?.sections[0]?.id, `${afterV1[0]?.id}-s0`, 'deterministic section ids');
	const planIndex = session.messages.get().findIndex(message => message.role === 'plan');
	const assistantIndex = session.messages.get().findIndex(message => message.role === 'assistant');
	assert.ok(planIndex < assistantIndex, 'plan card precedes the reply');

	// Run 2: the new version retires v1 — live view and persisted overlay alike.
	await provider.sendMessage(session.sessionId, '改一下');
	await new Promise(resolve => setTimeout(resolve, 10));
	const plans = session.messages.get().filter(message => message.role === 'plan');
	assert.equal(plans.length, 2);
	assert.equal(plans[0]?.plan?.state, 'superseded');
	assert.equal(plans[1]?.plan?.version, 2);
	assert.equal(plans[1]?.plan?.state, 'draft');
	const supersedeEntry = bridge.appends.find(call => call.entry.type === 'planState' && call.entry.messageId === plans[0]?.id);
	assert.ok(supersedeEntry, 'superseded overlay persisted');

	// Approve: live flip + planState entry.
	await provider.setPlanState(session.sessionId, plans[1]!.id, 'approved');
	assert.equal(
		session.messages
			.get()
			.filter(message => message.role === 'plan')
			.at(-1)?.plan?.state,
		'approved',
	);
	const approveEntry = bridge.appends.find(call => call.entry.type === 'planState' && call.entry.messageId === plans[1]?.id && call.entry.planState === 'approved');
	assert.ok(approveEntry, 'approved overlay persisted');

	// Comments: upsert by id — add, then resolve the same id.
	const comment = { id: 'c1', planId: plans[1]!.plan!.id, sectionId: `${plans[1]!.id}-s0`, body: '别在 prod 开 sudo', resolved: false, createdAt: new Date() };
	await provider.setPlanComment(session.sessionId, comment);
	assert.equal(session.planComments.get().length, 1);
	await provider.setPlanComment(session.sessionId, { ...comment, resolved: true });
	assert.equal(session.planComments.get().length, 1, 'same id upserts in place');
	assert.equal(session.planComments.get()[0]?.resolved, true);
	const commentEntries = bridge.appends.filter(call => call.entry.type === 'planComment');
	assert.equal(commentEntries.length, 2, 'both writes persisted as entries');
});

test('write_walkthrough materializes a settled walkthrough card and does NOT supersede the plan', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	let runCount = 0;
	const agent: IAgentBridge = {
		run: async sessionId => {
			runCount += 1;
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			if (runCount === 1) {
				emit({ event: { type: 'tool_use', toolUseId: 'p1', name: 'propose_plan', input: { title: '方案', sections: [{ kind: 'overview', heading: '概述', body: 'x' }] } } });
				emit({ event: { type: 'tool_result', toolUseId: 'p1', content: 'ok', isError: false } });
			} else {
				emit({
					event: {
						type: 'tool_use',
						toolUseId: 'w1',
						name: 'write_walkthrough',
						input: { title: '完成了', sections: [{ kind: 'verify', heading: '如何验证', items: ['npm test'] }] },
					},
				});
				emit({ event: { type: 'tool_result', toolUseId: 'w1', content: 'ok', isError: false } });
			}
			emit({ event: { type: 'assistant_delta', text: '好。' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('出方案');
	await new Promise(resolve => setTimeout(resolve, 10));
	await provider.sendMessage(session.sessionId, '执行吧');
	await new Promise(resolve => setTimeout(resolve, 10));

	const artifacts = session.messages.get().filter(message => message.role === 'plan');
	assert.equal(artifacts.length, 2);
	const plan = artifacts.find(message => (message.plan?.kind ?? 'plan') === 'plan');
	const walkthrough = artifacts.find(message => message.plan?.kind === 'walkthrough');
	assert.ok(plan && walkthrough);
	assert.equal(plan.plan?.state, 'draft', 'the walkthrough must not supersede the plan');
	assert.equal(walkthrough.plan?.state, 'approved', 'a walkthrough lands settled');
	assert.equal(walkthrough.plan?.version, 1, 'walkthrough versions count separately');
	assert.equal(bridge.appends.filter(call => call.entry.type === 'planState').length, 0, 'no supersede overlays written');
});

test('a run that ends at the step limit with no text shows a note, not a blank bubble', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		// Tool-only run that never produces assistant text, then hits max_turns.
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'list_dir', input: { path: '.' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'src', isError: false } });
			emit({ done: { reason: 'max_turns', turns: 50 } });
			return { reason: 'max_turns', turns: 50 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('do something');
	await new Promise(resolve => setTimeout(resolve, 10));

	const assistant = session.messages.get().find(message => message.role === 'assistant');
	assert.ok(assistant, 'a reply message exists');
	assert.notEqual(assistant.text, '', 'the reply is not a blank bubble');
	assert.match(assistant.text, /step limit/i, 'it explains the run hit the step limit');

	// And no empty assistant message was persisted.
	const persistedAssistants = bridge.appends.filter(call => call.entry.type === 'message' && call.entry.role === 'assistant');
	assert.ok(
		persistedAssistants.every(call => (call.entry as { text: string }).text !== ''),
		'no blank assistant entry persisted',
	);
});

test('a reply_verifier fail replaces the rejected reply with the retry instead of appending', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'assistant_delta', text: 'off-topic first attempt' } });
			emit({ event: { type: 'reply_verifier', verdict: 'fail', retried: true, reason: 'wrong topic' } });
			emit({ event: { type: 'assistant_delta', text: 'the real answer' } });
			emit({ done: { reason: 'completed', turns: 2 } });
			return { reason: 'completed', turns: 2 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('do something');
	await new Promise(resolve => setTimeout(resolve, 10));

	const assistants = session.messages.get().filter(message => message.role === 'assistant');
	assert.equal(assistants.length, 1, 'a single reply message — the rejected attempt is gone');
	assert.equal(assistants[0]!.text, 'the real answer', 'the retry replaced the rejected text, no concatenation');

	// Persistence carries only the surviving reply.
	const persisted = bridge.appends.filter(call => call.entry.type === 'message' && call.entry.role === 'assistant');
	assert.equal(persisted.length, 1);
	assert.equal((persisted[0]!.entry as { text: string }).text, 'the real answer');
});

test('a run truncated by the output token budget with no text shows a note, not silence', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		// Thinking consumed the whole max_tokens budget — the stream ends without
		// a single assistant_delta having fired.
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'thinking_delta', text: 'reasoning that never converged…' } });
			emit({ done: { reason: 'max_output_tokens', turns: 1 } });
			return { reason: 'max_output_tokens', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('do something');
	await new Promise(resolve => setTimeout(resolve, 10));

	const assistant = session.messages.get().find(message => message.role === 'assistant');
	assert.ok(assistant, 'a reply message exists');
	assert.match(assistant.text, /output token limit/i, 'it explains the reply was cut off by the token budget');
});

test('toTranscript drops empty and non-conversational messages (400 guard)', () => {
	const messages: ISessionMessage[] = [
		{ id: 'u1', role: 'user', text: 'hello' },
		{ id: 'w1', role: 'work', text: '', durationMs: 10, steps: [] },
		{ id: 'a1', role: 'assistant', text: '' }, // the poison: an empty assistant reply
		{ id: 'u2', role: 'user', text: 'still there?' },
		{ id: 'a2', role: 'assistant', text: 'yes' },
		{ id: 't1', role: 'tool', text: 'tool output' },
	];
	const transcript = toTranscript(messages);
	assert.deepEqual(
		transcript.map(m => ({ role: m.role, text: (m.content[0] as { text: string }).text })),
		[
			{ role: 'user', text: 'hello' },
			{ role: 'user', text: 'still there?' },
			{ role: 'assistant', text: 'yes' },
		],
	);
	// No message with empty content survives — that is exactly what the API rejects.
	assert.ok(transcript.every(m => (m.content[0] as { text: string }).text.trim() !== ''));
});

test('toTranscript carries only the latest work digest, as an assistant turn', () => {
	const messages: ISessionMessage[] = [
		{ id: 'u1', role: 'user', text: 'q1' },
		{ id: 'a1', role: 'assistant', text: 'a1' },
		{ id: 'd1', role: 'digest', text: '<work-digest>Read: a.ts</work-digest>' },
		{ id: 'u2', role: 'user', text: 'q2' },
		{ id: 'a2', role: 'assistant', text: 'a2' },
		{ id: 'd2', role: 'digest', text: '<work-digest>Read: b.ts</work-digest>' },
		{ id: 'u3', role: 'user', text: 'q3' },
	];
	const transcript = toTranscript(messages);
	assert.deepEqual(
		transcript.map(m => ({ role: m.role, text: (m.content[0] as { text: string }).text })),
		[
			{ role: 'user', text: 'q1' },
			{ role: 'assistant', text: 'a1' },
			{ role: 'user', text: 'q2' },
			{ role: 'assistant', text: 'a2' },
			// Only d2 survives; d1 is a stale earlier-run digest.
			{ role: 'assistant', text: '<work-digest>Read: b.ts</work-digest>' },
			{ role: 'user', text: 'q3' },
		],
	);
});

/** Agent stub whose run completes immediately; generateTitle is supplied per test. */
function createTitleAgent(generateTitle: (query: string, modelId?: string) => Promise<string | undefined>): IAgentBridge {
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	return {
		run: async sessionId => {
			listener?.({ sessionId, event: { type: 'assistant_delta', text: 'ok' } } as never);
			listener?.({ sessionId, done: { reason: 'completed', turns: 1 } } as never);
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle,
	};
}

const titleModelsService = {
	registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
	selectedModel: { get: () => ({ id: 'model-1' }) },
} as never;

test('a generated title replaces the first-message placeholder and is persisted', async () => {
	const bridge = createFakeBridge();
	// A tick of latency so the placeholder is observable before the title lands.
	const agent = createTitleAgent(async () => {
		await new Promise(resolve => setTimeout(resolve, 5));
		return '项目结构梳理';
	});
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('梳理下当前项目，重点是模块之间的依赖');
	assert.equal(session.title.get(), '梳理下当前项目，重点是模块之间的依赖', 'the placeholder is the verbatim first message');

	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(session.title.get(), '项目结构梳理', 'the generated title lands on the session');

	const titles = bridge.appends.filter(call => call.entry.type === 'state').flatMap(call => ('title' in call.entry && call.entry.title !== undefined ? [call.entry.title] : []));
	assert.equal(titles.at(-1), '项目结构梳理', 'the new title is persisted as the last title-bearing state entry');
});

test('a failed title call keeps the placeholder silently', async t => {
	const warnSpy = t.mock.method(console, 'warn', () => undefined);
	const bridge = createFakeBridge();
	const agent = createTitleAgent(async () => {
		throw new Error('provider down');
	});
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('do something');
	await new Promise(resolve => setTimeout(resolve, 10));

	assert.equal(session.title.get(), 'do something', 'the placeholder survives the failure');
	assert.ok(warnSpy.mock.callCount() >= 1, 'the failure is logged, not thrown');
	const titleAppends = bridge.appends.filter(call => call.entry.type === 'state' && 'title' in call.entry && call.entry.title !== undefined);
	assert.equal(titleAppends.length, 1, 'only the creation-time title entry exists');
});

test('a title that arrives after the user renamed the session does not overwrite it', async () => {
	let resolveTitle!: (title: string | undefined) => void;
	const bridge = createFakeBridge();
	const agent = createTitleAgent(
		() =>
			new Promise(resolve => {
				resolveTitle = resolve;
			}),
	);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('do something');
	// Simulate a rename racing the title call: the title observable moves off the placeholder.
	(session.title as unknown as { set(value: string): void }).set('my custom name');
	resolveTitle('generated title');
	await new Promise(resolve => setTimeout(resolve, 10));

	assert.equal(session.title.get(), 'my custom name', 'a non-placeholder title is never overwritten');
});

test('attachments persist on the user message and ride toTranscript as a path hint', async () => {
	const bridge = createFakeBridge();
	const agent = createTitleAgent(async () => undefined);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('review @src/a.ts please', {
		attachments: [
			{ kind: 'file', path: 'src/a.ts' },
			{ kind: 'file', path: 'src/a.ts' }, // duplicate — dropped
			{ kind: 'folder', path: 'src/parts' },
		],
	});
	await new Promise(resolve => setTimeout(resolve, 10));

	const userMessage = session.messages.get().find(message => message.role === 'user');
	assert.deepEqual(userMessage?.attachments, [
		{ kind: 'file', path: 'src/a.ts' },
		{ kind: 'folder', path: 'src/parts' },
	]);

	const persisted = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'user');
	assert.ok(persisted && persisted.entry.type === 'message');
	assert.equal(persisted.entry.attachments?.length, 2, 'deduped attachments are persisted on the entry');

	const transcript = toTranscript(session.messages.get());
	const userTurn = transcript.find(turn => turn.role === 'user');
	const text = (userTurn?.content[0] as { text: string }).text;
	assert.match(text, /<user-attached-paths>/);
	assert.match(text, /src\/a\.ts/);
	assert.match(text, /src\/parts\/ \(folder\)/);
});

test('a message without attachments gains no hint block', () => {
	const transcript = toTranscript([{ id: 'u1', role: 'user', text: 'hello' }]);
	assert.equal((transcript[0]?.content[0] as { text: string }).text, 'hello');
});

test('pending images are stored as media, attached to the message, and ride the transcript as image blocks', async () => {
	const bridge = createFakeBridge();
	const stored: { base64: string; mediaType: string }[] = [];
	bridge.storeMedia = async (ref, base64, mediaType) => {
		stored.push({ base64, mediaType });
		return `media/${ref.sessionId}/hash${stored.length}.png`;
	};
	const agent = createTitleAgent(async () => undefined);
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('look at this screenshot', { images: [{ data: 'QUFB', mediaType: 'image/png' }] });
	await new Promise(resolve => setTimeout(resolve, 10));

	assert.equal(stored.length, 1, 'the image bytes were written to session media');
	const userMessage = session.messages.get().find(message => message.role === 'user');
	assert.deepEqual(userMessage?.attachments, [{ kind: 'image', path: `media/${session.sessionId}/hash1.png`, mediaType: 'image/png' }]);

	const images = new Map([[`media/${session.sessionId}/hash1.png`, { mediaType: 'image/png', data: 'QUFB' }]]);
	const transcript = toTranscript(session.messages.get(), images);
	const userTurn = transcript.find(turn => turn.role === 'user');
	assert.deepEqual(userTurn?.content[0], { type: 'image', mediaType: 'image/png', data: 'QUFB' });
	assert.deepEqual(userTurn?.content[1], { type: 'text', text: 'look at this screenshot' });
});

test('an unresolvable image degrades the turn to text instead of failing it', () => {
	const messages: ISessionMessage[] = [{ id: 'u1', role: 'user', text: 'see image', attachments: [{ kind: 'image', path: 'media/s/gone.png', mediaType: 'image/png' }] }];
	const transcript = toTranscript(messages, new Map());
	assert.deepEqual(transcript[0]?.content, [{ type: 'text', text: 'see image' }]);
});

test('an image-only message survives toTranscript without an empty text block', () => {
	const messages: ISessionMessage[] = [{ id: 'u1', role: 'user', text: '', attachments: [{ kind: 'image', path: 'p.png', mediaType: 'image/png' }] }];
	const transcript = toTranscript(messages, new Map([['p.png', { mediaType: 'image/png', data: 'Q0ND' }]]));
	assert.equal(transcript.length, 1);
	assert.deepEqual(transcript[0]?.content, [{ type: 'image', mediaType: 'image/png', data: 'Q0ND' }]);
});

test('skill attachments are collected across turns and passed to agent.run, not the path block', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const skillIdsSeen: (readonly string[] | undefined)[] = [];
	const agent: IAgentBridge = {
		run: async (sessionId, _messages, _modelId, _projectId, _permissionMode, skillIds) => {
			skillIdsSeen.push(skillIds);
			listener?.({ sessionId, event: { type: 'assistant_delta', text: 'ok' } } as never);
			listener?.({ sessionId, done: { reason: 'completed', turns: 1 } } as never);
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('do it $commit-style', { attachments: [{ kind: 'skill', path: 'commit-style' }] });
	await new Promise(resolve => setTimeout(resolve, 15));
	await provider.sendMessage(session.sessionId, 'and again with $review', { attachments: [{ kind: 'skill', path: 'review' }] });
	await new Promise(resolve => setTimeout(resolve, 15));

	assert.deepEqual(skillIdsSeen[0], ['commit-style'], 'first run carries the first skill');
	assert.deepEqual(skillIdsSeen[1], ['commit-style', 'review'], 'skills are sticky: later runs carry every skill mentioned so far');

	// The path-hint block is for files/folders only — the skill must not appear in it.
	const transcript = toTranscript(session.messages.get());
	assert.ok(
		transcript.every(turn => !(turn.content[0] as { text?: string }).text?.includes('<user-attached-paths>')),
		'no path block from skill-only attachments',
	);
});

test('a compaction ok event becomes the persisted cross-run anchor and rides the next run', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const anchorsSeen: unknown[] = [];
	let runs = 0;
	const agent: IAgentBridge = {
		run: async (sessionId, _messages, _modelId, _projectId, _permissionMode, _skillIds, anchor) => {
			anchorsSeen.push(anchor);
			runs += 1;
			if (runs === 1) {
				// The harness folded the head: summary + covered-initial arrive here.
				listener?.({
					sessionId,
					event: { type: 'compaction', trigger: 'preflight', beforeTokens: 210_000, boundaryIndex: 1, summaryChars: 12, outcome: 'ok', summary: '## anchor v1', coveredInitial: 1 },
				} as never);
			}
			listener?.({ sessionId, event: { type: 'assistant_delta', text: `answer ${runs}` } } as never);
			listener?.({ sessionId, done: { reason: 'completed', turns: 1 } } as never);
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('question one');
	await new Promise(resolve => setTimeout(resolve, 15));
	await provider.sendMessage(session.sessionId, 'question two');
	await new Promise(resolve => setTimeout(resolve, 15));

	// prefixChars mirrors the harness measure over the transcript AS SENT.
	const expectedPrefixChars = JSON.stringify([{ type: 'text', text: 'question one' }]).length;
	const expectedAnchor = { summary: '## anchor v1', covered: 1, prefixChars: expectedPrefixChars };

	assert.equal(anchorsSeen[0], undefined, 'first run has no anchor yet');
	assert.deepEqual(anchorsSeen[1], expectedAnchor, 'second run carries the persisted anchor');

	const stateWithAnchor = bridge.appends.find(call => call.entry.type === 'state' && (call.entry as { compactionAnchor?: unknown }).compactionAnchor !== undefined);
	assert.ok(stateWithAnchor, 'anchor persisted on a state entry');
	assert.deepEqual((stateWithAnchor.entry as { compactionAnchor?: unknown }).compactionAnchor, expectedAnchor);
});

test('formatSessionContext keeps recent turns, truncates long ones, and caps the block', () => {
	const messages: ISessionMessage[] = [
		{ id: 'u0', role: 'user', text: 'ancient question' },
		{ id: 'w1', role: 'work', text: '' },
		...Array.from({ length: 8 }, (_, index) => ({
			id: `m${index}`,
			role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
			text: `turn ${index} ${'x'.repeat(index === 7 ? 2000 : 10)}`,
		})),
	];
	const block = formatSessionContext('梳理下项目', messages);
	assert.match(block, /^<referenced-session title="梳理下项目">/);
	assert.ok(!block.includes('ancient question'), 'only the last turns survive');
	assert.ok(!block.includes('w1'), 'work rows are not conversation turns');
	assert.ok(block.includes('turn 2'), 'recent turns are kept');
	assert.ok(block.length < 5000, 'the whole block stays capped');
	assert.match(block, /…/, 'an oversized turn is truncated');
});

test('a #session attachment injects the referenced context block; an unresolvable one degrades silently', () => {
	const messages: ISessionMessage[] = [
		{ id: 'u1', role: 'user', text: 'like we did in #other', attachments: [{ kind: 'session', path: 'other', label: '梳理下项目' }] },
		{ id: 'u2', role: 'user', text: 'and #gone too', attachments: [{ kind: 'session', path: 'gone' }] },
	];
	const contexts = new Map([['other', '<referenced-session title="梳理下项目">\nuser: hi\n</referenced-session>']]);
	const transcript = toTranscript(messages, undefined, contexts);
	const first = (transcript[0]?.content[0] as { text: string }).text;
	assert.match(first, /<referenced-session title="梳理下项目">/);
	const second = (transcript[1]?.content[0] as { text: string }).text;
	assert.equal(second, 'and #gone too', 'a deleted referenced session adds nothing');
});

test('answer-writing time is not mislabeled as a trailing "Thought" step', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'thinking_delta', text: 'weighing the answer' } });
			emit({ event: { type: 'assistant_delta', text: 'the reply' } });
			// The writing period: >1s so the pre-fix phantom step would pass the
			// noise gate (duration >= 1000 with no content) and show up.
			await new Promise(resolve => setTimeout(resolve, 1100));
			emit({ event: { type: 'assistant_delta', text: ' continues' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('question');
	await new Promise(resolve => setTimeout(resolve, 1300));

	const work = session.messages.get().find(message => message.role === 'work');
	assert.ok(work, 'work block exists');
	const thinkingSteps = (work.steps ?? []).filter(step => step.kind === 'thinking');
	assert.equal(thinkingSteps.length, 1, `exactly one Thought step (the real one), got ${JSON.stringify(work.steps)}`);
	assert.ok(thinkingSteps[0]!.detail?.includes('weighing the answer'), 'the surviving Thought step carries the reasoning text');
});

test('renameSession updates the observable, persists a title entry, and survives rehydration', async () => {
	const bridge = createFakeBridge();
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await provider.initialize();
	const session = await provider.startSession('original question text');
	await provider.whenIdle();

	await provider.renameSession(session.sessionId, '  自定义名字  ');
	assert.equal(session.title.get(), '自定义名字', 'the title is trimmed and applied');

	// Empty and unchanged titles are no-ops (no extra state entries).
	const entriesAfterRename = bridge.appends.filter(call => call.entry.type === 'state' && 'title' in call.entry && call.entry.title !== undefined).length;
	await provider.renameSession(session.sessionId, '   ');
	await provider.renameSession(session.sessionId, '自定义名字');
	const entriesAfterNoOps = bridge.appends.filter(call => call.entry.type === 'state' && 'title' in call.entry && call.entry.title !== undefined).length;
	assert.equal(entriesAfterNoOps, entriesAfterRename, 'no-op renames persist nothing');

	// A second provider folding the same store sees the manual title.
	const rehydrated = new FileSessionsProvider(bridge, { responseDelayMs: 1 });
	await rehydrated.initialize();
	assert.equal(
		rehydrated
			.getSessions()
			.find(candidate => candidate.sessionId === session.sessionId)
			?.title.get(),
		'自定义名字',
	);
});

test('context_breakdown and usage events merge into contextUsage without clobbering each other', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			// Breakdown arrives BEFORE usage (it describes the outgoing request;
			// usage describes the response to that same request).
			emit({
				event: {
					type: 'context_breakdown',
					turn: 1,
					systemChars: 400,
					instructionsChars: 0,
					skillsChars: 0,
					toolsChars: 800,
					messagesChars: 200,
					compactedChars: 0,
					prunedChars: 0,
				},
			});
			emit({ event: { type: 'usage', inputTokens: 1000, cacheReadTokens: 500 } });
			emit({ event: { type: 'assistant_delta', text: 'ok' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('question');
	await new Promise(resolve => setTimeout(resolve, 15));

	const usage = session.contextUsage.get();
	assert.ok(usage, 'contextUsage populated');
	assert.equal(usage.inputTokens, 1500, 'input + cacheRead, the same sum the meter has always used');
	assert.equal(usage.totalSource, 'real', 'usage landed, so the total is now real');
	assert.ok(usage.breakdown, 'the breakdown that arrived before usage was not clobbered by it');
	assert.equal(usage.breakdown.systemChars, 400);
	assert.equal(usage.breakdown.toolsChars, 800);
});

test('context_breakdown keeps the previous real usage total instead of resetting it to zero', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	let runCount = 0;
	const agent: IAgentBridge = {
		run: async sessionId => {
			runCount += 1;
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			if (runCount === 1) {
				emit({ event: { type: 'usage', inputTokens: 5000 } });
				emit({ event: { type: 'assistant_delta', text: 'first' } });
			} else {
				// Turn 2 of run 2: breakdown fires before any usage for THIS run
				// arrives — the panel should still show the last known real total.
				emit({
					event: {
						type: 'context_breakdown',
						turn: 1,
						systemChars: 10,
						instructionsChars: 0,
						skillsChars: 0,
						toolsChars: 0,
						messagesChars: 10,
						compactedChars: 0,
						prunedChars: 0,
					},
				});
				emit({ event: { type: 'assistant_delta', text: 'second' } });
			}
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('q1');
	await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(session.contextUsage.get()?.inputTokens, 5000);
	assert.equal(session.contextUsage.get()?.totalSource, 'real');

	await provider.sendMessage(session.sessionId, 'q2');
	await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(session.contextUsage.get()?.inputTokens, 5000, 'the real total survives a breakdown-only update');
	assert.equal(session.contextUsage.get()?.totalSource, 'real', 'still real — a later breakdown-only turn does not demote it');
	assert.equal(session.contextUsage.get()?.breakdown?.systemChars, 10, 'the breakdown itself did update');
});

test("a fresh run's FIRST context_breakdown does not invent a fake real 0 — it estimates from session text instead", async () => {
	// Regression: reported live — a reopened session (contextUsage undefined
	// since restart) sent a new message; the ring briefly showed a confident
	// "0% used" the instant the run started, before usage() corrected it a
	// moment later. The fix: the FIRST context_breakdown of a process falls
	// back to the same char/4 estimate the ring itself would show, and is
	// marked NOT real, instead of forcing inputTokens to 0.
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			// No usage event at all this turn — mid-run, before the model replies.
			emit({
				event: {
					type: 'context_breakdown',
					turn: 1,
					systemChars: 100,
					instructionsChars: 0,
					skillsChars: 0,
					toolsChars: 100,
					messagesChars: 100,
					compactedChars: 0,
					prunedChars: 0,
				},
			});
			emit({ done: { reason: 'aborted', turns: 1 } });
			return { reason: 'aborted', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	// A long first message so the char/4 estimate is unambiguously non-zero —
	// the old bug would have forced this down to a "real" 0 regardless.
	const longQuestion = 'x'.repeat(4000);
	const session = await provider.startSession(longQuestion);
	await new Promise(resolve => setTimeout(resolve, 15));

	const usage = session.contextUsage.get();
	assert.ok(usage, 'contextUsage populated by the context_breakdown event');
	assert.equal(usage.totalSource, 'estimate', 'no usage event landed yet — must not claim a real total');
	assert.ok(usage.inputTokens > 500, `expected a real char/4 estimate over the long message, got ${usage.inputTokens}`);
	assert.ok(usage.breakdown, 'the live breakdown still shows while waiting for the real count');
});

test('the context meter reading persists at finalize and rehydrates as "restored"', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({
				event: {
					type: 'context_breakdown',
					turn: 1,
					systemChars: 400,
					instructionsChars: 40,
					skillsChars: 0,
					toolsChars: 800,
					messagesChars: 200,
					compactedChars: 0,
					prunedChars: 0,
				},
			});
			emit({ event: { type: 'usage', inputTokens: 12_345 } });
			emit({ event: { type: 'assistant_delta', text: 'ok' } });
			emit({ done: { reason: 'completed', turns: 1 } });
			return { reason: 'completed', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('question');
	await new Promise(resolve => setTimeout(resolve, 15));

	// Persisted on the finalize state entry, real total + the live breakdown.
	const stateWithUsage = bridge.appends.find(call => call.entry.type === 'state' && (call.entry as { contextUsage?: unknown }).contextUsage !== undefined);
	assert.ok(stateWithUsage, 'contextUsage persisted on a state entry');
	const persisted = (stateWithUsage.entry as { contextUsage: { inputTokens: number; breakdown?: { systemChars: number } } }).contextUsage;
	assert.equal(persisted.inputTokens, 12_345);
	assert.equal(persisted.breakdown?.systemChars, 400);

	// A second provider folding the same store hydrates it as a restored bill.
	const snapshot = createSnapshot(session.sessionId, {
		contextUsage: {
			inputTokens: 12_345,
			breakdown: { systemChars: 400, instructionsChars: 40, skillsChars: 0, toolsChars: 800, messagesChars: 200, compactedChars: 0, prunedChars: 0 },
		},
	});
	const rehydrated = new FileSessionsProvider(createFakeBridge([snapshot]), { responseDelayMs: 1 });
	await rehydrated.initialize();
	const restored = rehydrated.getSessions()[0]!.contextUsage.get();
	assert.ok(restored, 'restored reading present before any run in this process');
	assert.equal(restored.totalSource, 'restored');
	assert.equal(restored.inputTokens, 12_345);
	assert.equal(restored.breakdown?.systemChars, 400);
});

test("a restored total carries through the next run's first breakdown without demotion to estimate", async () => {
	const snapshot = createSnapshot('s-restored', { contextUsage: { inputTokens: 30_000 } });
	const bridge = createFakeBridge([snapshot]);
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			// Breakdown only — no usage yet (mid-run shape).
			emit({
				event: {
					type: 'context_breakdown',
					turn: 1,
					systemChars: 10,
					instructionsChars: 0,
					skillsChars: 0,
					toolsChars: 0,
					messagesChars: 10,
					compactedChars: 0,
					prunedChars: 0,
				},
			});
			emit({ done: { reason: 'aborted', turns: 1 } });
			return { reason: 'aborted', turns: 1 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = provider.getSessions()[0]!;
	assert.equal(session.contextUsage.get()?.totalSource, 'restored');

	await provider.sendMessage(session.sessionId, 'follow-up');
	await new Promise(resolve => setTimeout(resolve, 15));

	const usage = session.contextUsage.get();
	assert.ok(usage);
	assert.equal(usage.totalSource, 'restored', "the last run's real bill beats a fresh estimate");
	assert.equal(usage.inputTokens, 30_000, 'the restored number carries forward');
	assert.equal(usage.breakdown?.systemChars, 10, 'the live breakdown still updates');
});

test("pre-tool narration relocates into the work block; only the terminal turn's text is the answer", async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			// The reported shape: turn 1 announces intent in visible text, then
			// calls tools; the real answer only arrives in the terminal turn.
			emit({ event: { type: 'turn_start', turn: 1 } });
			emit({ event: { type: 'thinking_delta', text: 'planning the sweep' } });
			emit({ event: { type: 'assistant_delta', text: '我来梳理一下这个项目。' } });
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'list_dir', input: { path: '.' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'src/', isError: false } });
			emit({ event: { type: 'turn_start', turn: 2 } });
			emit({ event: { type: 'assistant_delta', text: '项目结构如下：…' } });
			emit({ done: { reason: 'completed', turns: 2 } });
			return { reason: 'completed', turns: 2 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('梳理下项目');
	await new Promise(resolve => setTimeout(resolve, 15));

	// The answer bubble carries ONLY the terminal turn's text — no preamble,
	// no concatenation.
	const assistant = session.messages.get().find(message => message.role === 'assistant');
	assert.ok(assistant, 'assistant reply exists');
	assert.equal(assistant.text, '项目结构如下：…');

	// The narration became a work step, positioned before the tool step.
	const work = session.messages.get().find(message => message.role === 'work');
	assert.ok(work, 'work block exists');
	const kinds = (work.steps ?? []).map(step => step.kind);
	const narrationIndex = kinds.indexOf('narration');
	const toolIndex = kinds.indexOf('tool');
	assert.ok(narrationIndex !== -1, `expected a narration step, got kinds=${JSON.stringify(kinds)}`);
	assert.ok(toolIndex !== -1 && narrationIndex < toolIndex, 'narration precedes the tool it announced');
	assert.equal((work.steps ?? [])[narrationIndex]!.label, '我来梳理一下这个项目。');

	// Persistence matches what the UI shows: the assistant entry is the final
	// text only, and the work entry carries the narration step.
	const persistedAssistant = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'assistant');
	assert.ok(persistedAssistant, 'assistant message persisted');
	assert.equal((persistedAssistant.entry as { text: string }).text, '项目结构如下：…');
	const persistedWork = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'work');
	assert.ok(persistedWork, 'work entry persisted');
	assert.ok(
		((persistedWork.entry as { steps?: readonly { kind: string }[] }).steps ?? []).some(step => step.kind === 'narration'),
		'narration step persisted',
	);
});

test('a rejected reply never resurfaces as narration in the retry turn', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'turn_start', turn: 1 } });
			emit({ event: { type: 'assistant_delta', text: '答非所问的回复' } });
			// The verifier rejects it; the loop grants one retry turn that uses a tool.
			emit({ event: { type: 'reply_verifier', verdict: 'fail', retried: true } });
			emit({ event: { type: 'turn_start', turn: 2 } });
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'grep', input: { pattern: 'x' } } });
			emit({ event: { type: 'tool_result', toolUseId: 't1', content: 'hit', isError: false } });
			emit({ event: { type: 'turn_start', turn: 3 } });
			emit({ event: { type: 'assistant_delta', text: '正确的回复' } });
			emit({ done: { reason: 'completed', turns: 3 } });
			return { reason: 'completed', turns: 3 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
		generateTitle: async () => undefined,
	};
	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, titleModelsService);
	await provider.initialize();

	const session = await provider.startSession('问题');
	await new Promise(resolve => setTimeout(resolve, 15));

	const assistant = session.messages.get().find(message => message.role === 'assistant');
	assert.equal(assistant?.text, '正确的回复');
	const work = session.messages.get().find(message => message.role === 'work');
	const narrations = (work?.steps ?? []).filter(step => step.kind === 'narration');
	assert.equal(narrations.length, 0, `the rejected reply must not reappear as narration: ${JSON.stringify(narrations)}`);
});

test('an aborted run persists a substantive summary and an INTERRUPTED digest note, not "Stopped."', async () => {
	const bridge = createFakeBridge();
	let listener: ((payload: IAgentEventPayload) => void) | undefined;
	const agent: IAgentBridge = {
		run: async sessionId => {
			const emit = (payload: object): void => listener?.({ sessionId, ...payload } as never);
			emit({ event: { type: 'thinking_delta', text: '服务还是没有运行。启动命令说成功，但状态显示没有运行。让我直接执行 java 命令看看错误。' } });
			emit({ event: { type: 'tool_use', toolUseId: 't1', name: 'run_on_server', input: { command: 'java -jar yzj-opms.jar' } } });
			// The user hits stop while the tool streams — no tool_result, no reply text.
			emit({ done: { reason: 'aborted', turns: 3 } });
			return { reason: 'aborted', turns: 3 };
		},
		stop: async () => undefined,
		onEvent: l => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		onApprovalRequest: () => () => undefined,
		respondApproval: async () => undefined,
	};
	const modelsService = {
		registry: { get: () => ({ providers: [{ models: [{ enabled: true }] }] }) },
		selectedModel: { get: () => ({ id: 'model-1' }) },
	} as never;

	const provider = new FileSessionsProvider(bridge, { responseDelayMs: 1 }, agent, modelsService);
	await provider.initialize();
	const session = await provider.startSession('部署到服务器');
	await new Promise(resolve => setTimeout(resolve, 10));

	const reply = session.messages.get().find(message => message.role === 'assistant');
	assert.ok(reply, 'an assistant summary exists');
	assert.notEqual(reply.text, 'Stopped.');
	assert.match(reply.text, /本次运行被用户中止/);
	assert.match(reply.text, /中止前的最后判断：服务还是没有运行/);
	assert.match(reply.text, /中止时正在执行：run_on_server/);

	const digest = session.messages.get().find(message => message.role === 'digest');
	assert.ok(digest, 'a digest message exists even though the loop never emitted one');
	assert.match(digest.text, /INTERRUPTED mid-task/);

	const persistedReply = bridge.appends.find(call => call.entry.type === 'message' && call.entry.role === 'assistant');
	assert.ok(persistedReply, 'the summary is persisted');
});

test('humanizeAgentRunError: quota 403 becomes actionable copy carrying the provider message (#19)', () => {
	const raw = 'Anthropic request failed: 403 {"type":"error","error":{"type":"permission_error","message":"Your credits are exhausted for this billing cycle."}}';
	const text = humanizeAgentRunError(raw);
	assert.match(text, /HTTP 403/);
	assert.match(text, /额度已用尽/);
	assert.match(text, /重新发送/);
	assert.match(text, /credits are exhausted/, 'provider message rides along as evidence');
	assert.doesNotMatch(text, /Agent error:/, 'recognized statuses drop the raw prefix');
});

test('humanizeAgentRunError: 401/429/5xx get their own copy; unparseable bodies and unknown errors stay raw', () => {
	assert.match(humanizeAgentRunError('Anthropic request failed: 401 '), /API Key 无效或已过期/);
	assert.match(humanizeAgentRunError('Anthropic request failed: 429 not-json'), /限流/);
	assert.match(humanizeAgentRunError('Anthropic request failed: 529 {"error":{"message":"overloaded"}}'), /服务端异常（HTTP 529）/);
	// A 400 is a request-shape bug, not something the user can act on — raw text is the evidence.
	assert.match(humanizeAgentRunError('Anthropic request failed: 400 {"error":{"message":"bad request"}}'), /^Agent error: Anthropic request failed: 400/);
	assert.equal(humanizeAgentRunError('fetch failed'), 'Agent error: fetch failed');
});
