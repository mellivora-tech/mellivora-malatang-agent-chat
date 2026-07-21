/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentLoop } from '../../src/main/agent/agentLoop.js';
import { allowAllPermissionGate, createApprovalPermissionGate, defineTool, toolSpec } from '../../src/main/agent/agentTools.js';
import { createScriptedModelClient } from '../../src/main/agent/scriptedModelClient.js';
import type { IAgentEvent, IAgentMessage, IAgentTerminal, IModelClient, IModelRequest, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';
import type { IHook } from '../../src/main/agent/hooks/hooks.js';

async function drive(loop: AsyncGenerator<IAgentEvent, IAgentTerminal>): Promise<{ events: IAgentEvent[]; terminal: IAgentTerminal }> {
	const events: IAgentEvent[] = [];
	let step = await loop.next();
	while (!step.done) {
		events.push(step.value);
		step = await loop.next();
	}

	return { events, terminal: step.value };
}

function userMessage(text: string): IAgentMessage {
	return { role: 'user', content: [{ type: 'text', text }] };
}

/** All text-block content of one message, joined. */
function text(message: IAgentMessage): string {
	return message.content
		.filter((block): block is Extract<IAgentMessage['content'][number], { type: 'text' }> => block.type === 'text')
		.map(block => block.text)
		.join('\n');
}

function findToolResult(events: readonly IAgentEvent[]): Extract<IAgentEvent, { type: 'tool_result' }> {
	const result = events.find((event): event is Extract<IAgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
	assert.ok(result, 'expected a tool_result event');
	return result;
}

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo the provided text.',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	isReadOnly: () => true,
	validateInput: input => {
		if (typeof input === 'object' && input !== null && typeof (input as { text?: unknown }).text === 'string') {
			return { ok: true, value: input };
		}

		return { ok: false, error: 'text must be a string' };
	},
	call: async input => ({ content: `echo: ${(input as { text: string }).text}` }),
});

const writeTool = defineTool({
	name: 'write',
	description: 'Write a file (not read-only).',
	inputSchema: { type: 'object' },
	validateInput: input => ({ ok: true, value: input }),
	call: async () => ({ content: 'wrote file' }),
});

const writeFileTool = defineTool({
	name: 'write_file',
	description: 'Write a file.',
	inputSchema: { type: 'object' },
	validateInput: input => ({ ok: true, value: input }),
	call: async () => ({ content: 'wrote' }),
});

const walkthroughToolStub = defineTool({
	name: 'write_walkthrough',
	description: 'Record a walkthrough.',
	inputSchema: { type: 'object' },
	isReadOnly: () => true,
	validateInput: input => ({ ok: true, value: input }),
	call: async () => ({ content: 'walkthrough recorded' }),
});

const readFileTool = defineTool({
	name: 'read_file',
	description: 'Read a file.',
	inputSchema: { type: 'object' },
	isReadOnly: () => true,
	validateInput: input => ({ ok: true, value: input }),
	call: async () => ({ content: 'file contents' }),
});

const queryDataSourceStub = defineTool({
	name: 'query_data_source',
	description: 'Run a read-only query.',
	inputSchema: { type: 'object' },
	isReadOnly: () => true,
	validateInput: input => ({ ok: true, value: input }),
	call: async () => ({ content: 'col\n1' }),
});

function workDigestEvent(events: readonly IAgentEvent[]): Extract<IAgentEvent, { type: 'work_digest' }> | undefined {
	return events.find((event): event is Extract<IAgentEvent, { type: 'work_digest' }> => event.type === 'work_digest');
}

/** A scripted client that also records the request.messages it was called with. */
function capturingModelClient(turns: readonly { readonly emit: readonly IScriptedLike[] }[]): { client: IModelClient; requests: IModelRequest[] } {
	const requests: IModelRequest[] = [];
	let index = 0;
	const client: IModelClient = {
		async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
			// The loop mutates one `messages` array in place, so a stored reference
			// would always read the FINAL transcript — snapshot at call time.
			requests.push({ ...request, messages: JSON.parse(JSON.stringify(request.messages)) as IModelRequest['messages'] });
			const turn = turns[index];
			index += 1;
			if (!turn) {
				yield { type: 'message_stop', stopReason: 'end_turn' };
				return;
			}
			let emittedToolUse = false;
			for (const emission of turn.emit) {
				if (emission.type === 'text') {
					yield { type: 'text_delta', text: emission.text };
				} else {
					emittedToolUse = true;
					yield { type: 'tool_use', block: { type: 'tool_use', id: emission.id, name: emission.name, input: emission.input } };
				}
			}
			yield { type: 'message_stop', stopReason: emittedToolUse ? 'tool_use' : 'end_turn' };
		},
	};
	return { client, requests };
}
type IScriptedLike = { readonly type: 'text'; readonly text: string } | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

function lastUserText(request: IModelRequest): string {
	const users = request.messages.filter(message => message.role === 'user');
	const last = users[users.length - 1];
	return last ? text(last) : '';
}

test('walkthrough nudge: a file-changing run with no walkthrough is forced to write one', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off'; // isolate the nudge from the reply verifier
	try {
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'write_file', input: {} }] }, // turn 1: change a file
			{ emit: [{ type: 'text', text: 'Done, I changed the file.' }] }, // turn 2: stop WITHOUT a walkthrough
			{ emit: [{ type: 'tool_use', id: 't2', name: 'write_walkthrough', input: {} }] }, // turn 3: after the nudge
		]);
		const { terminal } = await drive(
			runAgentLoop([userMessage('add a feature')], {
				system: 's',
				tools: [writeFileTool, walkthroughToolStub],
				modelClient: client,
				permissionGate: allowAllPermissionGate,
			}),
		);

		assert.equal(terminal.reason, 'completed');
		// Without the nudge the model would have stopped at turn 2; it was forced on.
		assert.ok(terminal.turns >= 3, `expected a forced extra turn, got ${terminal.turns}`);
		// The turn-3 model call received the injected walkthrough reminder.
		assert.match(lastUserText(requests[2]!), /write_walkthrough/);
		assert.ok(
			requests.some(request => /You changed files/.test(lastUserText(request))),
			'the nudge reminder was injected',
		);
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('walkthrough nudge: does NOT fire when a walkthrough was already written', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'write_file', input: {} }] },
			{ emit: [{ type: 'tool_use', id: 't2', name: 'write_walkthrough', input: {} }] },
			{ emit: [{ type: 'text', text: 'All done.' }] },
		]);
		const { terminal } = await drive(
			runAgentLoop([userMessage('add a feature')], { system: 's', tools: [writeFileTool, walkthroughToolStub], modelClient: client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.turns, 3, 'stops naturally, no forced extra turn');
		assert.ok(!requests.some(request => /You changed files/.test(lastUserText(request))), 'no nudge injected');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('walkthrough nudge: does NOT fire when no files were changed', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'echo', input: { text: 'x' } }] }, // read-only
			{ emit: [{ type: 'text', text: 'Here is the answer.' }] },
		]);
		const { terminal } = await drive(
			runAgentLoop([userMessage('what does this do')], { system: 's', tools: [echoTool, walkthroughToolStub], modelClient: client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.turns, 2, 'a read-only run stops without a nudge');
		assert.ok(!requests.some(request => /You changed files/.test(lastUserText(request))), 'no nudge injected');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('a tool_use turn runs the tool and loops to completion', async () => {
	const model = createScriptedModelClient([
		{
			emit: [
				{ type: 'text', text: 'Let me look.' },
				{ type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'hi' } },
			],
		},
		{ emit: [{ type: 'text', text: 'Done.' }] },
	]);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('hello')], {
			system: 'test system',
			tools: [echoTool],
			modelClient: model,
			permissionGate: createApprovalPermissionGate(async () => false),
		}),
	);

	assert.equal(terminal.reason, 'completed');
	assert.equal(terminal.turns, 2);

	// Read-only tool is auto-allowed even though the approval gate would deny writes.
	const toolResult = findToolResult(events);
	assert.equal(toolResult.isError, false);
	assert.equal(toolResult.content, 'echo: hi');

	assert.equal(events.filter(event => event.type === 'turn_start').length, 2);
});

