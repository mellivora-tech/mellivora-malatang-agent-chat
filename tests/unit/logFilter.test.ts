/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLogEvent, IAgentLogSink } from '../../src/main/agent/observability/agentLog.js';
import { createModeFilteredSink, isErrorClassEvent, type LoggingMode } from '../../src/main/agent/observability/logFilter.js';

const base = { ts: 't', runId: 'r', sessionId: 's' } as const;

/** Every event type, in both polarities where the predicate is conditional. */
const cases: readonly { readonly event: AgentLogEvent; readonly kept: boolean }[] = [
	// Unconditional failures
	{ event: { ...base, type: 'error', where: 'run', detail: { message: 'boom' } }, kept: true },
	{ event: { ts: 't', type: 'renderer_error', scope: 'sessions.title' }, kept: true },
	{ event: { ts: 't', type: 'main_error', scope: 'artifacts.captureOnAppend' }, kept: true },
	{ event: { ts: 't', type: 'storage_degraded', store: 'models', reason: 'unparseable' }, kept: true },
	{ event: { ...base, type: 'stream_retry', attempt: 1, maxAttempts: 10, delayMs: 1000 }, kept: true },
	{ event: { ...base, type: 'loop_guard', toolUseId: 'x', name: 'grep', repeatCount: 3 }, kept: true },
	// Conditional
	{ event: { ts: 't', type: 'ipc', channel: 'git:branches', ok: false, durationMs: 3, errorClass: 'Error' }, kept: true },
	{ event: { ts: 't', type: 'ipc', channel: 'git:branches', ok: true, durationMs: 1500 }, kept: false },
	{ event: { ...base, type: 'tool_result', toolUseId: 'x', name: 'bash', ok: false, durationMs: 5, outputBytes: 10 }, kept: true },
	{ event: { ...base, type: 'tool_result', toolUseId: 'x', name: 'bash', ok: true, durationMs: 5, outputBytes: 10 }, kept: false },
	{ event: { ...base, type: 'hooks_loaded', loaded: 1, dropped: 0, corrupt: true }, kept: true },
	{ event: { ...base, type: 'hooks_loaded', loaded: 1, dropped: 2, corrupt: false }, kept: true },
	{ event: { ...base, type: 'hooks_loaded', loaded: 3, dropped: 0, corrupt: false }, kept: false },
	{ event: { ...base, type: 'hook', event: 'preToolUse', hookId: 'h', decision: 'allow', failOpen: true }, kept: true },
	{ event: { ...base, type: 'hook', event: 'preToolUse', hookId: 'h', decision: 'allow' }, kept: false },
	{ event: { ...base, type: 'reply_verifier', verdict: 'fail', retried: true }, kept: true },
	{ event: { ...base, type: 'reply_verifier', verdict: 'error', retried: false }, kept: true },
	{ event: { ...base, type: 'reply_verifier', verdict: 'pass', retried: false }, kept: false },
	{ event: { ...base, type: 'compaction', trigger: 'auto', beforeTokens: 1, boundaryIndex: 0, summaryChars: 0, outcome: 'error' }, kept: true },
	{ event: { ...base, type: 'compaction', trigger: 'auto', beforeTokens: 1, boundaryIndex: 0, summaryChars: 9, outcome: 'ok' }, kept: false },
	{ event: { ...base, type: 'compaction', trigger: 'auto', beforeTokens: 1, boundaryIndex: 0, summaryChars: 0, outcome: 'insufficient' }, kept: false },
	// Attribution anchors
	{ event: { ...base, type: 'run_start', build: 'dev', model: 'm', mode: 'ask', hasWorkspace: true, toolCount: 1 }, kept: true },
	{ event: { ...base, type: 'run_end', reason: 'completed', turns: 1, durationMs: 5 }, kept: true },
	// Telemetry — full mode only
	{ event: { ...base, type: 'turn_start', turn: 1 }, kept: false },
	{ event: { ...base, type: 'ttft', turn: 1, ttftMs: 100 }, kept: false },
	{ event: { ...base, type: 'reasoning_stretch', turn: 1, kind: 'text', durationMs: 5, chars: 3 }, kept: false },
	{ event: { ...base, type: 'tool_use', toolUseId: 'x', name: 'grep' }, kept: false },
	{ event: { ...base, type: 'usage', turn: 1, inputTokens: 10 }, kept: false },
	{
		event: {
			...base,
			type: 'context_breakdown',
			turn: 1,
			systemChars: 1,
			instructionsChars: 0,
			skillsChars: 0,
			toolsChars: 0,
			messagesChars: 0,
			compactedChars: 0,
			prunedChars: 0,
		},
		kept: false,
	},
	{ event: { ...base, type: 'tool_prune', prunedResults: 1, prunedChars: 10 }, kept: false },
	{ event: { ...base, type: 'compaction_anchor', covered: 1, summaryChars: 2, accepted: true }, kept: false },
	{ event: { ...base, type: 'work_digest', filesRead: 1, filesWritten: 0, toolCalls: 2 }, kept: false },
	{ event: { ...base, type: 'grounding_nudge' }, kept: false },
	{ event: { ...base, type: 'stale_claim_nudge' }, kept: false },
	{ event: { ...base, type: 'action_claim_nudge' }, kept: false },
	{ event: { ...base, type: 'subagent_start', agentId: 'a', model: 'test-model' }, kept: false },
	{ event: { ...base, type: 'subagent_tool', agentId: 'a', name: 'grep', turn: 1 }, kept: false },
	{ event: { ...base, type: 'subagent_progress', agentId: 'a', phase: 'thinking', chars: 5 }, kept: false },
	{ event: { ...base, type: 'subagent_end', agentId: 'a', reason: 'completed', turns: 1, toolCalls: 2, tokens: 10, outputChars: 5 }, kept: false },
	{ event: { ...base, type: 'tool_progress', toolUseId: 'x', name: 'sftp' }, kept: false },
];

test('isErrorClassEvent keeps failures (and run boundaries) and drops telemetry', () => {
	for (const { event, kept } of cases) {
		assert.equal(isErrorClassEvent(event), kept, `${event.type}${'ok' in event ? ` ok=${String(event.ok)}` : ''} expected kept=${kept}`);
	}
});

function collectingSink(): { sink: IAgentLogSink; events: AgentLogEvent[]; flushes: number[] } {
	const events: AgentLogEvent[] = [];
	const flushes: number[] = [];
	return {
		events,
		flushes,
		sink: { write: event => void events.push(event), flush: () => void flushes.push(events.length) },
	};
}

test('createModeFilteredSink: full passes everything, errors only error-class, flips apply mid-stream', () => {
	const inner = collectingSink();
	let mode: LoggingMode = 'errors';
	const sink = createModeFilteredSink(inner.sink, () => mode);

	const telemetry: AgentLogEvent = { ...base, type: 'turn_start', turn: 1 };
	const failure: AgentLogEvent = { ...base, type: 'error', where: 'run' };

	sink.write(telemetry);
	sink.write(failure);
	assert.deepEqual(
		inner.events.map(event => event.type),
		['error'],
		'errors mode drops telemetry, keeps failures',
	);

	// The toggle flips the closure — the very next write obeys the new mode.
	mode = 'full';
	sink.write(telemetry);
	assert.deepEqual(
		inner.events.map(event => event.type),
		['error', 'turn_start'],
		'full mode passes telemetry with no re-attach',
	);

	mode = 'errors';
	sink.write(telemetry);
	assert.equal(inner.events.length, 2, 'back to errors mode on the next write');

	sink.flush?.();
	assert.equal(inner.flushes.length, 1, 'flush forwards to the inner sink');
});
