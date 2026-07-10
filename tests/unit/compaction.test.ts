/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSummaryRequestText,
	compactionThreshold,
	estimateTokens,
	formatCompactedBlock,
	generateSummary,
	isCompactionEnabled,
	measurePrefixChars,
	restoreAnchor,
	selectBoundary,
	serializeForSummary,
} from '../../src/main/agent/compaction.js';
import type { IAgentMessage, IModelClient, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';

function user(text: string): IAgentMessage {
	return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantToolCall(id: string, text = ''): IAgentMessage {
	return {
		role: 'assistant',
		content: [...(text === '' ? [] : [{ type: 'text', text } as const]), { type: 'tool_use', id, name: 'read_file', input: { path: 'a.ts' } }],
	};
}

function toolResults(id: string, content: string): IAgentMessage {
	return { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content, isError: false }] };
}

test('compaction threshold math and the kill switch', () => {
	// 262144 − 32000 − 16000 = 214144 (the Kimi K2.7 worked example).
	assert.equal(compactionThreshold(262_144, 32_000), 214_144);
	// Default output budget is 32K.
	assert.equal(compactionThreshold(262_144), 214_144);
	// A tiny window yields a non-positive threshold — callers treat that as disabled.
	assert.ok(compactionThreshold(40_000) <= 0);

	assert.equal(isCompactionEnabled({}), true);
	assert.equal(isCompactionEnabled({ AGENT_CHAT_COMPACTION: 'off' }), false);
});

test('selectBoundary lands on an assistant message and never splits a tool pair', () => {
	const big = 'x'.repeat(10_000);
	const messages = [user('question'), assistantToolCall('t1'), toolResults('t1', big), assistantToolCall('t2'), toolResults('t2', big)];

	// Budget fits only the last pair (one result ≈10K, two ≈20K): the cut lands
	// on the assistant that owns it.
	const boundary = selectBoundary(messages, 15_000);
	assert.equal(boundary, 3);
	assert.equal(messages[boundary!]!.role, 'assistant');

	// Budget smaller than even the trailing tool_result: the cut must snap back
	// onto the last assistant rather than orphan the result (API 400 otherwise).
	const tight = selectBoundary(messages, 5_000);
	assert.equal(tight, 3, 'minimum tail = last assistant + its results, budget notwithstanding');
});

test('selectBoundary refuses heads too small to summarize', () => {
	const big = 'x'.repeat(10_000);
	// Head would be just the opening user message — nothing worth a model call.
	assert.equal(selectBoundary([user('question'), assistantToolCall('t1'), toolResults('t1', big)], 12_000), undefined);
	// No assistant message at all → no valid cut.
	assert.equal(selectBoundary([user('a'), user('b')], 1), undefined);
	// Everything fits in the tail → boundary 0 → nothing to fold.
	assert.equal(selectBoundary([user('q'), assistantToolCall('t1'), toolResults('t1', 'small')], 32_000), undefined);
});

test('serializeForSummary labels roles, truncates blocks, and drops thinking', () => {
	const messages: IAgentMessage[] = [
		user('find the bug'),
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'secret chain of thought' },
				{ type: 'text', text: 'looking' },
				{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'bug' } },
			],
		},
		{ role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'y'.repeat(3000), isError: true }] },
	];

	const serialized = serializeForSummary(messages);
	assert.match(serialized, /\[User\]:\nfind the bug/);
	assert.match(serialized, /\[Assistant\]:\nlooking/);
	assert.match(serialized, /\[Assistant tool call grep\]:\n\{"pattern":"bug"\}/);
	assert.match(serialized, /\[Tool result \(error\)\]:\ny+/);
	assert.match(serialized, /\[truncated\]/, 'oversized block clipped at 2000 chars');
	assert.doesNotMatch(serialized, /secret chain of thought/, 'thinking never reaches the summarizer');
});

