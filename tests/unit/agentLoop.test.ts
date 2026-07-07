/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentLoop } from '../../src/main/agent/agentLoop.js';
import { allowAllPermissionGate, createApprovalPermissionGate, defineTool } from '../../src/main/agent/agentTools.js';
import { createScriptedModelClient } from '../../src/main/agent/scriptedModelClient.js';
import type { IAgentEvent, IAgentMessage, IAgentTerminal } from '../../src/main/agent/agentTypes.js';

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
