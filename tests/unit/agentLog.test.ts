/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBufferedWriter } from '../../src/main/agent/observability/bufferedWriter.js';
import { agentLog, toExportable, type AgentLogEvent, type IAgentLogSink } from '../../src/main/agent/observability/agentLog.js';
import { createJsonlFileSink, isFullModeForced, resolveAgentLogsDir } from '../../src/main/agent/observability/jsonlFileSink.js';
import { createRunLogger } from '../../src/main/agent/observability/runLogger.js';

function collectingSink(): { sink: IAgentLogSink; events: AgentLogEvent[] } {
	const events: AgentLogEvent[] = [];
	return { events, sink: { write: event => void events.push(event) } };
}

const runStart: AgentLogEvent = {
	ts: 't',
	runId: 'r',
	sessionId: 's',
	type: 'run_start',
	build: 'dev',
	model: 'm',
	mode: 'ask',
	hasWorkspace: true,
	toolCount: 4,
	detail: { cwd: '/secret/path' },
};

test('bufferedWriter batches then flushes; dispose drains', () => {
	const chunks: string[] = [];
	const writer = createBufferedWriter({ writeFn: content => chunks.push(content), flushIntervalMs: 10_000 });
	writer.write('a\n');
	writer.write('b\n');
	assert.deepEqual(chunks, [], 'buffered, not written yet');
	writer.dispose();
	assert.deepEqual(chunks, ['a\nb\n'], 'dispose flushed the batch');
});

test('bufferedWriter immediate mode writes each line through', () => {
	const chunks: string[] = [];
	const writer = createBufferedWriter({ writeFn: content => chunks.push(content), immediate: true });
	writer.write('a\n');
	writer.write('b\n');
	assert.deepEqual(chunks, ['a\n', 'b\n']);
});

test('a throwing writeFn never propagates', () => {
	const writer = createBufferedWriter({
		writeFn: () => {
			throw new Error('disk full');
		},
		immediate: true,
	});
	assert.doesNotThrow(() => writer.write('x\n'));
});

test('agentLog queues events until a sink attaches, then drains in order', async () => {
	// Import a fresh module instance so the singleton queue is clean.
	const { agentLog } = await import(`../../src/main/agent/observability/agentLog.js?fresh=${Date.now()}`);
	agentLog.emit(runStart);
	agentLog.emit({ ...runStart, type: 'turn_start', turn: 1 } as AgentLogEvent);

	const first = collectingSink();
	agentLog.attach(first.sink);
	assert.deepEqual(
		first.events.map((event: AgentLogEvent) => event.type),
		['run_start', 'turn_start'],
		'queued events replay to the first sink',
	);

	// Subsequent emits fan out to all attached sinks.
	const second = collectingSink();
	agentLog.attach(second.sink);
	agentLog.emit({ ...runStart, type: 'run_end', reason: 'completed', turns: 1, durationMs: 5 } as AgentLogEvent);
	assert.equal(first.events.at(-1)?.type, 'run_end');
	assert.equal(second.events.at(-1)?.type, 'run_end');
});

test('a sink that throws does not break emit for other sinks', async () => {
	const { agentLog } = await import(`../../src/main/agent/observability/agentLog.js?fresh=${Date.now()}`);
	const good = collectingSink();
	agentLog.attach({
		write: () => {
			throw new Error('sink boom');
		},
	});
	agentLog.attach(good.sink);
	assert.doesNotThrow(() => agentLog.emit(runStart));
	assert.equal(good.events.length, 1, 'the healthy sink still received the event');
});

test('toExportable strips local-only detail but keeps safe fields', () => {
	const exported = toExportable(runStart);
	assert.equal('detail' in exported, false, 'detail dropped');
	assert.equal(exported.type, 'run_start');
	assert.equal((exported as { model: string }).model, 'm', 'safe fields kept');
	// Events without detail pass through unchanged.
	const turn: AgentLogEvent = { ts: 't', runId: 'r', sessionId: 's', type: 'turn_start', turn: 2 };
	assert.equal(toExportable(turn), turn);
});

