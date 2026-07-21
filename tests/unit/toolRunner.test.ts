/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { allowAllPermissionGate, defineTool } from '../../src/main/agent/agentTools.js';
import type { IAgentEvent, IToolResultBlock, IToolUseBlock } from '../../src/main/agent/agentTypes.js';
import { executeToolUses } from '../../src/main/agent/toolRunner.js';

async function drain(toolUses: readonly IToolUseBlock[], tools: Parameters<typeof executeToolUses>[1]): Promise<{ events: IAgentEvent[]; results: IToolResultBlock[] }> {
	const generator = executeToolUses(toolUses, tools, allowAllPermissionGate, new AbortController().signal);
	const events: IAgentEvent[] = [];
	let step = await generator.next();
	while (!step.done) {
		events.push(step.value);
		step = await generator.next();
	}
	return { events, results: step.value };
}

function use(id: string, name: string, input: unknown = {}): IToolUseBlock {
	return { type: 'tool_use', id, name, input };
}

test('concurrency-safe runs execute together; results keep call order even when the first is slowest', async () => {
	let active = 0;
	let peakActive = 0;
	const delays: Record<string, number> = { a: 40, b: 5 };
	const safeTool = defineTool({
		name: 'safe',
		description: 'concurrency-safe test tool',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => ({ ok: true, value: input }),
		call: async input => {
			active += 1;
			peakActive = Math.max(peakActive, active);
			await new Promise(resolve => setTimeout(resolve, delays[(input as { key: string }).key] ?? 0));
			active -= 1;
			return { content: `done:${(input as { key: string }).key}` };
		},
	});

	const { results } = await drain([use('t1', 'safe', { key: 'a' }), use('t2', 'safe', { key: 'b' })], [safeTool]);

	assert.equal(peakActive, 2, 'both calls were in flight at once');
	// 'b' finished first, but the result order matches the tool_use order.
	assert.deepEqual(
		results.map(result => result.content),
		['done:a', 'done:b'],
	);
});

test('an unsafe tool splits the batch and runs serially between safe runs', async () => {
	const order: string[] = [];
	const makeTool = (name: string, safe: boolean) =>
		defineTool({
			name,
			description: name,
			inputSchema: { type: 'object' },
			isReadOnly: () => true,
			isConcurrencySafe: () => safe,
			validateInput: input => ({ ok: true, value: input }),
			call: async input => {
				order.push(`${name}:${(input as { id: string }).id}:start`);
				await new Promise(resolve => setTimeout(resolve, 5));
				order.push(`${name}:${(input as { id: string }).id}:end`);
				return { content: 'ok' };
			},
		});
	const safe = makeTool('safe', true);
	const unsafe = makeTool('unsafe', false);

	const { results } = await drain([use('t1', 'safe', { id: '1' }), use('t2', 'unsafe', { id: '2' }), use('t3', 'safe', { id: '3' })], [safe, unsafe]);

	assert.equal(results.length, 3);
	// The unsafe call must fully finish before the following safe call starts.
	const unsafeEnd = order.indexOf('unsafe:2:end');
	const lastSafeStart = order.indexOf('safe:3:start');
	assert.ok(unsafeEnd !== -1 && unsafeEnd < lastSafeStart, `serial boundary violated: ${order.join(' → ')}`);
});

test('a concurrent batch emits every tool_use up front, then results in call order (#15: long members stay visible from start)', async () => {
	const safeTool = defineTool({
		name: 'safe',
		description: 'safe',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => ({ ok: true, value: input }),
		call: async input => ({ content: String((input as { n: number }).n) }),
	});

	const { events } = await drain([use('t1', 'safe', { n: 1 }), use('t2', 'safe', { n: 2 }), use('t3', 'safe', { n: 3 })], [safeTool]);

	const flow = events.map(event => (event.type === 'tool_use' ? `u${event.toolUseId}` : event.type === 'tool_result' ? `r${event.toolUseId}` : event.type));
	assert.deepEqual(flow, ['ut1', 'ut2', 'ut3', 'rt1', 'rt2', 'rt3']);
});

test("tool_result events carry each call's OWN runtime — a fast call behind a slow one is not billed the wait", async () => {
	const delays: Record<string, number> = { slow: 80, fast: 5 };
	const safeTool = defineTool({
		name: 'safe',
		description: 'safe',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => ({ ok: true, value: input }),
		call: async input => {
			await new Promise(resolve => setTimeout(resolve, delays[(input as { key: string }).key] ?? 0));
			return { content: (input as { key: string }).key };
		},
	});

	const { events } = await drain([use('t1', 'safe', { key: 'slow' }), use('t2', 'safe', { key: 'fast' })], [safeTool]);

	const durations = new Map(events.filter(event => event.type === 'tool_result').map(event => [event.toolUseId, event.durationMs ?? -1]));
	// t2 finished in ~5ms but its event is EMITTED after t1's (~80ms) — the
	// measured runtime must reflect the 5ms, not the ordered-emission wait.
	assert.ok((durations.get('t1') ?? 0) >= 70, `slow call runtime recorded (${durations.get('t1')}ms)`);
	assert.ok((durations.get('t2') ?? 99) < 60, `fast call not billed the wait (${durations.get('t2')}ms)`);
});

