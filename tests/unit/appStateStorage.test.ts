/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readAppState, writeAppState } from '../../src/main/appStateStorage.js';

async function createTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-state-'));
}

test('readAppState returns empty state when the file is missing', async () => {
	const root = await createTempRoot();
	try {
		assert.deepEqual(await readAppState(join(root, 'nested')), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('readAppState tolerates corrupt json and wrong field types', async () => {
	const root = await createTempRoot();
	try {
		await writeFile(join(root, 'state.json'), '{ not json', 'utf8');
		assert.deepEqual(await readAppState(root), {});

		await writeFile(join(root, 'state.json'), JSON.stringify({ activeProjectId: 42 }), 'utf8');
		assert.deepEqual(await readAppState(root), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('writeAppState round-trips activeProjectId', async () => {
	const root = await createTempRoot();
	try {
		await writeAppState(root, { activeProjectId: '3f2a8c1d' });
		assert.deepEqual(await readAppState(root), { activeProjectId: '3f2a8c1d' });

		await writeAppState(root, {});
		assert.deepEqual(await readAppState(root), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