test('a denied tool becomes an error tool_result and the loop continues', async () => {
	const model = createScriptedModelClient([{ emit: [{ type: 'tool_use', id: 'tu1', name: 'write', input: { path: 'x' } }] }, { emit: [{ type: 'text', text: 'ok' }] }]);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('go')], {
			system: 'test system',
			tools: [writeTool],
			modelClient: model,
			permissionGate: createApprovalPermissionGate(async () => false),
		}),
	);

	const toolResult = findToolResult(events);
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content, /Permission denied/);
	assert.equal(terminal.reason, 'completed');
});

test('an unknown tool becomes an error tool_result instead of throwing', async () => {
	const model = createScriptedModelClient([{ emit: [{ type: 'tool_use', id: 'tu1', name: 'nope', input: {} }] }, { emit: [{ type: 'text', text: 'ok' }] }]);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('go')], {
			system: 'test system',
			tools: [echoTool],
			modelClient: model,
			permissionGate: allowAllPermissionGate,
		}),
	);

	const toolResult = findToolResult(events);
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content, /No such tool available/);
	assert.equal(terminal.reason, 'completed');
});

test('transient stream failures retry with stream_retry events before any text', async () => {
	let attempts = 0;
	const flakyClient = {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			attempts += 1;
			if (attempts <= 2) {
				throw new Error('fetch failed');
			}
			yield { type: 'text_delta', text: 'recovered' };
			yield { type: 'message_stop', stopReason: 'end_turn' };
		},
	};

	const loop = runAgentLoop([userMessage('hi')], {
		system: 's',
		tools: [],
		modelClient: flakyClient as never,
		permissionGate: allowAllPermissionGate,
	});
	const { events, terminal } = await drive(loop);

	const retries = events.filter(event => event.type === 'stream_retry');
	assert.equal(retries.length, 2);
	assert.deepEqual(
		retries.map(event => (event.type === 'stream_retry' ? event.attempt : 0)),
		[1, 2],
	);
	assert.equal(terminal.reason, 'completed');
	assert.ok(events.some(event => event.type === 'assistant_delta' && event.text === 'recovered'));
});

test('a usage stream event forwards as an IAgentEvent for the renderer to read', async () => {
	const client = {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			yield { type: 'text_delta', text: 'ok' };
			yield { type: 'usage', inputTokens: 4321, outputTokens: 7 };
			yield { type: 'message_stop', stopReason: 'end_turn' };
		},
	};

	const { events } = await drive(runAgentLoop([userMessage('hi')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }));

	const usage = events.find((event): event is Extract<IAgentEvent, { type: 'usage' }> => event.type === 'usage');
	assert.ok(usage, 'expected a usage event');
	assert.equal(usage.inputTokens, 4321);
	assert.equal(usage.outputTokens, 7);
});

test('loop guard: the third identical consecutive call is blocked and fed back as an error result', async () => {
	delete process.env['MELLIVORA_LOOP_GUARD'];
	let executions = 0;
	const countingTool = defineTool({
		name: 'probe',
		description: 'Counts executions.',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		validateInput: input => ({ ok: true, value: input }),
		call: async () => {
			executions += 1;
			return { content: 'ok' };
		},
	});
	// Three turns, each repeating the exact same call; then a final answer.
	const model = createScriptedModelClient([
		{ emit: [{ type: 'tool_use', id: 't1', name: 'probe', input: { q: 'same' } }] },
		{ emit: [{ type: 'tool_use', id: 't2', name: 'probe', input: { q: 'same' } }] },
		{ emit: [{ type: 'tool_use', id: 't3', name: 'probe', input: { q: 'same' } }] },
		{ emit: [{ type: 'text', text: 'fine, concluding.' }] },
	]);

	const { events, terminal } = await drive(runAgentLoop([userMessage('go')], { system: 's', tools: [countingTool], modelClient: model, permissionGate: allowAllPermissionGate }));

	assert.equal(terminal.reason, 'completed');
	assert.equal(executions, 2, 'first two identical calls execute; the third does not');

	const results = events.filter((event): event is Extract<IAgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
	assert.equal(results.length, 3, 'the blocked call still produces a tool_result for the model');
	assert.equal(results[2]!.isError, true);
	assert.match(results[2]!.content, /Loop guard/);

	const guardEvents = events.filter((event): event is Extract<IAgentEvent, { type: 'loop_guard' }> => event.type === 'loop_guard');
	assert.equal(guardEvents.length, 1, 'one loop_guard event for observability');
	assert.equal(guardEvents[0]!.name, 'probe');
	assert.equal(guardEvents[0]!.repeatCount, 3);
});

test('loop guard: three identical calls within a single batched turn — the third is blocked', async () => {
	delete process.env['MELLIVORA_LOOP_GUARD'];
	let executions = 0;
	const countingTool = defineTool({
		name: 'probe',
		description: 'Counts executions.',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		validateInput: input => ({ ok: true, value: input }),
		call: async () => {
			executions += 1;
			return { content: 'ok' };
		},
	});
	const model = createScriptedModelClient([
		{
			emit: [
				{ type: 'tool_use', id: 'b1', name: 'probe', input: { q: 'same' } },
				{ type: 'tool_use', id: 'b2', name: 'probe', input: { q: 'same' } },
				{ type: 'tool_use', id: 'b3', name: 'probe', input: { q: 'same' } },
			],
		},
		{ emit: [{ type: 'text', text: 'done' }] },
	]);

	const { events } = await drive(runAgentLoop([userMessage('go')], { system: 's', tools: [countingTool], modelClient: model, permissionGate: allowAllPermissionGate }));

	assert.equal(executions, 2, 'batch-internal repetition counted the same way');
	const results = events.filter((event): event is Extract<IAgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
	assert.equal(results[2]!.isError, true);
	assert.match(results[2]!.content, /Loop guard/);
});

test('a max_tokens stop surfaces as max_output_tokens instead of masquerading as completed', async () => {
	// Worst case: thinking ate the whole output budget — the stream stops at
	// max_tokens without any visible text.
	const client = {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			yield { type: 'thinking_delta', text: 'a very long think…' };
			yield { type: 'message_stop', stopReason: 'max_tokens' };
		},
	};

	const { terminal } = await drive(runAgentLoop([userMessage('hi')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }));

	assert.equal(terminal.reason, 'max_output_tokens');
});

/** A call-counting client: entry N answers the Nth stream() call; requests are captured for inspection. */
function sequenceClient(outputs: readonly string[]): { client: IModelRequestCapturingClient; requests: IModelRequest[] } {
	const requests: IModelRequest[] = [];
	const client = {
		async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
			requests.push(request);
			const output = outputs[requests.length - 1] ?? '';
			if (output !== '') {
				yield { type: 'text_delta', text: output };
			}
			yield { type: 'message_stop', stopReason: 'end_turn' };
		},
	};
	return { client, requests };
}
type IModelRequestCapturingClient = { stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> };

