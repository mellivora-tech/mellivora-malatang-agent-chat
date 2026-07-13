/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicModelClient, AnthropicStreamAccumulator, buildAnthropicRequestBody, toAnthropicMessages } from '../../src/main/agent/anthropicModelClient.js';
import type { IAgentMessage, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';
import { createModelClient } from '../../src/main/agent/createModelClient.js';
import { OpenAIModelClient, OpenAIStreamAccumulator, buildOpenAIRequestBody, toOpenAIMessages } from '../../src/main/agent/openaiModelClient.js';
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

function findUsage(events: readonly IModelStreamEvent[]): Extract<IModelStreamEvent, { type: 'usage' }> | undefined {
	return events.find((candidate): candidate is Extract<IModelStreamEvent, { type: 'usage' }> => candidate.type === 'usage');
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

test('OpenAI accumulator reads real usage from the trailing (choice-less) chunk', () => {
	const events = runOpenAI([{ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } }]);
	const usage = findUsage(events);
	assert.ok(usage, 'expected a usage event');
	assert.equal(usage.inputTokens, 1234);
	assert.equal(usage.outputTokens, 5);
});

test('OpenAI accumulator omits usage when the provider never reports it', () => {
	const events = runOpenAI([{ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }]);
	assert.equal(findUsage(events), undefined, 'no usage chunk → no usage event, renderer falls back to its estimate');
});

test('openai request body asks for usage on the trailing stream chunk', () => {
	const body = buildOpenAIRequestBody({ baseURL: 'https://x/v1', model: 'm' }, { system: 's', messages: [], tools: [], signal: new AbortController().signal });
	assert.deepEqual(body['stream_options'], { include_usage: true });
});

test('toAnthropicMessages maps blocks to Anthropic content blocks', () => {
	const wire = toAnthropicMessages(conversation);
	assert.deepEqual(wire[2]?.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'echo: hi', is_error: false }]);
	assert.deepEqual(wire[1]?.content?.[1], { type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'hi' } });
});

test('Anthropic accumulator streams text and folds input_json_delta into one tool block', () => {
	const events = runAnthropic([
		{ type: 'message_start', message: { usage: { input_tokens: 500, output_tokens: 1 } } },
		{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me' } },
		{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"hi"}' } },
		{ type: 'content_block_stop', index: 1 },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
		{ type: 'message_stop' },
	]);

	assert.equal(textDeltas(events), 'Let me');
	const toolUse = firstToolUse(events);
	assert.equal(toolUse.block.id, 'toolu_1');
	assert.deepEqual(toolUse.block.input, { text: 'hi' });
	assert.equal(stopReason(events), 'tool_use');

	// message_start's input_tokens is the ground truth for this turn's prompt
	// size; message_delta's usage updates output_tokens as generation proceeds.
	const usage = findUsage(events);
	assert.ok(usage, 'expected a usage event');
	assert.equal(usage.inputTokens, 500);
	assert.equal(usage.outputTokens, 12);
});

test('Anthropic accumulator preserves thinking blocks with their signatures', () => {
	const events = runAnthropic([
		{ type: 'message_start' },
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'echo' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
		{ type: 'content_block_stop', index: 1 },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
		{ type: 'message_stop' },
	]);

	const thinkingBlock = events.find((event): event is Extract<IModelStreamEvent, { type: 'thinking_block' }> => event.type === 'thinking_block');
	assert.ok(thinkingBlock, 'a complete thinking block is emitted');
	assert.equal(thinkingBlock.block.thinking, 'let me reason');
	assert.equal(thinkingBlock.block.signature, 'sig-abc');
	// The block precedes the tool_use, mirroring stream order.
	assert.ok(events.findIndex(e => e.type === 'thinking_block') < events.findIndex(e => e.type === 'tool_use'));
	// UI streaming still gets the deltas.
	assert.equal(events.filter(e => e.type === 'thinking_delta').length, 2);
});

test('a thinking-only turn is an end_turn, not a tool_use stop', () => {
	const events = runAnthropic([
		{ type: 'message_start' },
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
		{ type: 'content_block_start', index: 1, content_block: { type: 'text' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
		{ type: 'message_stop' },
	]);
	assert.equal(stopReason(events), 'end_turn');
});

test('toAnthropicMessages passes thinking blocks back verbatim; toOpenAIMessages drops them', () => {
	const withThinking: readonly IAgentMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: 'q' }] },
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' },
				{ type: 'tool_use', id: 't1', name: 'echo', input: {} },
			],
		},
	];

	const anthropic = toAnthropicMessages(withThinking);
	assert.deepEqual(anthropic[1]?.content[0], { type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' });

	// A signature-less block (some compatible providers omit it) round-trips without the field.
	const noSig = toAnthropicMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]);
	assert.deepEqual(noSig[0]?.content[0], { type: 'thinking', thinking: 'x' });

	const openai = toOpenAIMessages('SYS', withThinking);
	assert.equal(JSON.stringify(openai).includes('private reasoning'), false, 'OpenAI wire has no thinking concept');
});

