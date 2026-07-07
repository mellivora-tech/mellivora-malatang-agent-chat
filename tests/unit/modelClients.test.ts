/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicModelClient, AnthropicStreamAccumulator, toAnthropicMessages } from '../../src/main/agent/anthropicModelClient.js';
import type { IAgentMessage, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';
import { createModelClient } from '../../src/main/agent/createModelClient.js';
import { OpenAIModelClient, OpenAIStreamAccumulator, toOpenAIMessages } from '../../src/main/agent/openaiModelClient.js';
import type { IStoredModelConfig } from '../../src/main/modelConfigStorage.js';

function runOpenAI(chunks: readonly unknown[]): IModelStreamEvent[] {
	const accumulator = new OpenAIStreamAccumulator();
	const events: IModelStreamEvent[] = [];
	for (const chunk of chunks) {
		events.push(...accumulator.push(chunk));
	}
	events.push(...accumulator.finish());
	return events;
}

function runAnthropic(streamEvents: readonly unknown[]): IModelStreamEvent[] {
	const accumulator = new AnthropicStreamAccumulator();
	const events: IModelStreamEvent[] = [];
	for (const event of streamEvents) {
		events.push(...accumulator.push(event));
	}
	events.push(...accumulator.finish());
	return events;
}

function textDeltas(events: readonly IModelStreamEvent[]): string {
	return events
		.filter((event): event is Extract<IModelStreamEvent, { type: 'text_delta' }> => event.type === 'text_delta')
		.map(event => event.text)
		.join('');
}

function firstToolUse(events: readonly IModelStreamEvent[]): Extract<IModelStreamEvent, { type: 'tool_use' }> {
	const event = events.find((candidate): candidate is Extract<IModelStreamEvent, { type: 'tool_use' }> => candidate.type === 'tool_use');
	assert.ok(event, 'expected a tool_use event');
	return event;
}

function stopReason(events: readonly IModelStreamEvent[]): string {
	const event = events.find((candidate): candidate is Extract<IModelStreamEvent, { type: 'message_stop' }> => candidate.type === 'message_stop');
	assert.ok(event, 'expected a message_stop event');
	return event.stopReason;
}

const conversation: readonly IAgentMessage[] = [
	{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
	{
		role: 'assistant',
		content: [
			{ type: 'text', text: 'Let me check.' },
			{ type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'hi' } },
		],
	},
	{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'echo: hi', isError: false }] },
];

test('toOpenAIMessages maps tool_use to tool_calls and tool_result to a tool message', () => {
	const wire = toOpenAIMessages('SYS', conversation);
	assert.equal(wire[0]?.role, 'system');
	assert.equal(wire[1]?.role, 'user');

	const assistant = wire[2];
	assert.equal(assistant?.role, 'assistant');
	assert.equal(assistant?.content, 'Let me check.');
	assert.equal(assistant?.tool_calls?.[0]?.function.name, 'echo');
	assert.equal(assistant?.tool_calls?.[0]?.function.arguments, '{"text":"hi"}');

	const toolMessage = wire[3];
	assert.equal(toolMessage?.role, 'tool');
	assert.equal(toolMessage?.tool_call_id, 'tu1');
	assert.equal(toolMessage?.content, 'echo: hi');
});

test('OpenAI accumulator streams text and folds a split tool_call into one block', () => {
	const events = runOpenAI([
		{ choices: [{ delta: { content: 'Hello' } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, finish_reason: 'tool_calls' }] },
	]);

	assert.equal(textDeltas(events), 'Hello');
	const toolUse = firstToolUse(events);
	assert.equal(toolUse.block.id, 'call_1');
	assert.equal(toolUse.block.name, 'echo');
	assert.deepEqual(toolUse.block.input, { text: 'hi' });
	assert.equal(stopReason(events), 'tool_use');
});

test('OpenAI accumulator reports end_turn / max_tokens without tool calls', () => {
	assert.equal(stopReason(runOpenAI([{ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }])), 'end_turn');
	assert.equal(stopReason(runOpenAI([{ choices: [{ delta: {}, finish_reason: 'length' }] }])), 'max_tokens');
});

test('toAnthropicMessages maps blocks to Anthropic content blocks', () => {
	const wire = toAnthropicMessages(conversation);
	assert.deepEqual(wire[2]?.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'echo: hi', is_error: false }]);
	assert.deepEqual(wire[1]?.content?.[1], { type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'hi' } });
});

test('Anthropic accumulator streams text and folds input_json_delta into one tool block', () => {
	const events = runAnthropic([
		{ type: 'message_start' },
		{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me' } },
		{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"hi"}' } },
		{ type: 'content_block_stop', index: 1 },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
		{ type: 'message_stop' },
	]);

	assert.equal(textDeltas(events), 'Let me');
	const toolUse = firstToolUse(events);
	assert.equal(toolUse.block.id, 'toolu_1');
	assert.deepEqual(toolUse.block.input, { text: 'hi' });
	assert.equal(stopReason(events), 'tool_use');
});

test('createModelClient picks the client class from the provider', () => {
	const base: Omit<IStoredModelConfig, 'provider'> = { id: 'm', label: 'M', baseURL: 'https://x/v1', model: 'm' };
	assert.ok(createModelClient({ ...base, provider: 'openai-compatible' }) instanceof OpenAIModelClient);
	assert.ok(createModelClient({ ...base, provider: 'anthropic' }) instanceof AnthropicModelClient);
});