test('reply verifier: a failed judgment feeds back and grants exactly one retry', async () => {
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
	// call1 = off-topic answer; call2 = judge says NO; call3 = retry answer.
	// A 4th call would be a second judgment — the once-per-run cap forbids it.
	const { client, requests } = sequenceClient(['The weather is nice today.', 'NO\ntalks about weather, not the question', 'The answer is 42.']);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('what is 6 times 7?')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }),
	);

	assert.equal(terminal.reason, 'completed');
	assert.equal(terminal.turns, 2, 'the retry is a second turn');
	assert.equal(requests.length, 3, 'main + judge + retry, no second judgment');

	const verifier = events.find((event): event is Extract<IAgentEvent, { type: 'reply_verifier' }> => event.type === 'reply_verifier');
	assert.ok(verifier, 'reply_verifier event emitted');
	assert.equal(verifier.verdict, 'fail');
	assert.equal(verifier.retried, true);
	assert.match(verifier.reason ?? '', /weather/);

	// The judge saw the question and the answer; the retry saw the feedback.
	const judgeText = JSON.stringify(requests[1]!.messages);
	assert.match(judgeText, /6 times 7/);
	assert.match(judgeText, /weather is nice/);
	const retryText = JSON.stringify(requests[2]!.messages);
	assert.match(retryText, /Reply verifier/);

	const replies = events.filter(event => event.type === 'assistant_message');
	assert.equal(replies.length, 2, 'both attempts streamed as assistant messages');
});

test('user hooks: a wired Stop hook blocks and forces one retry, then is guarded (fires once, no spin)', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	const { client, requests } = sequenceClient(['first answer', 'second answer']);
	// This hook would block on EVERY call; only the once-per-run guard stops an infinite loop.
	const stopHook: IHook = { id: 'user:redo', event: 'Stop', run: () => ({ decision: 'block', reason: 'user hook says redo' }) };

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('hi')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate, userHooks: [stopHook] }),
	);

	assert.equal(terminal.turns, 2, 'the block forced exactly one retry');
	assert.equal(requests.length, 2, 'the Stop hook fired once and was guarded — no spin');
	assert.match(JSON.stringify(requests[1]!.messages), /user hook says redo/, 'the block reason was fed back as the retry');

	// Observability (§9): the block is recorded as a hook event.
	const hookEvents = events.filter((event): event is Extract<IAgentEvent, { type: 'hook' }> => event.type === 'hook');
	assert.deepEqual(hookEvents, [{ type: 'hook', event: 'Stop', hookId: 'user:redo', decision: 'block' }]);
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
});

test('reply verifier: a passing judgment changes nothing', async () => {
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
	const { client, requests } = sequenceClient(['42.', 'YES\ndirect answer']);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('what is 6 times 7?')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }),
	);

	assert.equal(terminal.reason, 'completed');
	assert.equal(terminal.turns, 1);
	assert.equal(requests.length, 2, 'main + judge only');
	const verifier = events.find((event): event is Extract<IAgentEvent, { type: 'reply_verifier' }> => event.type === 'reply_verifier');
	assert.equal(verifier?.verdict, 'pass');
	assert.equal(verifier?.retried, false);
});

test('reply verifier: an unparseable judge is fail-open — no retry', async () => {
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
	const { client, requests } = sequenceClient(['some answer', 'MAYBE, who can say']);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('question?')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }),
	);

	assert.equal(terminal.reason, 'completed');
	assert.equal(requests.length, 2);
	const verifier = events.find((event): event is Extract<IAgentEvent, { type: 'reply_verifier' }> => event.type === 'reply_verifier');
	assert.equal(verifier?.verdict, 'error');
	assert.equal(verifier?.retried, false);
});

test('reply verifier: MELLIVORA_REPLY_VERIFIER=off skips the judge entirely', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = sequenceClient(['some answer']);
		const { events } = await drive(runAgentLoop([userMessage('question?')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }));
		assert.equal(requests.length, 1, 'no judge call');
		assert.equal(
			events.some(event => event.type === 'reply_verifier'),
			false,
		);
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('reply verifier: refusal and truncation terminals are never verified', async () => {
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
	const refusing = {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			yield { type: 'text_delta', text: 'cannot help with that' };
			yield { type: 'message_stop', stopReason: 'refusal' };
		},
	};
	const { events, terminal } = await drive(
		runAgentLoop([userMessage('question?')], { system: 's', tools: [], modelClient: refusing as never, permissionGate: allowAllPermissionGate }),
	);
	assert.equal(terminal.reason, 'refusal');
	assert.equal(
		events.some(event => event.type === 'reply_verifier'),
		false,
	);
});