test('runLogger maps a loop event stream into structured events with timings', () => {
	// runLogger emits to the canonical agentLog, so attach the sink there.
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r1', sessionId: 's1', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 4, cwd: '/repo', projectId: 'p1' });
	logger.record({ type: 'turn_start', turn: 1 });
	logger.record({ type: 'assistant_delta', text: 'answering…' }); // first token → ttft
	logger.record({ type: 'assistant_delta', text: ' more' }); // no second ttft; same stretch
	// The tool call closes the open 'text' stretch (→ reasoning_stretch) before tool_use.
	logger.record({ type: 'tool_use', toolUseId: 't1', name: 'read_file', input: { path: 'src/a.ts' } });
	logger.record({ type: 'tool_result', toolUseId: 't1', content: 'file contents', isError: false });
	logger.record({ type: 'stream_retry', attempt: 1, maxAttempts: 10, delayMs: 1000 });
	logger.end({ reason: 'completed', turns: 1 });

	const types = collected.events.map((event: AgentLogEvent) => event.type);
	assert.deepEqual(types, ['run_start', 'turn_start', 'ttft', 'reasoning_stretch', 'tool_use', 'tool_result', 'stream_retry', 'run_end']);

	const stretch = collected.events.find((event: AgentLogEvent) => event.type === 'reasoning_stretch') as Extract<AgentLogEvent, { type: 'reasoning_stretch' }>;
	assert.equal(stretch.kind, 'text');
	assert.equal(stretch.turn, 1);
	assert.equal(stretch.chars, 'answering… more'.length);
	assert.equal(stretch.detail?.text, 'answering… more');

	const runStartEvent = collected.events[0] as Extract<AgentLogEvent, { type: 'run_start' }>;
	assert.equal(runStartEvent.model, 'kimi');
	assert.deepEqual(runStartEvent.detail, { cwd: '/repo', projectId: 'p1' });

	const toolResult = collected.events.find((event: AgentLogEvent) => event.type === 'tool_result') as Extract<AgentLogEvent, { type: 'tool_result' }>;
	assert.equal(toolResult.name, 'read_file', 'tool name carried from tool_use');
	assert.equal(toolResult.ok, true);
	assert.equal(toolResult.outputBytes, 'file contents'.length);
	assert.ok(typeof toolResult.durationMs === 'number');
	assert.equal(toolResult.detail?.output, 'file contents');

	const ttft = collected.events.find((event: AgentLogEvent) => event.type === 'ttft') as Extract<AgentLogEvent, { type: 'ttft' }>;
	assert.equal(ttft.turn, 1);
	assert.ok(typeof ttft.ttftMs === 'number' && ttft.ttftMs >= 0);
});

test('runLogger maps usage and compaction events (summary text under detail only)', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r6', sessionId: 's6', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 1, contextWindow: 256_000 });
	logger.record({ type: 'turn_start', turn: 2 });
	logger.record({ type: 'usage', inputTokens: 208_984, outputTokens: 512 });
	logger.record({ type: 'compaction', trigger: 'preflight', beforeTokens: 208_984, boundaryIndex: 3, summaryChars: 12, outcome: 'ok', summary: '## Objective' });
	logger.end({ reason: 'completed', turns: 2 });

	const runStart = collected.events[0] as Extract<AgentLogEvent, { type: 'run_start' }>;
	assert.equal(runStart.contextWindow, 256_000);

	const usage = collected.events.find((event: AgentLogEvent) => event.type === 'usage') as Extract<AgentLogEvent, { type: 'usage' }>;
	assert.ok(usage, 'usage reached the bus — logs can now answer estimate-vs-actual');
	assert.equal(usage.turn, 2);
	assert.equal(usage.inputTokens, 208_984);
	assert.equal(usage.outputTokens, 512);

	const compaction = collected.events.find((event: AgentLogEvent) => event.type === 'compaction') as Extract<AgentLogEvent, { type: 'compaction' }>;
	assert.equal(compaction.outcome, 'ok');
	assert.equal(compaction.beforeTokens, 208_984);
	assert.equal(compaction.detail?.summary, '## Objective');
	// The PII boundary strips the summary text from any off-machine export.
	const exported = toExportable(compaction);
	assert.equal((exported as { detail?: unknown }).detail, undefined);
	assert.equal((exported as { summaryChars: number }).summaryChars, 12);
});

test('runLogger maps a loop_guard event onto the log bus with its repeat count', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r3', sessionId: 's3', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 1 });
	logger.record({ type: 'turn_start', turn: 1 });
	logger.record({ type: 'loop_guard', toolUseId: 't9', name: 'grep', repeatCount: 3 });
	logger.end({ reason: 'completed', turns: 1 });

	const guard = collected.events.find((event: AgentLogEvent) => event.type === 'loop_guard') as Extract<AgentLogEvent, { type: 'loop_guard' }>;
	assert.ok(guard, 'loop_guard event reached the bus');
	assert.equal(guard.name, 'grep');
	assert.equal(guard.repeatCount, 3);
	assert.equal(guard.toolUseId, 't9');
});

