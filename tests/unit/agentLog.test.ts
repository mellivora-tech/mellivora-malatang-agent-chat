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
import { createJsonlFileSink } from '../../src/main/agent/observability/jsonlFileSink.js';
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
