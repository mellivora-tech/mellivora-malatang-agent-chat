/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { isToolPruneEnabled, pruneToolOutputs } from '../../src/main/agent/toolOutputPrune.js';
import type { IAgentMessage } from '../../src/main/agent/agentTypes.js';

// Small budgets so the tests stay readable: protect 100 chars, quantum 50.
const OPTS = { protectChars: 100, quantumChars: 50 };

/** One tool turn: assistant asks, user answers with a result of `size` chars. */
function toolTurn(id: string, name: string, size: number): IAgentMessage[] {
	return [
		{ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { n: id } }] },
		{ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'x'.repeat(size), isError: false }] },
	];
}

function conversation(...turns: IAgentMessage[][]): IAgentMessage[] {
	return [{ role: 'user', content: [{ type: 'text', text: 'question' }] }, ...turns.flat()];
}

function resultContents(messages: readonly IAgentMessage[]): string[] {
	return messages.flatMap(message => message.content.filter(block => block.type === 'tool_result').map(block => (block as { content: string }).content));
}

test('under the threshold nothing changes — same references, zero counts', () => {
	const messages = conversation(toolTurn('t1', 'read_file', 60), toolTurn('t2', 'grep', 60));
	const outcome = pruneToolOutputs(messages, OPTS); // T=120, target=floor(20/50)*50=0
	assert.equal(outcome.prunedResults, 0);
	assert.equal(outcome.messages, messages, 'untouched input returned by reference');
});

test('quantization: the boundary only advances in quantum-sized steps', () => {
	// T=140 → over protect by 40 → still below one quantum → nothing pruned.
	const under = pruneToolOutputs(conversation(toolTurn('t1', 'read_file', 70), toolTurn('t2', 'grep', 70)), OPTS);
	assert.equal(under.prunedResults, 0);

	// T=210 → over by 110 → target=100 → the two oldest 70s fit (140>100? no:
	// cumulative 70 ≤ 100 prunes t1; 70+70=140 > 100 keeps t2).
	const over = pruneToolOutputs(conversation(toolTurn('t1', 'read_file', 70), toolTurn('t2', 'grep', 70), toolTurn('t3', 'bash', 70)), OPTS);
	assert.equal(over.prunedResults, 1);
	const contents = resultContents(over.messages);
	assert.match(contents[0]!, /\[pruned\] earlier read_file output \(70 chars\)/);
	assert.equal(contents[1], 'x'.repeat(70), 'the straddling block stays whole');
	assert.equal(contents[2], 'x'.repeat(70));
});

test('cache stability: growing within a quantum leaves the pruned set byte-identical', () => {
	const base = [toolTurn('t1', 'read_file', 70), toolTurn('t2', 'grep', 70), toolTurn('t3', 'bash', 70)];
	const first = pruneToolOutputs(conversation(...base), OPTS);
	// Add a small result that does NOT cross the next quantum step (T 210→240, target stays 100).
	const second = pruneToolOutputs(conversation(...base, toolTurn('t4', 'glob', 30)), OPTS);
	assert.equal(first.prunedResults, second.prunedResults);
	assert.deepEqual(resultContents(first.messages)[0], resultContents(second.messages)[0], 'stub bytes identical between steps');
});

test('monotonicity: once pruned, always pruned as the conversation grows', () => {
	const shortHistory = conversation(toolTurn('t1', 'read_file', 70), toolTurn('t2', 'grep', 70), toolTurn('t3', 'bash', 70));
	const longHistory = conversation(
		toolTurn('t1', 'read_file', 70),
		toolTurn('t2', 'grep', 70),
		toolTurn('t3', 'bash', 70),
		toolTurn('t4', 'glob', 70),
		toolTurn('t5', 'read_file', 70),
	);
	const before = pruneToolOutputs(shortHistory, OPTS);
	const after = pruneToolOutputs(longHistory, OPTS);
	assert.ok(after.prunedResults >= before.prunedResults, 'pruned set only grows');
	assert.match(resultContents(after.messages)[0]!, /\[pruned\]/, 't1 stays pruned');
});

test('the newest tool-result message is unconditionally protected, even a giant one', () => {
	// Giant current result pushes the small older ones out of the window.
	const messages = conversation(toolTurn('t1', 'read_file', 60), toolTurn('t2', 'grep', 60), toolTurn('t3', 'bash', 500));
	const outcome = pruneToolOutputs(messages, OPTS); // T=620 → target=floor(520/50)*50=500
	const contents = resultContents(outcome.messages);
	assert.match(contents[0]!, /\[pruned\]/);
	assert.match(contents[1]!, /\[pruned\]/);
	assert.equal(contents[2], 'x'.repeat(500), 'the freshly requested result is never stubbed');
	assert.equal(outcome.prunedResults, 2);
	assert.equal(outcome.prunedChars, 120);
});

test('isError survives pruning and the stub names the right tool', () => {
	const messages = conversation(
		[
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'bash', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'e1', content: 'x'.repeat(200), isError: true }] },
		],
		toolTurn('t2', 'grep', 200),
	);
	const outcome = pruneToolOutputs(messages, OPTS); // T=400 → target=300 → e1 (200) pruned; t2 protected (newest)
	const prunedBlock = outcome.messages.flatMap(m => m.content).find(b => b.type === 'tool_result' && b.content.includes('[pruned]'));
	assert.ok(prunedBlock && prunedBlock.type === 'tool_result');
	assert.equal(prunedBlock.isError, true, 'error flag preserved');
	assert.match(prunedBlock.content, /earlier bash output/);
});

test('messages without tool results pass through untouched', () => {
	const messages: IAgentMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'world' }] },
	];
	const outcome = pruneToolOutputs(messages, OPTS);
	assert.equal(outcome.messages, messages);
	assert.equal(outcome.prunedResults, 0);
});

test('kill switch: MELLIVORA_TOOL_PRUNE=off disables, anything else enables', () => {
	assert.equal(isToolPruneEnabled({ MELLIVORA_TOOL_PRUNE: 'off' }), false);
	assert.equal(isToolPruneEnabled({}), true);
});
