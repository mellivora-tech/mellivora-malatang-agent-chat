/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listRuns, readRunEvents } from '../../src/main/agent/observability/logReader.js';
import { RUNS_INDEX_FILE } from '../../src/main/agent/observability/runIndexSink.js';

async function createLogsDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'mmac-logreader-'));
}

function indexLine(fields: Record<string, unknown>): string {
	return `${JSON.stringify(fields)}\n`;
}

test('listRuns folds start/end pairs, tolerates a start-only (crashed) run, filters and limits', async () => {
	const dir = await createLogsDir();
	try {
		await writeFile(
			join(dir, RUNS_INDEX_FILE),
			indexLine({ kind: 'start', runId: 'r1', sessionId: 'sA', ts: '2026-07-21T08:00:00.000Z', date: '2026-07-21', model: 'kimi', permissionMode: 'ask', loggingMode: 'full' }) +
				indexLine({ kind: 'end', runId: 'r1', ts: '2026-07-21T08:01:00.000Z', date: '2026-07-21', reason: 'completed', turns: 3, durationMs: 60_000 }) +
				'{ torn line\n' +
				indexLine({ kind: 'start', runId: 'r2', sessionId: 'sB', ts: '2026-07-22T09:00:00.000Z', date: '2026-07-22', model: 'k3', loggingMode: 'errors' }) +
				// An end with no start (index truncated mid-history) is unlistable.
				indexLine({ kind: 'end', runId: 'r0', ts: '2026-07-20T00:00:00.000Z', date: '2026-07-20', reason: 'completed' }),
			'utf8',
		);

		const runs = await listRuns(dir);
		assert.deepEqual(
			runs.map(run => run.runId),
			['r2', 'r1'],
			'newest first; end-only run dropped; torn line skipped',
		);
		assert.equal(runs[1]?.reason, 'completed');
		assert.equal(runs[1]?.turns, 3);
		assert.equal(runs[1]?.loggingMode, 'full');
		assert.equal(runs[0]?.endedAt, undefined, 'start-only run listed as in-flight/crashed');

		assert.deepEqual(
			(await listRuns(dir, { sessionId: 'sA' })).map(run => run.runId),
			['r1'],
		);
		assert.equal((await listRuns(dir, { limit: 1 })).length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('listRuns returns empty for a missing index', async () => {
	const dir = await createLogsDir();
	try {
		assert.deepEqual(await listRuns(dir), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readRunEvents collects one run across two daily files (midnight-spanning) and skips bad lines', async () => {
	const dir = await createLogsDir();
	try {
		const day1 = [
			{ ts: '2026-07-21T23:59:00.000Z', runId: 'r1', sessionId: 'sA', type: 'run_start', model: 'kimi' },
			{ ts: '2026-07-21T23:59:30.000Z', runId: 'r1', sessionId: 'sA', type: 'turn_start', turn: 1 },
			{ ts: '2026-07-21T23:59:40.000Z', runId: 'OTHER', sessionId: 'sB', type: 'turn_start', turn: 1 },
		];
		const day2 = [{ ts: '2026-07-22T00:00:10.000Z', runId: 'r1', sessionId: 'sA', type: 'run_end', reason: 'completed', turns: 1, durationMs: 70_000 }];
		await writeFile(join(dir, '2026-07-21.jsonl'), `${day1.map(line => JSON.stringify(line)).join('\n')}\nnot json at all\n`, 'utf8');
		await writeFile(join(dir, '2026-07-22.jsonl'), `${day2.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');

		const summary = {
			runId: 'r1',
			sessionId: 'sA',
			startedAt: '2026-07-21T23:59:00.000Z',
			startDate: '2026-07-21',
			endedAt: '2026-07-22T00:00:10.000Z',
			endDate: '2026-07-22',
		};
		const { events, truncated } = await readRunEvents(dir, summary);
		assert.equal(truncated, false);
		assert.deepEqual(
			events.map(event => event.type),
			['run_start', 'turn_start', 'run_end'],
			'both days scanned, other runs and bad lines skipped',
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readRunEvents without an end record also scans the next day (crash before run_end)', async () => {
	const dir = await createLogsDir();
	try {
		await writeFile(join(dir, '2026-07-21.jsonl'), `${JSON.stringify({ ts: '2026-07-21T23:59:00.000Z', runId: 'r1', sessionId: 'sA', type: 'run_start' })}\n`, 'utf8');
		await writeFile(join(dir, '2026-07-22.jsonl'), `${JSON.stringify({ ts: '2026-07-22T00:00:05.000Z', runId: 'r1', sessionId: 'sA', type: 'error', where: 'run' })}\n`, 'utf8');

		const { events } = await readRunEvents(dir, { runId: 'r1', sessionId: 'sA', startedAt: '2026-07-21T23:59:00.000Z', startDate: '2026-07-21' });
		assert.deepEqual(
			events.map(event => event.type),
			['run_start', 'error'],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readRunEvents caps the event count and reports truncation', async () => {
	const dir = await createLogsDir();
	try {
		const lines = Array.from({ length: 10 }, (_line, i) => JSON.stringify({ ts: '2026-07-21T08:00:00.000Z', runId: 'r1', sessionId: 'sA', type: 'turn_start', turn: i }));
		await writeFile(join(dir, '2026-07-21.jsonl'), `${lines.join('\n')}\n`, 'utf8');

		const { events, truncated } = await readRunEvents(dir, { runId: 'r1', sessionId: 'sA', startedAt: '2026-07-21T08:00:00.000Z', startDate: '2026-07-21' }, { maxEvents: 4 });
		assert.equal(events.length, 4);
		assert.equal(truncated, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
