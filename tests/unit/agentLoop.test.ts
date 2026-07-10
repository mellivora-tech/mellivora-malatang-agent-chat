/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentLoop } from '../../src/main/agent/agentLoop.js';
import { allowAllPermissionGate, createApprovalPermissionGate, defineTool } from '../../src/main/agent/agentTools.js';
import { createScriptedModelClient } from '../../src/main/agent/scriptedModelClient.js';
import type { IAgentEvent, IAgentMessage, IAgentTerminal, IModelRequest, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';

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
	delete process.env['AGENT_CHAT_LOOP_GUARD'];
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
	delete process.env['AGENT_CHAT_LOOP_GUARD'];
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
	delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
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

test('reply verifier: a passing judgment changes nothing', async () => {
	delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
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
	delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
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

test('reply verifier: AGENT_CHAT_REPLY_VERIFIER=off skips the judge entirely', async () => {
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off';
	try {
		const { client, requests } = sequenceClient(['some answer']);
		const { events } = await drive(runAgentLoop([userMessage('question?')], { system: 's', tools: [], modelClient: client as never, permissionGate: allowAllPermissionGate }));
		assert.equal(requests.length, 1, 'no judge call');
		assert.equal(
			events.some(event => event.type === 'reply_verifier'),
			false,
		);
	} finally {
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
	}
});

test('reply verifier: refusal and truncation terminals are never verified', async () => {
	delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
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
	delete process.env['AGENT_CHAT_TOOL_PRUNE'];
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off'; // isolate: no judge call at the end
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
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
	}
});

test('thinking blocks are preserved in the transcript and passed back on the next request', async () => {
	delete process.env['AGENT_CHAT_TOOL_PRUNE'];
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off';
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
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
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
function compactionAwareClient(usagePerTurn: readonly number[], summaries: readonly string[]): {
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
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off';
	try {
		// threshold = 100000 − 32000 − 16000 = 52000; usage crosses it on turn 1.
		const { client, mainRequests, summaryRequests } = compactionAwareClient(
			[60_000, 80_000, 100_000],
			['## Objective\n- compacted state', '## Objective\n- updated state'],
		);
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
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
	}
});

test('compaction: preflight folds an oversized initial transcript before the first request', async () => {
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off';
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
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
	}
});

test('compaction: fail-open on summary errors, off without a window, off via kill switch', async () => {
	process.env['AGENT_CHAT_REPLY_VERIFIER'] = 'off';
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
		const offRun = await drive(
			runAgentLoop([userMessage('q')], { system: 's', tools: [bigTool], modelClient: off.client as never, permissionGate: allowAllPermissionGate }),
		);
		assert.equal(compactionEvents(offRun.events).length, 0);
		assert.equal(off.summaryRequests.length, 0);

		// Kill switch.
		process.env['AGENT_CHAT_COMPACTION'] = 'off';
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
			delete process.env['AGENT_CHAT_COMPACTION'];
		}
	} finally {
		delete process.env['AGENT_CHAT_REPLY_VERIFIER'];
	}
});
