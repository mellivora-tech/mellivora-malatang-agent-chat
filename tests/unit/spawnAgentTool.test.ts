/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSpawnAgentTool } from '../../src/main/agent/tools/spawnAgentTool.js';
import { createScriptedModelClient } from '../../src/main/agent/scriptedModelClient.js';
import { runAgentLoop } from '../../src/main/agent/agentLoop.js';
import { allowAllPermissionGate } from '../../src/main/agent/agentTools.js';
import type { IAgentEvent } from '../../src/main/agent/agentTypes.js';

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'spawn-agent-'));
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'a.ts'), 'export const A = 1;\n');
	writeFileSync(join(root, 'src', 'b.ts'), 'export const B = 2;\n');
	return root;
}

const CALL_CONTEXT = { toolUseId: 'tu-spawn', signal: new AbortController().signal };

test('spawn_agent: child conclusion comes back with usage trailer and the child digest block', async () => {
	const root = workspace();
	const events: unknown[] = [];
	const tool = createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([
			{ emit: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } }] },
			{ emit: [{ type: 'text', text: 'Found: A is defined at src/a.ts:1.' }] },
		]),
		model: 'test-model',
		record: event => events.push(event),
	});

	const result = await tool.call({ task: 'find where A is defined; answer with file:line' }, CALL_CONTEXT);

	assert.ok(!result.isError, `expected success, got: ${result.content}`);
	assert.match(result.content, /A is defined at src\/a\.ts:1/);
	assert.match(result.content, /<subagent-usage>turns=\d+ tool_calls=1 tokens=\d+<\/subagent-usage>/);
	// The child read src/a.ts → its digest block rides the result for the parent to fold in.
	assert.match(result.content, /<work-digest>[\s\S]*src\/a\.ts[\s\S]*<\/work-digest>/);
	assert.deepEqual(
		events.map(event => (event as { type: string }).type),
		// The conclusion turn streams text → one liveness report (#19 缺陷 1).
		['subagent_start', 'subagent_tool', 'subagent_progress', 'subagent_end'],
	);
	const start = events[0] as { model: string };
	assert.equal(start.model, 'test-model', 'subagent_start records the wire model the child actually ran on');
	const progress = events[1] as { agentId: string; name: string; summary: string; turn: number };
	assert.equal(progress.name, 'read_file');
	assert.match(progress.summary, /read_file src\/a\.ts/);
	assert.equal(progress.agentId, 'tu-spawn', 'agentId is the spawning toolUseId');
	const end = events[3] as { reason: string; toolCalls: number; outputChars: number };
	assert.equal(end.reason, 'completed');
	assert.equal(end.toolCalls, 1);
	assert.ok(end.outputChars > 0);
});

test('spawn_agent: streaming folds into subagent_progress — one report per phase entry, repeats throttled, tool calls reset the phase (#19 缺陷 1)', async () => {
	const root = workspace();
	const events: Array<{ type: string; phase?: string; chars?: number }> = [];
	const tool = createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([
			// Turn 1: narrates, then calls a tool — the narration gets ONE report,
			// and the tool call hands the live label back to the tool row.
			{ emit: [{ type: 'text', text: 'scanning…' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } }] },
			// Turn 2: the long-report shape — two deltas back to back. Entry
			// reports immediately; the second lands inside the throttle window.
			{ emit: [{ type: 'text', text: 'Report part one. ' }, { type: 'text', text: 'Part two.' }] },
		]),
		model: 'test-model',
		record: event => events.push(event as { type: string; phase?: string; chars?: number }),
	});

	const result = await tool.call({ task: 'anything' }, CALL_CONTEXT);

	assert.ok(!result.isError);
	assert.deepEqual(
		events.map(event => event.type),
		['subagent_start', 'subagent_progress', 'subagent_tool', 'subagent_progress', 'subagent_end'],
	);
	const [narration, report] = events.filter(event => event.type === 'subagent_progress');
	assert.equal(narration?.phase, 'replying');
	assert.equal(narration?.chars, 'scanning…'.length);
	// The tool call between the phases reset the counter — turn 2's report
	// counts only its own first chunk, and its second chunk was throttled.
	assert.equal(report?.phase, 'replying');
	assert.equal(report?.chars, 'Report part one. '.length);
});

test('spawn_agent: anti-recursion is structural — a child calling spawn_agent gets an error result, not a grandchild', async () => {
	const root = workspace();
	const tool = createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([
			{ emit: [{ type: 'tool_use', id: 'c1', name: 'spawn_agent', input: { task: 'delegate again' } }] },
			{ emit: [{ type: 'text', text: 'Done without delegation.' }] },
		]),
		model: 'test-model',
	});

	const result = await tool.call({ task: 'anything' }, CALL_CONTEXT);

	// The child loop survives (unknown tool → error tool_result fed back), and no
	// nested sub-agent ever ran — the tool simply is not in the child's set.
	assert.ok(!result.isError);
	assert.match(result.content, /Done without delegation/);
});

test('spawn_agent: an empty child conclusion is an error result, and abort maps to isError', async () => {
	const root = workspace();
	const silent = createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([{ emit: [] }]),
		model: 'test-model',
	});
	const empty = await silent.call({ task: 'anything' }, CALL_CONTEXT);
	assert.ok(empty.isError);
	assert.match(empty.content, /no conclusions/);

	const controller = new AbortController();
	controller.abort();
	const aborted = await createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([{ emit: [{ type: 'text', text: 'never delivered' }] }]),
		model: 'test-model',
	}).call({ task: 'anything' }, { toolUseId: 'tu', signal: controller.signal });
	assert.ok(aborted.isError);
	assert.match(aborted.content, /aborted/i);
});

test('parent loop folds a sub-agent digest block from the tool_result into its own work digest', async () => {
	const root = workspace();
	const spawnTool = createSpawnAgentTool({
		roots: [root],
		modelClient: createScriptedModelClient([
			{ emit: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/b.ts' } }] },
			{ emit: [{ type: 'text', text: 'B lives at src/b.ts:1.' }] },
		]),
		model: 'test-model',
	});
	// Parent: delegates, then concludes. The parent itself reads nothing.
	const parentClient = createScriptedModelClient([
		{ emit: [{ type: 'tool_use', id: 'p1', name: 'spawn_agent', input: { task: 'find B' } }] },
		{ emit: [{ type: 'text', text: 'B is at src/b.ts:1 (per sub-agent).' }] },
	]);
	process.env['MELLIVORA_REPLY_VERIFIER'] = 'off';
	try {
		const events: IAgentEvent[] = [];
		const loop = runAgentLoop([{ role: 'user', content: [{ type: 'text', text: 'where is B?' }] }], {
			system: 's',
			tools: [spawnTool],
			modelClient: parentClient,
			permissionGate: allowAllPermissionGate,
		});
		let step = await loop.next();
		while (!step.done) {
			events.push(step.value);
			step = await loop.next();
		}
		assert.equal(step.value.reason, 'completed');
		const digest = events.find((event): event is Extract<IAgentEvent, { type: 'work_digest' }> => event.type === 'work_digest');
		assert.ok(digest, 'parent emitted a work digest');
		assert.match(digest.text, /src\/b\.ts/, 'the file the CHILD read is in the PARENT digest');
	} finally {
		delete process.env['MELLIVORA_REPLY_VERIFIER'];
	}
});
