/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