test('tool prune: old outputs age out of the request view while history and events keep full text', async () => {
	delete process.env['MELLIVORA_TOOL_PRUNE'];
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off'; // isolate: no judge call at the end
	try {
		const bigTool = defineTool({
			name: 'probe',
			description: 'Returns a large payload.',
			inputSchema: { type: 'object' },
			isReadOnly: () => true,
			validateInput: input => ({ ok: true, value: input }),
			call: async input => ({ content: `r${(input as { i: number }).i}:${'x'.repeat(19_996)}` }),
		});

		// Five distinct 20K-char results, then a final answer. With the default
		// budgets (protect 48K, quantum 16K): turn-5 request prunes 1 result,
		// turn-6 request prunes 2.
		const requests: IModelRequest[] = [];
		let call = 0;
		const client = {
			async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
				requests.push(request);
				call += 1;
				if (call <= 5) {
					yield { type: 'tool_use', block: { type: 'tool_use', id: `t${call}`, name: 'probe', input: { i: call } } };
					yield { type: 'message_stop', stopReason: 'tool_use' };
				} else {
					yield { type: 'text_delta', text: 'done' };
					yield { type: 'message_stop', stopReason: 'end_turn' };
				}
			},
		};

		const { events, terminal } = await drive(
			runAgentLoop([userMessage('collect the data')], { system: 's', tools: [bigTool], modelClient: client as never, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.reason, 'completed');

		// Each result is 19,999 chars ("rN:" + 19,996 x's). Turn 5's request is
		// over-protect by 31,996 → quantized target 16,000, but the oldest whole
		// result (19,999) does not fit → nothing pruned yet. Turn 6 crosses the
		// next step (target 48,000) and prunes the two oldest at once.
		const countStubs = (request: IModelRequest): number => JSON.stringify(request.messages).split('[pruned]').length - 1;
		assert.equal(countStubs(requests[3]!), 0, 'turn 4: under the first quantum step');
		assert.equal(countStubs(requests[4]!), 0, 'turn 5: whole-result granularity holds the boundary');
		assert.equal(countStubs(requests[5]!), 2, 'turn 6: the two oldest results aged out together');
		assert.ok(JSON.stringify(requests[5]!.messages).includes(`r5:${'x'.repeat(50)}`), 'recent results stay verbatim');

		const pruneEvents = events.filter((event): event is Extract<IAgentEvent, { type: 'tool_prune' }> => event.type === 'tool_prune');
		assert.deepEqual(
			pruneEvents.map(event => event.prunedResults),
			[2],
			'telemetry fires only when the pruned set grows',
		);
		assert.equal(pruneEvents[0]!.prunedChars, 39_998);

		// The loop's history and the renderer-facing events were never pruned.
		const results = events.filter((event): event is Extract<IAgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
		assert.ok(
			results.every(result => result.content.length === 19_999),
			'tool_result events always carry the full output',
		);
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('thinking blocks are preserved in the transcript and passed back on the next request', async () => {
	delete process.env['MELLIVORA_TOOL_PRUNE'];
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const requests: IModelRequest[] = [];
		let call = 0;
		const client = {
			async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
				requests.push(request);
				call += 1;
				if (call === 1) {
					yield { type: 'thinking_delta', text: 'reasoning…' };
					yield { type: 'thinking_block', block: { type: 'thinking', thinking: 'reasoning…', signature: 'sig-77' } };
					yield { type: 'tool_use', block: { type: 'tool_use', id: 't1', name: 'echo', input: { text: 'hi' } } };
					yield { type: 'message_stop', stopReason: 'tool_use' };
				} else {
					yield { type: 'text_delta', text: 'done' };
					yield { type: 'message_stop', stopReason: 'end_turn' };
				}
			},
		};

		const { events, terminal } = await drive(
			runAgentLoop([userMessage('go')], { system: 's', tools: [echoTool], modelClient: client as never, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.reason, 'completed');

		// The second request's assistant message leads with the signed thinking block.
		const assistant = requests[1]!.messages.find(message => message.role === 'assistant');
		assert.ok(assistant);
		assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'reasoning…', signature: 'sig-77' });
		assert.equal(assistant.content[1]?.type, 'tool_use', 'canonical order: thinking before tool_use');

		// UI stream unchanged: deltas flowed, but no new renderer-facing event kind.
		assert.ok(events.some(event => event.type === 'thinking_delta'));
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('non-retryable stream errors surface immediately', async () => {
	const failingClient = {
		// eslint-disable-next-line require-yield
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			throw new Error('Anthropic request failed: 401 unauthorized');
		},
	};

	const loop = runAgentLoop([userMessage('hi')], {
		system: 's',
		tools: [],
		modelClient: failingClient as never,
		permissionGate: allowAllPermissionGate,
	});
	await assert.rejects(async () => drive(loop), /401/);
});

test('convergence brake: soft reminder, then the hard phase withholds tools to force an answer', async () => {
	const calls: { tools: number; soft: boolean; hard: boolean }[] = [];
	// A model that keeps calling a tool as long as it has one — without the brake
	// it would loop until max_turns. Its behaviour is driven by request.tools.
	const client = {
		async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
			const text = request.messages
				.flatMap(message => message.content)
				.map(block => (block.type === 'text' ? block.text : ''))
				.join('\n');
			calls.push({ tools: request.tools.length, soft: text.includes('used most of your step budget'), hard: text.includes('Step budget reached') });
			if (request.tools.length > 0) {
				yield { type: 'tool_use', block: { type: 'tool_use', id: `t${calls.length}`, name: 'echo', input: { text: 'x' } } };
				yield { type: 'message_stop', stopReason: 'tool_use' };
			} else {
				yield { type: 'text_delta', text: 'final answer' };
				yield { type: 'message_stop', stopReason: 'end_turn' };
			}
		},
	};

	const { terminal } = await drive(
		runAgentLoop([userMessage('go')], {
			system: 's',
			tools: [echoTool],
			modelClient: client as never,
			permissionGate: allowAllPermissionGate,
			maxTurns: 10,
		}),
	);

	// maxTurns 10 → soft brake at turn 7, hard brake at turn 9. The hard phase
	// removes tools, so the model must answer before ever hitting the cap.
	assert.equal(terminal.reason, 'completed', 'forced to synthesize instead of hitting max_turns');
	assert.ok(terminal.turns < 10, `stopped before the cap at turn ${terminal.turns}`);
	assert.ok(
		calls.some(call => call.soft && call.tools > 0),
		'soft reminder injected while tools were still available',
	);
	const hardCall = calls.find(call => call.hard);
	assert.ok(hardCall, 'hard reminder injected');
	assert.equal(hardCall.tools, 0, 'tools withheld in the hard phase');
});

// ---------------------------------------------------------------------------
// Auto-compaction (3.1)
// ---------------------------------------------------------------------------

/** 20K chars per result so the 32K tail budget holds exactly one exchange. */
const bigTool = defineTool({
	name: 'big',
	description: 'Return a large payload.',
	inputSchema: { type: 'object' },
	isReadOnly: () => true,
	validateInput: input => ({ ok: true, value: input }),
	call: async input => ({ content: `RESULT${(input as { n: number }).n}_${'x'.repeat(20_000)}` }),
});

/**
 * A client that plays a main conversation (tool turns with growing usage, then
 * a final text) and answers compaction summary requests separately.
 */
function compactionAwareClient(
	usagePerTurn: readonly number[],
	summaries: readonly string[],
): {
	client: { stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> };
	mainRequests: IModelRequest[];
	summaryRequests: IModelRequest[];
} {
	const mainRequests: IModelRequest[] = [];
	const summaryRequests: IModelRequest[] = [];
	let summaryCount = 0;
	return {
		mainRequests,
		summaryRequests,
		client: {
			async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
				if (request.system.includes('anchored summary')) {
					summaryRequests.push(request);
					const text = summaries[summaryCount] ?? '';
					summaryCount += 1;
					if (text !== '') {
						yield { type: 'text_delta', text };
					}
					yield { type: 'message_stop', stopReason: 'end_turn' };
					return;
				}
				mainRequests.push(request);
				const index = mainRequests.length - 1;
				if (index < usagePerTurn.length) {
					yield { type: 'tool_use', block: { type: 'tool_use', id: `t${index + 1}`, name: 'big', input: { n: index + 1 } } };
					yield { type: 'usage', inputTokens: usagePerTurn[index]! };
					yield { type: 'message_stop', stopReason: 'tool_use' };
				} else {
					yield { type: 'text_delta', text: 'done' };
					yield { type: 'message_stop', stopReason: 'end_turn' };
				}
			},
		},
	};
}

function compactionEvents(events: readonly IAgentEvent[]): Extract<IAgentEvent, { type: 'compaction' }>[] {
	return events.filter((event): event is Extract<IAgentEvent, { type: 'compaction' }> => event.type === 'compaction');
}

test('compaction: usage over threshold folds the head into an anchored summary, incrementally', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// threshold = 100000 − 32000 − 16000 = 52000; usage crosses it on turn 1.
		const { client, mainRequests, summaryRequests } = compactionAwareClient([60_000, 80_000, 100_000], ['## Objective\n- compacted state', '## Objective\n- updated state']);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('map the repo')], {
				system: 'test system',
				tools: [bigTool],
				modelClient: client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);

		assert.equal(terminal.reason, 'completed');
		const compactions = compactionEvents(events);
		assert.deepEqual(
			compactions.map(event => event.outcome),
			['insufficient', 'ok', 'ok'],
			'turn 2 head too small; turn 3 creates the anchor; turn 4 updates it',
		);
		assert.ok(compactions.every(event => event.trigger === 'auto'));

		// First summary request: creation, serialized head, no previous anchor.
		assert.match(text(summaryRequests[0]!.messages[0]!), /Create a new anchored summary/);
		assert.match(text(summaryRequests[0]!.messages[0]!), /\[User\]:\nmap the repo/);
		// Second: anchored update fed the previous summary and ONLY the delta.
		const update = text(summaryRequests[1]!.messages[0]!);
		assert.match(update, /<previous-summary>\n## Objective\n- compacted state/);
		assert.match(update, /RESULT2/, 'delta contains the turn-2 result');
		assert.doesNotMatch(update, /RESULT1/, 'already-anchored content is not re-serialized');
		assert.doesNotMatch(update, /RESULT3/, 'tail content stays out of the summary');

		// The compacted view: summary user message first, then an intact tail pair.
		const compactedRequest = mainRequests[2]!;
		assert.match(text(compactedRequest.messages[0]!), /^\[Context compacted\]/);
		assert.match(text(compactedRequest.messages[0]!), /- compacted state/);
		assert.equal(compactedRequest.messages[1]!.role, 'assistant', 'tail starts on an assistant message');
		assert.doesNotMatch(JSON.stringify(compactedRequest.messages), /RESULT1/, 'summarized head is gone from the wire');
		const final = mainRequests[3]!;
		assert.match(text(final.messages[0]!), /- updated state/, 'view carries the updated anchor');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('compaction: preflight folds an oversized initial transcript before the first request', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const big = 'h'.repeat(120_000);
		const initial: IAgentMessage[] = [
			userMessage(`first question ${big}`),
			{ role: 'assistant', content: [{ type: 'text', text: `first answer ${big}` }] },
			userMessage('second question'),
			{ role: 'assistant', content: [{ type: 'text', text: `second answer ${big}` }] },
			userMessage('third question'),
		];
		const { client, mainRequests } = compactionAwareClient([], ['## Objective\n- from preflight']);
		const { events, terminal } = await drive(
			runAgentLoop(initial, {
				system: 'test system',
				tools: [bigTool],
				modelClient: client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);

		assert.equal(terminal.reason, 'completed');
		const [compaction] = compactionEvents(events);
		assert.ok(compaction, 'preflight compaction fired');
		assert.equal(compaction.trigger, 'preflight');
		assert.equal(compaction.outcome, 'ok');
		assert.match(text(mainRequests[0]!.messages[0]!), /- from preflight/);
		assert.equal(mainRequests[0]!.messages.length, 3, 'summary + last assistant + last user');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('compaction: fail-open on summary errors, off without a window, off via kill switch', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// Summary reply comes back empty → generateSummary throws → error outcome,
		// and the request goes out uncompacted.
		const failing = compactionAwareClient([60_000], ['']);
		const failed = await drive(
			runAgentLoop([userMessage('q')], {
				system: 's',
				tools: [bigTool],
				modelClient: failing.client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);
		assert.equal(failed.terminal.reason, 'completed');
		// Turn-2 attempt: boundary exists? messages [u, a1, r1] → head too small → insufficient.
		// So drive one more turn to reach a real error: use two tool turns instead.
		const failing2 = compactionAwareClient([60_000, 80_000], ['']);
		const failed2 = await drive(
			runAgentLoop([userMessage('q')], {
				system: 's',
				tools: [bigTool],
				modelClient: failing2.client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);
		const outcomes = compactionEvents(failed2.events).map(event => event.outcome);
		assert.ok(outcomes.includes('error'), `expected a fail-open error outcome, got ${outcomes.join(',')}`);
		assert.equal(failed2.terminal.reason, 'completed', 'the run survives the failed summary');
		const last = failing2.mainRequests[failing2.mainRequests.length - 1]!;
		assert.doesNotMatch(text(last.messages[0]!), /\[Context compacted\]/, 'view stayed uncompacted');

		// No compaction config → mechanism off even with huge usage.
		const off = compactionAwareClient([60_000, 80_000], []);
		const offRun = await drive(runAgentLoop([userMessage('q')], { system: 's', tools: [bigTool], modelClient: off.client as never, permissionGate: allowAllPermissionGate }));
		assert.equal(compactionEvents(offRun.events).length, 0);
		assert.equal(off.summaryRequests.length, 0);

		// Kill switch.
		process.env['MELLIVORA_COMPACTION'] = 'off';
		try {
			const killed = compactionAwareClient([60_000, 80_000], []);
			const killedRun = await drive(
				runAgentLoop([userMessage('q')], {
					system: 's',
					tools: [bigTool],
					modelClient: killed.client as never,
					permissionGate: allowAllPermissionGate,
					compaction: { contextWindow: 100_000 },
				}),
			);
			assert.equal(compactionEvents(killedRun.events).length, 0);
			assert.equal(killed.summaryRequests.length, 0);
		} finally {
			delete process.env['MELLIVORA_COMPACTION'];
		}
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('compaction: a restored anchor pre-seeds the view with ZERO summary calls, then updates incrementally', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// The covered assistant reply is bulky (15K) so that by turn 2 the 32K
		// tail budget (20K tool result + this reply) forces the boundary PAST it.
		const initial: IAgentMessage[] = [
			userMessage('old question'),
			{ role: 'assistant', content: [{ type: 'text', text: `old answer ${'x'.repeat(15_000)}` }] },
			userMessage('follow-up'),
		];
		// One tool turn with over-threshold usage so the anchor gets an
		// incremental top-up on turn 2; then a final text turn.
		const { client, mainRequests, summaryRequests } = compactionAwareClient([120_000], ['## Objective\n- topped up']);
		const { events, terminal } = await drive(
			runAgentLoop(initial, {
				system: 'test system',
				tools: [bigTool],
				modelClient: client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000, anchor: { summary: '## Objective\n- restored anchor', covered: 1, prefixChars: 0 } },
			}),
		);

		assert.equal(terminal.reason, 'completed');

		// Request 1: the view is compacted from the very first request, and no
		// summary call preceded it — the whole point of persistence.
		const first = mainRequests[0]!;
		assert.match(text(first.messages[0]!), /^\[Context compacted\]/);
		assert.match(text(first.messages[0]!), /- restored anchor/);
		assert.equal(first.messages[1]!.role, 'assistant', 'tail starts at the covered boundary');
		assert.doesNotMatch(JSON.stringify(first.messages), /old question/, 'covered head is off the wire');

		// Across the whole run exactly ONE summary call happened — the turn-2
		// incremental top-up. Restoring the anchor itself cost zero calls (the
		// first request already carried the persisted text, asserted above).
		const compactions = compactionEvents(events);
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0]!.outcome, 'ok');
		assert.equal(summaryRequests.length, 1);
		assert.match(text(summaryRequests[0]!.messages[0]!), /<previous-summary>\n## Objective\n- restored anchor/, 'the persisted anchor is the update base');
		assert.doesNotMatch(text(summaryRequests[0]!.messages[0]!), /old question/, 'already-covered history is not re-serialized');
		assert.match(text(mainRequests[1]!.messages[0]!), /- topped up/, 'the view carries the updated anchor');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('compaction trigger counts cache tokens — a cached prompt is still a full prompt', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// input_tokens alone (4K) is far under the 52K threshold; with the 116K
		// cache-read the true prompt is 120K — the trigger must fire.
		let mainCount = 0;
		const compactions: unknown[] = [];
		const client = {
			async *stream(): AsyncGenerator<IModelStreamEvent, void> {
				mainCount += 1;
				if (mainCount === 1) {
					yield { type: 'tool_use', block: { type: 'tool_use', id: 't1', name: 'big', input: { n: 1 } } };
					yield { type: 'usage', inputTokens: 4_000, cacheReadTokens: 116_000 };
					yield { type: 'message_stop', stopReason: 'tool_use' };
				} else {
					yield { type: 'text_delta', text: 'done' };
					yield { type: 'message_stop', stopReason: 'end_turn' };
				}
			},
		};
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('q')], {
				system: 's',
				tools: [bigTool],
				modelClient: client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);
		compactions.push(...compactionEvents(events));

		assert.equal(terminal.reason, 'completed');
		const [compaction] = compactionEvents(events);
		assert.ok(compaction, 'over-threshold cached prompt triggered a compaction attempt');
		assert.equal(compaction.beforeTokens, 120_000, 'the trigger base sums input + cache');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

// ---------------------------------------------------------------------------
// Context breakdown panel (data source)
// ---------------------------------------------------------------------------

function breakdownEvents(events: readonly IAgentEvent[]): Extract<IAgentEvent, { type: 'context_breakdown' }>[] {
	return events.filter((event): event is Extract<IAgentEvent, { type: 'context_breakdown' }> => event.type === 'context_breakdown');
}

test('context_breakdown: system segments come from config verbatim, tools/messages are measured from the actual view', async () => {
	delete process.env['MELLIVORA_TOOL_PRUNE'];
	const model = createScriptedModelClient([{ emit: [{ type: 'text', text: 'hi' }] }]);

	const { events, terminal } = await drive(
		runAgentLoop([userMessage('hello')], {
			system: 'ignored — systemBreakdown wins when present',
			systemBreakdown: { baseChars: 100, instructionsChars: 20, skillsChars: 10 },
			tools: [echoTool],
			modelClient: model,
			permissionGate: createApprovalPermissionGate(async () => false),
		}),
	);

	assert.equal(terminal.reason, 'completed');
	const [breakdown] = breakdownEvents(events);
	assert.ok(breakdown, 'expected a context_breakdown event');
	assert.equal(breakdown.turn, 1);
	assert.equal(breakdown.systemChars, 100, 'from systemBreakdown.baseChars, not config.system.length');
	assert.equal(breakdown.instructionsChars, 20);
	assert.equal(breakdown.skillsChars, 10);
	assert.equal(breakdown.toolsChars, JSON.stringify([toolSpec(echoTool)]).length, 'measured from the specs actually sent this turn');
	assert.equal(breakdown.messagesChars, JSON.stringify([{ type: 'text', text: 'hello' }]).length, 'the one user message, measured the same way selectBoundary measures');
	assert.equal(breakdown.compactedChars, 0, 'no compaction active');
	assert.equal(breakdown.prunedChars, 0, 'nothing prunable in a one-message view');
});

test('context_breakdown: without systemBreakdown, systemChars falls back to the full system string length', async () => {
	const model = createScriptedModelClient([{ emit: [{ type: 'text', text: 'hi' }] }]);
	const { events } = await drive(runAgentLoop([userMessage('hi')], { system: 'x'.repeat(250), tools: [], modelClient: model, permissionGate: allowAllPermissionGate }));
	const [breakdown] = breakdownEvents(events);
	assert.equal(breakdown!.systemChars, 250);
	assert.equal(breakdown!.instructionsChars, 0);
	assert.equal(breakdown!.skillsChars, 0);
	assert.equal(breakdown!.toolsChars, JSON.stringify([]).length, 'no tools, brake is "none" turn 1');
});

test('context_breakdown: a hard-brake turn reports zero tools, matching what is actually sent', async () => {
	// maxTurns=2 → hardBrakeTurn = max(1, floor(2*0.9)) = 1: turn 1 is already hard.
	const model = createScriptedModelClient([{ emit: [{ type: 'text', text: 'final answer' }] }]);
	const { events } = await drive(runAgentLoop([userMessage('go')], { system: 's', tools: [echoTool], modelClient: model, permissionGate: allowAllPermissionGate, maxTurns: 2 }));
	const [breakdown] = breakdownEvents(events);
	assert.equal(breakdown!.toolsChars, JSON.stringify([]).length, 'hard brake withholds tools from the request');
});

test('context_breakdown: compaction splits compactedChars out of messagesChars, and both survive prune', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client } = compactionAwareClient([60_000, 80_000, 100_000], ['## Objective\n- compacted state', '## Objective\n- updated state']);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('map the repo')], {
				system: 's',
				tools: [bigTool],
				modelClient: client as never,
				permissionGate: allowAllPermissionGate,
				compaction: { contextWindow: 100_000 },
			}),
		);
		assert.equal(terminal.reason, 'completed');

		const breakdowns = breakdownEvents(events);
		// Turn 1 (before any compaction attempt): nothing compacted yet.
		assert.equal(breakdowns[0]!.compactedChars, 0);
		// The turn right after the first ok compaction (turn 2, boundary=1): the
		// summary block is split out, and messagesChars is the tail alone.
		const compactedTurn = breakdowns.find(event => event.compactedChars > 0);
		assert.ok(compactedTurn, 'a later turn reports a non-zero compacted block once compaction lands');
		assert.ok(compactedTurn.messagesChars > 0, 'the verbatim tail is still counted separately');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('context_breakdown: prunedChars mirrors the tool_prune outcome for the same turn', async () => {
	delete process.env['MELLIVORA_REPLY_VERIFIER'];
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const bigResultTool = defineTool({
			name: 'big',
			description: 'd',
			inputSchema: { type: 'object' },
			isReadOnly: () => true,
			validateInput: input => ({ ok: true, value: input }),
			call: async input => ({ content: `R${(input as { n: number }).n}_${'y'.repeat(20_000)}` }),
		});
		let turnCount = 0;
		const client = {
			async *stream(): AsyncGenerator<IModelStreamEvent, void> {
				turnCount += 1;
				if (turnCount <= 4) {
					yield { type: 'tool_use', block: { type: 'tool_use', id: `t${turnCount}`, name: 'big', input: { n: turnCount } } };
					yield { type: 'message_stop', stopReason: 'tool_use' };
				} else {
					yield { type: 'text_delta', text: 'done' };
					yield { type: 'message_stop', stopReason: 'end_turn' };
				}
			},
		};
		const { events } = await drive(
			runAgentLoop([userMessage('go')], { system: 's', tools: [bigResultTool], modelClient: client as never, permissionGate: allowAllPermissionGate }),
		);
		const pruneTelemetry = events.filter((event): event is Extract<IAgentEvent, { type: 'tool_prune' }> => event.type === 'tool_prune');
		const breakdowns = breakdownEvents(events);
		assert.ok(pruneTelemetry.length > 0, 'enough 20K results accumulated to trigger pruning');
		const lastPruneChars = pruneTelemetry[pruneTelemetry.length - 1]!.prunedChars;
		const matchingBreakdown = breakdowns.find(event => event.prunedChars === lastPruneChars && lastPruneChars > 0);
		assert.ok(matchingBreakdown, `expected a context_breakdown with prunedChars=${lastPruneChars}, got [${breakdowns.map(b => b.prunedChars).join(',')}]`);
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('work digest: a run emits a cumulative digest seeded from the previous run', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// The previous run's digest rides in as an assistant turn.
		const priorDigest = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '<work-digest>\nRead: src/old.ts\n</work-digest>' }] };
		const { client } = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/new.ts' } }] },
			{ emit: [{ type: 'text', text: 'Done.' }] },
		]);
		const { events } = await drive(
			runAgentLoop([userMessage('follow-up'), priorDigest], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }),
		);

		const digest = workDigestEvent(events);
		assert.ok(digest, 'a work_digest event was emitted');
		// Cumulative: the seeded old.ts and this run's new.ts both appear.
		assert.match(digest.text, /src\/old\.ts/);
		assert.match(digest.text, /src\/new\.ts/);
		assert.equal(digest.filesRead, 2);
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('work digest: a purely conversational run emits none, letting the prior digest ride forward', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const priorDigest = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '<work-digest>\nRead: src/old.ts\n</work-digest>' }] };
		const { client } = capturingModelClient([{ emit: [{ type: 'text', text: 'Just answering, no tools.' }] }]);
		const { events } = await drive(
			runAgentLoop([userMessage('a question'), priorDigest], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(workDigestEvent(events), undefined, 'no digest re-emitted when the run did no tracked work');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('grounding nudge: quoting code with zero tool calls in a digest-seeded run forces one re-grounded turn', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const priorDigest = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '<work-digest>\nRead: src/old.ts\n</work-digest>' }] };
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'text', text: 'The bug is here:\n```java\nfoo.selectById(x);\n```' }] }, // answers from digest memory
			{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/old.ts' } }] }, // re-grounds after the nudge
			{ emit: [{ type: 'text', text: 'Corrected: the real call is different.' }] },
		]);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('why does the query fail'), priorDigest], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }),
		);

		assert.equal(terminal.reason, 'completed');
		assert.ok(terminal.turns >= 3, `expected a forced re-grounded turn, got ${terminal.turns}`);
		assert.ok(
			events.some(event => event.type === 'grounding_nudge'),
			'a grounding_nudge event was emitted',
		);
		assert.match(lastUserText(requests[1]!), /made no tool calls/, 'the nudge reminder was injected');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('grounding nudge: does NOT fire without a seeded digest (fresh session)', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client } = capturingModelClient([{ emit: [{ type: 'text', text: 'Example:\n```ts\nconst a = 1;\n```' }] }]);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('show me an example')], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.turns, 1, 'a fresh session answers code questions without a forced turn');
		assert.ok(!events.some(event => event.type === 'grounding_nudge'), 'no grounding_nudge emitted');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('grounding nudge: does NOT fire when the run actually read files or the reply has no code block', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const priorDigest = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '<work-digest>\nRead: src/old.ts\n</work-digest>' }] };
		// Grounded run: reads first, then quotes code — no nudge.
		const grounded = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/old.ts' } }] },
			{ emit: [{ type: 'text', text: 'Verified:\n```ts\nreal();\n```' }] },
		]);
		const groundedRun = await drive(
			runAgentLoop([userMessage('check the code'), priorDigest], { system: 's', tools: [readFileTool], modelClient: grounded.client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(groundedRun.terminal.turns, 2, 'a grounded run stops naturally');
		assert.ok(!groundedRun.events.some(event => event.type === 'grounding_nudge'), 'no nudge after real reads');

		// Prose-only reply: no code fence, nothing to misquote — no nudge.
		const prose = capturingModelClient([{ emit: [{ type: 'text', text: 'That depends on the runtime data; check the logs.' }] }]);
		const proseRun = await drive(
			runAgentLoop([userMessage('why is it slow'), priorDigest], { system: 's', tools: [readFileTool], modelClient: prose.client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(proseRun.terminal.turns, 1, 'a prose reply stops naturally');
		assert.ok(!proseRun.events.some(event => event.type === 'grounding_nudge'), 'no nudge for prose replies');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('stale-claim nudge: asserting a connection failure with no data-source call forces one real test', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'text', text: '数据库当前连不上（报 ETIMEDOUT），基于代码分析如下。' }] }, // claims failure from memory
			{ emit: [{ type: 'tool_use', id: 't1', name: 'query_data_source', input: { source: 's', sql: 'SELECT 1' } }] }, // actually tests
			{ emit: [{ type: 'text', text: '连接正常，查询结果如下。' }] },
		]);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('查一下表结构')], { system: 's', tools: [queryDataSourceStub], modelClient: client, permissionGate: allowAllPermissionGate }),
		);

		assert.equal(terminal.reason, 'completed');
		assert.ok(terminal.turns >= 3, `expected a forced test turn, got ${terminal.turns}`);
		assert.ok(
			events.some(event => event.type === 'stale_claim_nudge'),
			'a stale_claim_nudge event was emitted',
		);
		assert.match(lastUserText(requests[1]!), /did not call any data-source tool/, 'the nudge reminder was injected');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('stale-claim nudge: does NOT fire when the run tested the connection or made no failure claim', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		// Grounded: the run called the data-source tool before claiming failure.
		const grounded = capturingModelClient([
			{ emit: [{ type: 'tool_use', id: 't1', name: 'query_data_source', input: { source: 's', sql: 'SELECT 1' } }] },
			{ emit: [{ type: 'text', text: '连接失败：connect ETIMEDOUT（本轮实测）。' }] },
		]);
		const groundedRun = await drive(
			runAgentLoop([userMessage('查库')], { system: 's', tools: [queryDataSourceStub], modelClient: grounded.client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(groundedRun.terminal.turns, 2, 'a tested claim stops naturally');
		assert.ok(!groundedRun.events.some(event => event.type === 'stale_claim_nudge'), 'no nudge after a real test');

		// No failure claim in the reply — nothing to ground.
		const calm = capturingModelClient([{ emit: [{ type: 'text', text: '表结构如下……' }] }]);
		const calmRun = await drive(
			runAgentLoop([userMessage('查库')], { system: 's', tools: [queryDataSourceStub], modelClient: calm.client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(calmRun.terminal.turns, 1);
		assert.ok(!calmRun.events.some(event => event.type === 'stale_claim_nudge'), 'no nudge without a failure claim');

		// No data-source tools in the session — the claim cannot be tested, so no forced turn.
		const toolless = capturingModelClient([{ emit: [{ type: 'text', text: 'cannot connect to the database from here.' }] }]);
		const toollessRun = await drive(runAgentLoop([userMessage('查库')], { system: 's', tools: [echoTool], modelClient: toolless.client, permissionGate: allowAllPermissionGate }));
		assert.equal(toollessRun.terminal.turns, 1);
		assert.ok(!toollessRun.events.some(event => event.type === 'stale_claim_nudge'), 'no nudge when the tools are absent');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('work digest: MELLIVORA_WORK_DIGEST=off suppresses the event', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	process.env['MELLIVORA_WORK_DIGEST'] = 'off';
	try {
		const { client } = capturingModelClient([{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }] }, { emit: [{ type: 'text', text: 'Done.' }] }]);
		const { events } = await drive(runAgentLoop([userMessage('go')], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }));
		assert.equal(workDigestEvent(events), undefined, 'the kill switch suppresses the digest entirely');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
		delete process.env['MELLIVORA_WORK_DIGEST'];
	}
});

test('action-claim nudge: claiming completed actions with zero tool calls forces a do-or-retract turn', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = capturingModelClient([
			{ emit: [{ type: 'text', text: '## 完成小结\n部署成功，编译成功，服务已重启。' }] }, // fabricated completion
			{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'target' } }] }, // actually works after the nudge
			{ emit: [{ type: 'text', text: '现在真正执行了部署检查。' }] },
		]);
		const { events, terminal } = await drive(
			runAgentLoop([userMessage('重新部署到开发环境')], { system: 's', tools: [readFileTool], modelClient: client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(terminal.reason, 'completed');
		assert.ok(terminal.turns >= 3, `expected a forced turn, got ${terminal.turns}`);
		assert.ok(
			events.some(event => event.type === 'action_claim_nudge'),
			'an action_claim_nudge event was emitted',
		);
		assert.match(lastUserText(requests[1]!), /ZERO tool calls/, 'the nudge reminder was injected');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('action-claim nudge: does NOT fire when the run used tools or made no completion claim', async () => {
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const worked = capturingModelClient([{ emit: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] }, { emit: [{ type: 'text', text: '部署成功，服务已重启。' }] }]);
		const workedRun = await drive(runAgentLoop([userMessage('部署')], { system: 's', tools: [readFileTool], modelClient: worked.client, permissionGate: allowAllPermissionGate }));
		assert.equal(workedRun.terminal.turns, 2, 'a grounded completion claim stops naturally');
		assert.ok(!workedRun.events.some(event => event.type === 'action_claim_nudge'));

		const plain = capturingModelClient([{ emit: [{ type: 'text', text: '部署需要三步：备份、上传、重启。' }] }]);
		const plainRun = await drive(
			runAgentLoop([userMessage('怎么部署?')], { system: 's', tools: [readFileTool], modelClient: plain.client, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(plainRun.terminal.turns, 1, 'describing steps is not a completion claim');
		assert.ok(!plainRun.events.some(event => event.type === 'action_claim_nudge'));
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});

test('quota fast-stop settles as a resumable pause: the frozen transcript carries the unconsumed tool_result (#19 缺陷 2)', async () => {
	// Mirrors the agentIpc wiring: the shared-client wrapper flags the 403 and
	// aborts the run's signal; the loop's abort checkpoints settle as PAUSED.
	const controller = new AbortController();
	let quotaError: Error | undefined;
	let call = 0;
	const scripted = createScriptedModelClient([{ emit: [{ type: 'tool_use', id: 't1', name: 'echo', input: { text: '子代理报告' } }] }]);
	const client: IModelClient = {
		async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
			if (call++ === 0) {
				yield* scripted.stream(request);
				return;
			}
			// Turn 2: the quota wall. Wrapper behavior inlined.
			const error = new Error('Anthropic request failed: 403 {"error":{"type":"permission_error","message":"credits exhausted"}}');
			quotaError = error;
			controller.abort();
			throw error;
		},
	};

	const { terminal } = await drive(
		runAgentLoop([userMessage('梳理项目')], {
			system: 's',
			tools: [echoTool],
			modelClient: client,
			permissionGate: allowAllPermissionGate,
			signal: controller.signal,
			disableReplyVerifier: true,
			pauseOnExhaustion: { quotaHit: () => quotaError?.message },
		}),
	);

	assert.equal(terminal.reason, 'paused');
	assert.equal(terminal.paused?.cause, 'quota');
	assert.match(terminal.paused?.message ?? '', /403/);
	const frozen = terminal.paused?.frozenTranscript ?? [];
	// user → assistant(tool_use) → user(tool_result): the collected-but-unread
	// result is IN the freeze — the whole point of route b.
	assert.equal(frozen.length, 3);
	assert.equal(frozen[2]?.role, 'user');
	const lastBlock = frozen[2]?.content[0];
	assert.equal(lastBlock?.type, 'tool_result');
	assert.match((lastBlock as { content: string }).content, /子代理报告/);
});

test('429 pauses only after the retry ladder is exhausted — and only on a pausable (top-level) run (#19 缺陷 2)', async () => {
	const rateLimited: IModelClient = {
		// eslint-disable-next-line require-yield
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			throw new Error('Anthropic request failed: 429 rate limited');
		},
	};

	const pausable = await drive(
		runAgentLoop([userMessage('q')], {
			system: 's',
			tools: [],
			modelClient: rateLimited,
			permissionGate: allowAllPermissionGate,
			disableReplyVerifier: true,
			pauseOnExhaustion: { quotaHit: () => undefined },
			streamRetryBaseDelayMs: 1,
		}),
	);
	// The full ladder ran first: 9 retries announced, the 10th attempt pauses.
	assert.equal(pausable.events.filter(event => event.type === 'stream_retry').length, 9);
	assert.equal(pausable.terminal.reason, 'paused');
	assert.equal(pausable.terminal.paused?.cause, 'rate_limit');
	assert.equal(pausable.terminal.paused?.frozenTranscript.length, 1, 'nothing but the initial message — no partial turn leaks into the freeze');

	// A child loop (no pauseOnExhaustion) still THROWS on exhaustion — the
	// parent is the one that freezes, with the child's error result in view.
	await assert.rejects(
		drive(
			runAgentLoop([userMessage('q')], {
				system: 's',
				tools: [],
				modelClient: rateLimited,
				permissionGate: allowAllPermissionGate,
				disableReplyVerifier: true,
				streamRetryBaseDelayMs: 1,
			}),
		),
		/429/,
	);
});
