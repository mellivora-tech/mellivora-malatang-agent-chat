/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { agentLog, type AgentLogEvent, type IAgentLogSink } from '../../src/main/agent/observability/agentLog.js';
import { SLOW_CALL_MS, classifyError, instrumentHandler } from '../../src/main/ipcInstrument.js';

/** Capture what the wrapper emits; the bus fans out to every attached sink. */
function collect(): { events: AgentLogEvent[]; detach(): void } {
	const events: AgentLogEvent[] = [];
	const sink: IAgentLogSink = { write: event => void events.push(event) };
	agentLog.attach(sink);
	return { events, detach: () => agentLog.dispose() };
}

/** A clock the test drives, so "slow" needs no real waiting. */
function clock(elapsedMs: number): () => number {
	let calls = 0;
	return () => (calls++ === 0 ? 0 : elapsedMs);
}

test('instrumentHandler: a fast success is NOT logged (chatty channels must not drown the log)', async () => {
	const { events, detach } = collect();
	try {
		const run = instrumentHandler('git:branches', () => 'main', clock(5));
		assert.equal(await run(), 'main', 'the result passes through untouched');
		assert.deepEqual(events, [], 'a sub-threshold success emits nothing');
	} finally {
		detach();
	}
});

test('instrumentHandler: a slow success IS logged as a latency outlier', async () => {
	const { events, detach } = collect();
	try {
		const run = instrumentHandler('environments:runQuery', () => 'rows', clock(SLOW_CALL_MS));
		assert.equal(await run(), 'rows');
		assert.equal(events.length, 1);
		const event = events[0] as { type: string; channel: string; ok: boolean; durationMs: number; errorClass?: string };
		assert.equal(event.type, 'ipc');
		assert.equal(event.channel, 'environments:runQuery');
		assert.equal(event.ok, true);
		assert.equal(event.durationMs, SLOW_CALL_MS);
		assert.equal(event.errorClass, undefined, 'a success carries no error classification');
	} finally {
		detach();
	}
});

test('instrumentHandler: a rejection is logged AND re-thrown (the handler contract is untouched)', async () => {
	const { events, detach } = collect();
	try {
		const boom = new TypeError('provider refused the key');
		const run = instrumentHandler('models:verifyProvider', () => Promise.reject(boom), clock(12));
		await assert.rejects(run(), /provider refused the key/, 'the caller still sees the original error');

		assert.equal(events.length, 1, 'a failure always logs, however fast it was');
		const event = events[0] as { type: string; channel: string; ok: boolean; errorClass?: string; detail?: { message: string } };
		assert.equal(event.type, 'ipc');
		assert.equal(event.channel, 'models:verifyProvider');
		assert.equal(event.ok, false);
		assert.equal(event.errorClass, 'TypeError');
		assert.equal(event.detail?.message, 'provider refused the key', 'the message stays under local-only detail');
	} finally {
		detach();
	}
});

test('instrumentHandler: arguments reach the wrapped handler unchanged', async () => {
	const { events, detach } = collect();
	try {
		const run = instrumentHandler('sessions:append', (a: string, b: number) => `${a}:${b}`, clock(1));
		assert.equal(await run('session', 7), 'session:7');
		assert.deepEqual(events, [], 'instrumenting a fast, successful call stays entirely out of the log');
	} finally {
		detach();
	}
});

test('classifyError: names the error type without leaking the message', () => {
	assert.equal(classifyError(new TypeError('x')), 'TypeError');
	assert.equal(classifyError(new Error('x')), 'Error');
	assert.equal(classifyError('a bare string'), 'string');
	const named = new Error('x');
	named.name = 'AbortError';
	assert.equal(classifyError(named), 'AbortError', 'an aborted (timed-out) call is distinguishable from a crash');
});
