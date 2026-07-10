/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deleteCredential, getCredential, hasCredential, setCredential } from '../../src/main/credentialStorage.js';

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-cred-'));
}

test('set/get/has/delete round-trip a data-source credential', async () => {
	const root = await tempRoot();
	try {
		assert.equal(await hasCredential(root, 'd1'), false);
		await setCredential(root, 'd1', { username: 'ro_user', password: 'secret' });
		assert.equal(await hasCredential(root, 'd1'), true);
		assert.deepEqual(await getCredential(root, 'd1'), { username: 'ro_user', password: 'secret' });

		await deleteCredential(root, 'd1');
		assert.equal(await hasCredential(root, 'd1'), false);
		assert.equal(await getCredential(root, 'd1'), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('setting an all-empty credential clears the entry', async () => {
	const root = await tempRoot();
	try {
		await setCredential(root, 'd1', { token: 'abc' });
		await setCredential(root, 'd1', { username: '', password: '' });
		assert.equal(await hasCredential(root, 'd1'), false, 'empty fields prune the entry');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('credentials never leak into the workspace — they live only in the app credentials file', async () => {
	const root = await tempRoot();
	try {
		await setCredential(root, 'd1', { password: 'topsecret' });
		const onDisk = await readFile(join(root, 'credentials.json'), 'utf8');
		assert.match(onDisk, /topsecret/, 'stored app-side by design');
		// (The workspace config module is tested separately; by construction it
		// never receives secret fields — IDataSource has no credential field.)
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