test('Anthropic accumulator omits usage when message_start carries none', () => {
	const events = runAnthropic([{ type: 'message_start' }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
	assert.equal(findUsage(events), undefined, 'no input_tokens → no usage event, renderer falls back to its estimate');
});

test('anthropic default max_tokens leaves room for thinking + text; params override wins', () => {
	const signal = new AbortController().signal;
	const request = { system: 's', messages: [], tools: [], signal };

	// 4096 was the old default — with extended thinking on, a long think could
	// consume it entirely and leave no visible text.
	const body = buildAnthropicRequestBody({ baseURL: 'https://x', model: 'm' }, request);
	assert.equal(body['max_tokens'], 32_000);

	const overridden = buildAnthropicRequestBody({ baseURL: 'https://x', model: 'm', params: { maxTokens: 8000 } }, request);
	assert.equal(overridden['max_tokens'], 8000);
});

test('anthropic thinking param: adaptive for the official API, enabled+budget for compat endpoints', () => {
	const signal = new AbortController().signal;
	const request = { system: 's', messages: [], tools: [], signal };

	const officialBody = buildAnthropicRequestBody({ baseURL: 'https://api.anthropic.com/v1', model: 'm', params: { thinking: true } }, request);
	assert.deepEqual(officialBody['thinking'], { type: 'adaptive' });

	// Kimi treats 'adaptive' as advisory and can still skip the thinking block,
	// leaking reasoning into visible text — 'enabled' forces the block.
	const compatBody = buildAnthropicRequestBody({ baseURL: 'https://api.kimi.com/coding/', model: 'm', params: { thinking: true } }, request);
	assert.deepEqual(compatBody['thinking'], { type: 'enabled', budget_tokens: 8192 });

	const offBody = buildAnthropicRequestBody({ baseURL: 'https://api.kimi.com/coding/', model: 'm' }, request);
	assert.equal(offBody['thinking'], undefined);
});

test('createModelClient picks the client class from the provider', () => {
	const base: Omit<IStoredModelConfig, 'provider'> = { id: 'm', label: 'M', baseURL: 'https://x/v1', model: 'm' };
	assert.ok(createModelClient({ ...base, provider: 'openai-compatible' }) instanceof OpenAIModelClient);
	assert.ok(createModelClient({ ...base, provider: 'anthropic' }) instanceof AnthropicModelClient);
});

test('openai request enables parallel_tool_calls when tools are present (batching)', () => {
	const config = { baseURL: 'https://x/v1', model: 'm' };
	const signal = new AbortController().signal;
	const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' as const } }];

	const withTools = buildOpenAIRequestBody(config, { system: 's', messages: [], tools, signal });
	assert.equal(withTools['parallel_tool_calls'], true, 'model is allowed to batch tool calls');
	assert.ok(Array.isArray(withTools['tools']));

	const noTools = buildOpenAIRequestBody(config, { system: 's', messages: [], tools: [], signal });
	assert.equal('parallel_tool_calls' in noTools, false, 'no tools → no parallel flag');
});

test('toAnthropicMessages maps image blocks to base64 sources', () => {
	const wire = toAnthropicMessages([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'what is this?' }] }]);
	assert.deepEqual(wire[0]!.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
	assert.deepEqual(wire[0]!.content[1], { type: 'text', text: 'what is this?' });
});

test('toOpenAIMessages maps an image-bearing user turn to a content array with a data URL', () => {
	const wire = toOpenAIMessages('SYS', [{ role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }, { type: 'text', text: 'describe' }] }]);
	const user = wire.find(message => message.role === 'user');
	assert.ok(Array.isArray(user?.content), 'images force the array content shape');
	assert.deepEqual(user.content[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } });
	assert.deepEqual(user.content[1], { type: 'text', text: 'describe' });
});

test('toOpenAIMessages keeps plain-string content for text-only user turns', () => {
	const wire = toOpenAIMessages('SYS', [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
	assert.equal(wire.find(message => message.role === 'user')?.content, 'hello');
});

test('Anthropic accumulator carries cache fields — input_tokens alone under-counts the prompt', () => {
	const events = runAnthropic([
		{ type: 'message_start', message: { usage: { input_tokens: 4_000, output_tokens: 1, cache_read_input_tokens: 116_000, cache_creation_input_tokens: 2_500 } } },
		{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
		{ type: 'message_stop' },
	]);
	const usage = findUsage(events);
	assert.ok(usage, 'expected a usage event');
	assert.equal(usage.inputTokens, 4_000);
	assert.equal(usage.outputTokens, 9);
	assert.equal(usage.cacheReadTokens, 116_000);
	assert.equal(usage.cacheWriteTokens, 2_500);
});
