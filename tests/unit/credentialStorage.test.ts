/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deleteCredential, getCredential, hasCredential, setCredential, type ISecretCipher } from '../../src/main/credentialStorage.js';

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-cred-'));
}

// A reversible fake cipher (base64) standing in for OS safeStorage.
const FAKE_CIPHER: ISecretCipher = {
	available: true,
	encrypt: plain => Buffer.from(plain, 'utf8').toString('base64'),
	decrypt: stored => Buffer.from(stored, 'base64').toString('utf8'),
};

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

test('with an encrypting cipher, the file holds ciphertext, not the plaintext secret', async () => {
	const root = await tempRoot();
	try {
		await setCredential(root, 'd1', { password: 'topsecret' }, FAKE_CIPHER);
		const onDisk = await readFile(join(root, 'credentials.json'), 'utf8');
		assert.doesNotMatch(onDisk, /topsecret/, 'the secret is encrypted at rest');
		assert.match(onDisk, /"enc": true/);
		assert.deepEqual(await getCredential(root, 'd1', FAKE_CIPHER), { password: 'topsecret' });
		// A caller without the cipher can't recover it (fail-safe empty, no throw).
		assert.equal(await getCredential(root, 'd1'), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('reads legacy v1 plaintext credential files', async () => {
	const root = await tempRoot();
	try {
		await writeFile(join(root, 'credentials.json'), JSON.stringify({ version: 1, credentials: { d1: { username: 'ro', password: 'x' } } }), 'utf8');
		assert.deepEqual(await getCredential(root, 'd1'), { username: 'ro', password: 'x' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