test('the batch concurrency cap bounds in-flight calls without changing result order', async () => {
	process.env['MELLIVORA_TOOL_CONCURRENCY'] = '2';
	try {
		let active = 0;
		let peakActive = 0;
		const safeTool = defineTool({
			name: 'safe',
			description: 'safe',
			inputSchema: { type: 'object' },
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			validateInput: input => ({ ok: true, value: input }),
			call: async input => {
				active += 1;
				peakActive = Math.max(peakActive, active);
				await new Promise(resolve => setTimeout(resolve, 15));
				active -= 1;
				return { content: String((input as { n: number }).n) };
			},
		});

		const { results } = await drain([use('t1', 'safe', { n: 1 }), use('t2', 'safe', { n: 2 }), use('t3', 'safe', { n: 3 }), use('t4', 'safe', { n: 4 })], [safeTool]);

		assert.equal(peakActive, 2, 'no more than the cap in flight');
		assert.deepEqual(
			results.map(result => result.content),
			['1', '2', '3', '4'],
		);
	} finally {
		delete process.env['MELLIVORA_TOOL_CONCURRENCY'];
	}
});

// --- PreToolUse fire-point + W4 live-system hook (design §10 M2) -----------------

import type { IHook } from '../../src/main/agent/hooks/hooks.js';
import { createLiveSystemNudgeHook } from '../../src/main/agent/hooks/builtinHooks.js';

function drainWithHooks(toolUses: readonly IToolUseBlock[], tools: Parameters<typeof executeToolUses>[1], preToolHooks: readonly IHook[]): Promise<IToolResultBlock[]> {
	return (async () => {
		const generator = executeToolUses(toolUses, tools, allowAllPermissionGate, new AbortController().signal, undefined, preToolHooks);
		let step = await generator.next();
		while (!step.done) {
			step = await generator.next();
		}
		return step.value;
	})();
}

const echoTool = defineTool({
	name: 'echo',
	description: 'echoes its input',
	inputSchema: { type: 'object' },
	isReadOnly: () => true,
	isConcurrencySafe: () => false,
	validateInput: input => ({ ok: true, value: input }),
	call: async input => ({ content: JSON.stringify(input) }),
});

test('PreToolUse hook: block → the call becomes an error result; the tool never runs', async () => {
	let ran = false;
	const tool = { ...echoTool, call: async () => ((ran = true), { content: 'ran' }) };
	const blocker: IHook = { id: 'b', event: 'PreToolUse', run: () => ({ decision: 'block', reason: 'blocked by discipline' }) };
	const results = await drainWithHooks([use('t1', 'echo', { x: 1 })], [tool], [blocker]);
	assert.equal(results[0]!.isError, true);
	assert.match(results[0]!.content, /blocked by discipline/);
	assert.equal(ran, false, 'a blocked PreToolUse call skips execution');
});

test('PreToolUse hook: modify → the tool receives the chained input', async () => {
	const modifier: IHook = { id: 'm', event: 'PreToolUse', run: () => ({ decision: 'modify', modifiedInput: { x: 99 } }) };
	const results = await drainWithHooks([use('t1', 'echo', { x: 1 })], [echoTool], [modifier]);
	assert.match(results[0]!.content, /"x":99/, 'the tool saw the hook-modified input, not the original');
});

test('W4 live-system hook: injects the quiescence reminder onto the FIRST query_data_source result, once per run', async () => {
	const qds = defineTool({
		name: 'query_data_source',
		description: 'runs a query',
		inputSchema: { type: 'object' },
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		validateInput: input => ({ ok: true, value: input }),
		call: async () => ({ content: 'count: 9842' }),
	});
	const hook = createLiveSystemNudgeHook();
	const results = await drainWithHooks([use('q1', 'query_data_source', { sql: 'a' }), use('q2', 'query_data_source', { sql: 'b' })], [qds], [hook]);
	assert.match(results[0]!.content, /count: 9842/, 'the query still ran (inject, not block)');
	assert.match(results[0]!.content, /concurrent writer|STABLE snapshot/, 'the reminder rides the first result');
	assert.doesNotMatch(results[1]!.content, /concurrent writer/, 'once per run — the second query is clean');
});

test('W4 live-system hook: does not touch non-matching tools (toolMatcher)', async () => {
	const hook = createLiveSystemNudgeHook();
	const results = await drainWithHooks([use('t1', 'echo', { x: 1 })], [echoTool], [hook]);
	assert.doesNotMatch(results[0]!.content, /concurrent writer/, 'echo is not query_data_source — the matcher filters the hook out');
});
