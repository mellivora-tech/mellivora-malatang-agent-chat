/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentLogEvent } from '../../src/main/agent/observability/agentLog.js';
import type { LoggingMode } from '../../src/main/agent/observability/logFilter.js';
import { createRunIndexSink, RUNS_INDEX_FILE } from '../../src/main/agent/observability/runIndexSink.js';

const runStart: AgentLogEvent = {
	ts: '2026-07-22T08:00:00.000Z',
	runId: 'r1',
	sessionId: 's1',
	type: 'run_start',
	build: 'dev',
	model: 'kimi',
	mode: 'ask',
	hasWorkspace: true,
	toolCount: 4,
};

test('runIndexSink mirrors only run boundaries, annotated with the mode at write time', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mmac-runindex-'));
	let mode: LoggingMode = 'errors';
	const sink = createRunIndexSink(dir, () => mode);

	sink.write(runStart);
	// Everything that is not a boundary is ignored — the index stays 2 lines/run.
	sink.write({ ts: 't', runId: 'r1', sessionId: 's1', type: 'turn_start', turn: 1 });
	sink.write({ ts: 't', runId: 'r1', sessionId: 's1', type: 'tool_use', toolUseId: 'x', name: 'grep' });
	mode = 'full';
	sink.write({ ts: '2026-07-22T08:01:00.000Z', runId: 'r1', sessionId: 's1', type: 'run_end', reason: 'completed', turns: 2, durationMs: 60_000 });

	const lines = readFileSync(join(dir, RUNS_INDEX_FILE), 'utf8')
		.trim()
		.split('\n')
		.map(line => JSON.parse(line) as Record<string, unknown>);
	assert.equal(lines.length, 2);
	assert.equal(lines[0]?.['kind'], 'start');
	assert.equal(lines[0]?.['date'], '2026-07-22');
	assert.equal(lines[0]?.['model'], 'kimi');
	assert.equal(lines[0]?.['permissionMode'], 'ask');
	assert.equal(lines[0]?.['loggingMode'], 'errors', 'mode captured at start-write time');
	assert.equal(lines[1]?.['kind'], 'end');
	assert.equal(lines[1]?.['reason'], 'completed');
	assert.equal(lines[1]?.['turns'], 2);
});

test('runIndexSink touches no file until a boundary arrives', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mmac-runindex-'));
	const sink = createRunIndexSink(dir, () => 'full');
	sink.write({ ts: 't', runId: 'r1', sessionId: 's1', type: 'turn_start', turn: 1 });
	assert.equal(existsSync(join(dir, RUNS_INDEX_FILE)), false);
});