test('runLogger maps a reply_verifier event with its verdict; the reason stays under detail', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r4', sessionId: 's4', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 0 });
	logger.record({ type: 'turn_start', turn: 1 });
	logger.record({ type: 'reply_verifier', verdict: 'fail', retried: true, reason: 'wrong topic' });
	logger.end({ reason: 'completed', turns: 2 });

	const verifier = collected.events.find((event: AgentLogEvent) => event.type === 'reply_verifier') as Extract<AgentLogEvent, { type: 'reply_verifier' }>;
	assert.ok(verifier, 'reply_verifier event reached the bus');
	assert.equal(verifier.verdict, 'fail');
	assert.equal(verifier.retried, true);
	assert.equal(verifier.detail?.reason, 'wrong topic');
	// Export safety: stripping detail keeps verdict/retried.
	const exported = toExportable(verifier);
	assert.equal('detail' in exported, false);
	assert.equal((exported as { verdict: string }).verdict, 'fail');
});

test('runLogger records injected project instructions on run_start detail', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	createRunLogger({
		runId: 'r6',
		sessionId: 's6',
		model: 'kimi',
		mode: 'full',
		hasWorkspace: true,
		toolCount: 8,
		cwd: '/repo',
		instructions: { file: 'AGENTS.md', chars: 1854, truncated: false },
	});

	const started = collected.events.find((event: AgentLogEvent) => event.type === 'run_start') as Extract<AgentLogEvent, { type: 'run_start' }>;
	assert.deepEqual(started.detail?.instructions, { file: 'AGENTS.md', chars: 1854, truncated: false });
	// Export safety unchanged: detail (with the file name) strips off.
	const exported = toExportable(started);
	assert.equal('detail' in exported, false);
});

test('runLogger maps a tool_prune event with its counts', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r5', sessionId: 's5', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 3 });
	logger.record({ type: 'turn_start', turn: 5 });
	logger.record({ type: 'tool_prune', prunedResults: 2, prunedChars: 40_000 });
	logger.end({ reason: 'completed', turns: 5 });

	const prune = collected.events.find((event: AgentLogEvent) => event.type === 'tool_prune') as Extract<AgentLogEvent, { type: 'tool_prune' }>;
	assert.ok(prune, 'tool_prune event reached the bus');
	assert.equal(prune.prunedResults, 2);
	assert.equal(prune.prunedChars, 40_000);
});

test('runLogger maps a context_breakdown event with all its char counts, no detail field', () => {
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r7', sessionId: 's7', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 2 });
	logger.record({ type: 'turn_start', turn: 3 });
	logger.record({
		type: 'context_breakdown',
		turn: 3,
		systemChars: 1200,
		instructionsChars: 300,
		skillsChars: 80,
		toolsChars: 2100,
		messagesChars: 7400,
		compactedChars: 500,
		prunedChars: 900,
	});
	logger.end({ reason: 'completed', turns: 3 });

	const breakdown = collected.events.find((event: AgentLogEvent) => event.type === 'context_breakdown') as Extract<AgentLogEvent, { type: 'context_breakdown' }>;
	assert.ok(breakdown, 'context_breakdown event reached the bus');
	assert.equal(breakdown.turn, 3);
	assert.equal(breakdown.systemChars, 1200);
	assert.equal(breakdown.instructionsChars, 300);
	assert.equal(breakdown.skillsChars, 80);
	assert.equal(breakdown.toolsChars, 2100);
	assert.equal(breakdown.messagesChars, 7400);
	assert.equal(breakdown.compactedChars, 500);
	assert.equal(breakdown.prunedChars, 900);
	// Purely numeric — nothing to strip for the PII boundary, no detail at all.
	assert.equal('detail' in breakdown, false);
	assert.equal(toExportable(breakdown), breakdown);
});