test('serializeForSummary turns images into a placeholder instead of dropping them', () => {
	// A silently-dropped image taught the summarizer to anchor the false fact
	// "no image was provided" (seen live, 2026-07-10 session cd63ef17).
	const base64 = 'A'.repeat(80_000); // ~60KB raw
	const messages: IAgentMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: '梳理下这个图片' }, { type: 'image', mediaType: 'image/png', data: base64 }] },
	];

	const serialized = serializeForSummary(messages);
	assert.match(serialized, /\[User attached an image \(image\/png, ~59KB\) — it was shown to the assistant in this conversation\]/);
	assert.doesNotMatch(serialized, /AAAA/, 'base64 payload never reaches the summarizer');
});

test('summary request: create vs anchored update', () => {
	const create = buildSummaryRequestText('[User]:\nhi');
	assert.match(create, /Create a new anchored summary/);
	assert.doesNotMatch(create, /<previous-summary>/);

	const update = buildSummaryRequestText('[User]:\nhi', '## Objective\n- earlier state');
	assert.match(update, /Update the anchored summary below/);
	assert.match(update, /<previous-summary>\n## Objective\n- earlier state\n<\/previous-summary>/);
	assert.match(update, /merge in the new facts/);
});

test('generateSummary streams text and rejects an empty reply', async () => {
	const client = (events: IModelStreamEvent[]): IModelClient => ({
		async *stream() {
			yield* events;
		},
	});
	const signal = new AbortController().signal;

	const summary = await generateSummary({
		client: client([
			{ type: 'text_delta', text: '## Objective\n' },
			{ type: 'text_delta', text: '- ship 3.1' },
			{ type: 'message_stop', stopReason: 'end_turn' },
		]),
		serializedHead: '[User]:\nhi',
		signal,
	});
	assert.equal(summary, '## Objective\n- ship 3.1');

	await assert.rejects(
		() => generateSummary({ client: client([{ type: 'message_stop', stopReason: 'end_turn' }]), serializedHead: '[User]:\nhi', signal }),
		/empty/,
	);
});

test('formatCompactedBlock wraps the summary for the request view', () => {
	const block = formatCompactedBlock('## Objective\n- x');
	assert.match(block, /^\[Context compacted\]/);
	assert.match(block, /<summary>\n## Objective\n- x\n<\/summary>/);
});

test('restoreAnchor: three fail-closed gates, and acceptance on the exact match', () => {
	const messages: IAgentMessage[] = [
		user('q1'),
		{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
		user('q2'),
		{ role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
		user('q3'),
	];
	const prefixChars = measurePrefixChars(messages, 3);

	// Accepted: strict prefix, tail starts on an assistant, integrity matches.
	const ok = restoreAnchor(messages, { summary: '## Objective\n- x', covered: 3, prefixChars });
	assert.deepEqual(ok, { boundary: 3, summary: '## Objective\n- x' });

	// Gate 1 — range: zero, past-the-end, whole-transcript, non-integer.
	assert.equal(restoreAnchor(messages, { summary: 's', covered: 0, prefixChars: 0 }), undefined);
	assert.equal(restoreAnchor(messages, { summary: 's', covered: 5, prefixChars }), undefined);
	assert.equal(restoreAnchor(messages, { summary: 's', covered: 2.5, prefixChars }), undefined);

	// Gate 2 — role: tail starting on a user message would put two user
	// messages back to back (the anchor block is a user message).
	assert.equal(restoreAnchor(messages, { summary: 's', covered: 2, prefixChars: measurePrefixChars(messages, 2) }), undefined);

	// Gate 3 — integrity: covered history changed since the anchor was made.
	assert.equal(restoreAnchor(messages, { summary: 's', covered: 3, prefixChars: prefixChars + 1 }), undefined);
	// …and a blank summary is never restorable.
	assert.equal(restoreAnchor(messages, { summary: '  ', covered: 3, prefixChars }), undefined);
});

test('estimateTokens is the char/4 heuristic over the serialized transcript', () => {
	const messages = [user('x'.repeat(4000))];
	const estimate = estimateTokens(messages);
	assert.ok(estimate >= 1000 && estimate <= 1100, `~1000 tokens for 4000 chars, got ${estimate}`);
});
