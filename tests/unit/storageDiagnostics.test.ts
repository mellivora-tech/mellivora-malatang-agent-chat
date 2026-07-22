/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentLog, type AgentLogEvent, type IAgentLogSink } from '../../src/main/agent/observability/agentLog.js';
import { readWorkspaceConfig } from '../../src/main/workspaceConfigStorage.js';

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'storage-diag-'));

/** Collect what the storage readers report while `run` executes. */
async function degradations(run: () => Promise<unknown>): Promise<AgentLogEvent[]> {
	const events: AgentLogEvent[] = [];
	const sink: IAgentLogSink = { write: event => void events.push(event) };
	agentLog.attach(sink);
	try {
		await run();
	} finally {
		agentLog.dispose();
	}
	return events.filter(event => event.type === 'storage_degraded');
}

test('an ABSENT config stays quiet — that is the legitimate empty case', async () => {
	const dir = await tmp();
	const reported = await degradations(() => readWorkspaceConfig(dir));
	assert.deepEqual(reported, [], 'a fresh install must not fill the log with noise');
});

test('a CORRUPT config is reported — "unreadable" must not present as "never configured"', async () => {
	const dir = await tmp();
	const path = join(dir, '.mellivora');
	await writeFile(join(dir, 'project.json'), 'x', 'utf8'); // wrong place — still absent, still quiet
	assert.deepEqual(await degradations(() => readWorkspaceConfig(dir)), [], 'only the real config path counts');

	// Now the real file, present but not JSON: every environment and data source
	// silently disappears, which is exactly what must not happen unannounced.
	const { mkdir } = await import('node:fs/promises');
	await mkdir(path, { recursive: true });
	await writeFile(join(path, 'project.json'), '{ this is not json', 'utf8');

	const reported = await degradations(() => readWorkspaceConfig(dir));
	assert.equal(reported.length, 1);
	const event = reported[0] as { store: string; reason: string; detail?: { path?: string } };
	assert.equal(event.store, 'workspaceConfig');
	assert.equal(event.reason, 'unparseable');
	assert.ok(event.detail?.path?.endsWith('project.json'), 'the offending file is named so it can be fixed');
});

test('a corrupt config still degrades to empty — reporting must not change behaviour', async () => {
	const dir = await tmp();
	const { mkdir } = await import('node:fs/promises');
	await mkdir(join(dir, '.mellivora'), { recursive: true });
	await writeFile(join(dir, '.mellivora', 'project.json'), 'not json', 'utf8');

	const config = await readWorkspaceConfig(dir);
	assert.deepEqual(config.environments, [], 'the app still boots on a broken config');
});
