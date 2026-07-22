/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IRunLogEvent } from '../../src/sessions/services/logs/common/logs.js';
import { buildRunTimeline } from '../../src/sessions/browser/parts/runLogTimeline.js';

const T = '2026-07-22T08:00:00.000Z';

function events(...lines: Record<string, unknown>[]): IRunLogEvent[] {
	return lines.map(line => ({ ts: T, runId: 'r1', sessionId: 's1', ...line }) as unknown as IRunLogEvent);
}

test('buildRunTimeline: turns group, tools pair by toolUseId, totals and errors fold into the header', () => {
	const timeline = buildRunTimeline(
		events(
			{ type: 'run_start', build: 'abc123', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 4, detail: { prompt: '修个 bug' } },
			{ type: 'turn_start', turn: 1 },
			{ type: 'ttft', turn: 1, ttftMs: 420 },
			{ type: 'reasoning_stretch', turn: 1, kind: 'thinking', durationMs: 900, chars: 42, detail: { text: 'hmm…' } },
			{ type: 'tool_use', toolUseId: 't1', name: 'read_file', detail: { input: { path: 'a.ts' } } },
			{ type: 'tool_result', toolUseId: 't1', name: 'read_file', ok: true, durationMs: 12, outputBytes: 100, detail: { output: 'code' } },
			{ type: 'usage', turn: 1, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 9000 },
			{ type: 'turn_start', turn: 2 },
			{ type: 'tool_use', toolUseId: 't2', name: 'bash', detail: { input: { cmd: 'npm test' } } },
			{ type: 'tool_result', toolUseId: 't2', name: 'bash', ok: false, durationMs: 30, outputBytes: 20, detail: { output: 'boom' } },
			{ type: 'usage', turn: 2, inputTokens: 1200, outputTokens: 70, cacheReadTokens: 9100 },
			{ type: 'run_end', reason: 'completed', turns: 2, durationMs: 61_000 },
		),
	);

	assert.equal(timeline.header.model, 'kimi');
	assert.equal(timeline.header.permissionMode, 'ask');
	assert.equal(timeline.header.build, 'abc123');
	assert.equal(timeline.header.prompt, '修个 bug');
	assert.equal(timeline.header.reason, 'completed');
	assert.equal(timeline.header.turns, 2);
	assert.equal(timeline.header.totalOutputTokens, 120);
	assert.equal(timeline.header.peakPromptTokens, 1200 + 9100, 'true prompt size = input + cache');
	assert.equal(timeline.header.errorCount, 1, 'the failed bash call');
	assert.equal(timeline.header.boundariesOnly, false);

	// Boundaries live in the header, not the item list.
	assert.deepEqual(
		timeline.items.map(item => item.kind),
		['turn', 'stretch', 'tool', 'usage', 'turn', 'tool', 'usage'],
	);

	const firstTurn = timeline.items[0]!;
	assert.equal(firstTurn.turn, 1);
	assert.equal(firstTurn.ttftMs, 420, 'ttft folded onto its turn row');

	const read = timeline.items[2]!;
	assert.equal(read.tool?.name, 'read_file');
	assert.equal(read.tool?.ok, true);
	assert.equal(read.tool?.durationMs, 12);
	assert.ok(read.tool?.input?.includes('a.ts'), 'input pretty-printed onto the paired row');
	assert.equal(read.tool?.output, 'code');
	assert.equal(read.severity, undefined);

	const bash = timeline.items[5]!;
	assert.equal(bash.tool?.name, 'bash');
	assert.equal(bash.tool?.ok, false);
	assert.equal(bash.severity, 'error');
	assert.equal(bash.turn, 2);
});

test('buildRunTimeline: unknown event types become generic rows, never a throw', () => {
	const timeline = buildRunTimeline(events({ type: 'turn_start', turn: 1 }, { type: 'some_future_event', payload: { deeply: { nested: true } } }, { type: 'grounding_nudge' }));
	assert.deepEqual(
		timeline.items.map(item => [item.kind, item.type]),
		[
			['turn', 'turn_start'],
			['other', 'some_future_event'],
			['other', 'grounding_nudge'],
		],
	);
	assert.equal(timeline.items[1]?.severity, undefined);
	assert.ok(timeline.items[1]?.raw.includes('some_future_event'), 'raw JSON kept for the detail pane');
});

test('buildRunTimeline: failure-shaped generic rows carry error severity', () => {
	const timeline = buildRunTimeline(
		events(
			{ type: 'stream_retry', attempt: 2, maxAttempts: 10, delayMs: 2000 },
			{ type: 'compaction', trigger: 'auto', beforeTokens: 1, boundaryIndex: 0, summaryChars: 0, outcome: 'error' },
			{ type: 'compaction', trigger: 'auto', beforeTokens: 1, boundaryIndex: 0, summaryChars: 5, outcome: 'ok' },
			{ type: 'reply_verifier', verdict: 'fail', retried: true },
			{ type: 'error', where: 'run', detail: { message: 'model exploded' } },
		),
	);
	assert.deepEqual(
		timeline.items.map(item => item.severity ?? 'none'),
		['error', 'error', 'none', 'error', 'error'],
	);
	assert.equal(timeline.header.errorCount, 4);
	assert.equal(timeline.items[4]?.message, 'model exploded');
});

test('buildRunTimeline: an errors-mode run (boundaries only) is flagged for the notice', () => {
	const timeline = buildRunTimeline(
		events({ type: 'run_start', build: 'dev', model: 'kimi', mode: 'ask', hasWorkspace: false, toolCount: 0 }, { type: 'run_end', reason: 'completed', turns: 1, durationMs: 900 }),
	);
	assert.equal(timeline.header.boundariesOnly, true);
	assert.equal(timeline.items.length, 0);
	assert.equal(timeline.header.errorCount, 0);
});

test('buildRunTimeline: a lone failing tool_result (errors-mode log) renders standalone with the failure kept', () => {
	// In errors mode the tool_use never reached disk — only the failing result did.
	const timeline = buildRunTimeline(
		events(
			{ type: 'run_start', build: 'dev', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 1 },
			{ type: 'tool_result', toolUseId: 'tX', name: 'bash', ok: false, durationMs: 5, outputBytes: 9, detail: { output: 'exit 1' } },
			{ type: 'run_end', reason: 'completed', turns: 1, durationMs: 900 },
		),
	);
	assert.equal(timeline.header.boundariesOnly, false);
	assert.equal(timeline.items.length, 1);
	assert.equal(timeline.items[0]?.kind, 'tool');
	assert.equal(timeline.items[0]?.severity, 'error');
	assert.equal(timeline.items[0]?.tool?.output, 'exit 1');
	assert.equal(timeline.header.errorCount, 1);
});

test('buildRunTimeline: empty input yields an empty, non-throwing model', () => {
	const timeline = buildRunTimeline([]);
	assert.equal(timeline.items.length, 0);
	assert.equal(timeline.header.errorCount, 0);
	assert.equal(timeline.header.boundariesOnly, true);
});