test('runLogger captures reasoning that resumes after the model has already started answering', () => {
	// The renderer's own step bookkeeping can only close a 'thinking' step once
	// per turn (on the FIRST visible-text delta); a model that keeps reasoning
	// after that point gets silently absorbed there. runLogger tracks every
	// kind switch independently, so this is the ground truth for that question.
	const collected = collectingSink();
	agentLog.attach(collected.sink);

	const logger = createRunLogger({ runId: 'r2', sessionId: 's2', model: 'kimi', mode: 'ask', hasWorkspace: true, toolCount: 0 });
	logger.record({ type: 'turn_start', turn: 1 });
	logger.record({ type: 'thinking_delta', text: 'first I should check the schema. ' });
	logger.record({ type: 'assistant_delta', text: 'Based on the design, ' });
	logger.record({ type: 'thinking_delta', text: 'actually let me reconsider the column mapping. ' });
	logger.record({ type: 'assistant_delta', text: 'the viewCode decouples grouping from the real company.' });
	logger.end({ reason: 'completed', turns: 1 });

	const stretches = collected.events.filter((event: AgentLogEvent) => event.type === 'reasoning_stretch') as Extract<AgentLogEvent, { type: 'reasoning_stretch' }>[];
	assert.deepEqual(
		stretches.map(s => s.kind),
		['thinking', 'text', 'thinking', 'text'],
		'kind switches are captured in order, including thinking resuming after text had already started',
	);
	assert.equal(stretches[0]?.detail?.text, 'first I should check the schema. ');
	assert.equal(stretches[2]?.detail?.text, 'actually let me reconsider the column mapping. ');
	assert.equal(stretches[3]?.detail?.text, 'the viewCode decouples grouping from the real company.');
});

test('jsonl file sink appends events and links latest.jsonl', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mmac-log-'));
	const sink = createJsonlFileSink(dir, { immediate: true });
	sink.write(runStart);
	sink.write({
		ts: 't',
		runId: 'r',
		sessionId: 's',
		type: 'tool_result',
		toolUseId: 'x',
		name: 'read_file',
		ok: true,
		durationMs: 3,
		outputBytes: 10,
		detail: { output: 'hello' },
	});
	sink.dispose?.();

	const date = new Date().toISOString().slice(0, 10);
	const file = join(dir, `${date}.jsonl`);
	const lines = readFileSync(file, 'utf8').trim().split('\n');
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[0]!).type, 'run_start');
	assert.equal(JSON.parse(lines[1]!).detail.output, 'hello', 'local sink keeps full detail');

	const link = join(dir, 'latest.jsonl');
	assert.ok(lstatSync(link).isSymbolicLink(), 'latest.jsonl is a symlink');
	assert.equal(readlinkSync(link), file);
});

test('jsonl file sink rolls over at midnight and re-points latest.jsonl', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mmac-log-roll-'));
	let now = new Date('2026-07-21T23:59:59.000Z');
	const sink = createJsonlFileSink(dir, { immediate: true, now: () => now });

	sink.write(runStart);
	now = new Date('2026-07-22T00:00:01.000Z');
	sink.write({ ...runStart, type: 'run_end', reason: 'completed', turns: 1, durationMs: 2000 } as AgentLogEvent);
	sink.dispose?.();

	const before = readFileSync(join(dir, '2026-07-21.jsonl'), 'utf8').trim().split('\n');
	const after = readFileSync(join(dir, '2026-07-22.jsonl'), 'utf8').trim().split('\n');
	assert.equal(JSON.parse(before[0]!).type, 'run_start', 'pre-midnight write landed in the old day');
	assert.equal(JSON.parse(after[0]!).type, 'run_end', 'post-midnight write rolled to the new day');
	assert.equal(readlinkSync(join(dir, 'latest.jsonl')), join(dir, '2026-07-22.jsonl'), 'symlink follows the rollover');
});

test('resolveAgentLogsDir always yields a directory; env vars force full mode', () => {
	// The dir no longer gates logging — errors-only is the floor, not "off".
	assert.equal(resolveAgentLogsDir('/data', {}), join('/data', 'logs'));
	assert.equal(resolveAgentLogsDir('/data', { MELLIVORA_LOG_DIR: '/elsewhere' }), '/elsewhere');

	assert.equal(isFullModeForced({}), false);
	assert.equal(isFullModeForced({ MELLIVORA_DEBUG: '0' }), false);
	assert.equal(isFullModeForced({ MELLIVORA_DEBUG: 'false' }), false);
	assert.equal(isFullModeForced({ MELLIVORA_DEBUG: '1' }), true);
	assert.equal(isFullModeForced({ MELLIVORA_LOG_DIR: '/elsewhere' }), true);
});
