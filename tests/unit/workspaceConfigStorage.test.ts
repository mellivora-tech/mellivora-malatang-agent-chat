/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { effectiveAccess, isReadOnlyForced, type IWorkspaceConfig } from '../../src/sessions/services/environments/common/environments.js';
import { normalizeConfig, readWorkspaceConfig, workspaceConfigPath, writeWorkspaceConfig } from '../../src/main/workspaceConfigStorage.js';

async function tempWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
}

const SAMPLE: IWorkspaceConfig = {
	version: 1,
	environments: [
		{ id: 'e-dev', name: 'dev', role: 'baseline' },
		{ id: 'e-prod', name: 'prod', role: 'target' },
	],
	dataSources: [
		{ id: 'd1', environmentId: 'e-dev', kind: 'database', label: '订单库', access: 'read-write', coordinates: { driver: 'mysql', host: 'dev.db', port: 3306, database: 'orders' } },
		{ id: 'd2', environmentId: 'e-prod', kind: 'database', label: '订单库', access: 'read-only', coordinates: { driver: 'mysql', host: 'prod.db', port: 3306, database: 'orders' } },
	],
};

test('write/read round-trips the workspace config into .mellivora/project.json', async () => {
	const ws = await tempWorkspace();
	try {
		await writeWorkspaceConfig(ws, SAMPLE);
		assert.match(workspaceConfigPath(ws), /\.mellivora\/project\.json$/);
		const loaded = await readWorkspaceConfig(ws);
		assert.deepEqual(loaded, SAMPLE);
		// The file is real JSON on disk (inspectable / git-able).
		JSON.parse(await readFile(workspaceConfigPath(ws), 'utf8'));
	} finally {
		await rm(ws, { recursive: true, force: true });
	}
});

test('a missing workspace config folds to empty, not an error', async () => {
	const ws = await tempWorkspace();
	try {
		assert.deepEqual(await readWorkspaceConfig(ws), { version: 1, environments: [], dataSources: [] });
	} finally {
		await rm(ws, { recursive: true, force: true });
	}
});

test('normalizeConfig drops orphan data sources and malformed entries', () => {
	const config = normalizeConfig({
		environments: [{ id: 'e-dev', name: 'dev', role: 'baseline' }, { name: 'no-id' }],
		dataSources: [
			{ id: 'ok', environmentId: 'e-dev', kind: 'database', label: 'x', coordinates: { driver: 'mysql', host: 'h', database: 'd' } },
			{ id: 'orphan', environmentId: 'e-gone', kind: 'database', label: 'y', coordinates: { driver: 'mysql', host: 'h', database: 'd' } },
			{ id: 'badkind', environmentId: 'e-dev', kind: 'redis', label: 'z', coordinates: {} },
		],
	});
	assert.equal(config.environments.length, 1);
	assert.deepEqual(
		config.dataSources.map(d => d.id),
		['ok'],
		'orphan (missing env) and non-database kinds are dropped',
	);
	assert.equal(config.dataSources[0]!.access, 'read-only', 'access defaults to read-only when absent');
	assert.equal(config.dataSources[0]!.coordinates.port, 3306, 'mysql port defaults to 3306');
});

test('read-only is forced for target (prod) environments regardless of stored access', () => {
	assert.equal(isReadOnlyForced('target'), true);
	assert.equal(isReadOnlyForced('baseline'), false);
	assert.equal(effectiveAccess('read-write', 'target'), 'read-only', 'prod write intent is overridden to read-only');
	assert.equal(effectiveAccess('read-write', 'baseline'), 'read-write');
});
