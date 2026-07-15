/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addProjectAllowPatterns, isPersistablePattern, listProjectAllowPatterns, readProjectAllowlist, removeProjectAllowPattern } from '../../src/main/agent/approvalStore.js';

async function createRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'approval-store-'));
}

test('only bash: patterns are persistable — escapes and edits never are', () => {
	assert.equal(isPersistablePattern('bash:mvn'), true);
	assert.equal(isPersistablePattern('bash:'), false);
	// SAFETY: a persisted sandbox escape would permanently disable the sandbox;
	// a persisted edit:* would be permanent auto-edit. Both stay session-only.
	assert.equal(isPersistablePattern('bash-nosandbox:mvn'), false);
	assert.equal(isPersistablePattern('edit:*'), false);
});

test('add / list / remove round-trips through the project file', async () => {
	const root = await createRoot();
	assert.deepEqual(await listProjectAllowPatterns(root, 'p1'), []);

	const added = await addProjectAllowPatterns(root, 'p1', ['bash:mvn', 'bash:git']);
	assert.deepEqual(added, ['bash:git', 'bash:mvn']);
	assert.deepEqual(await listProjectAllowPatterns(root, 'p1'), ['bash:git', 'bash:mvn']);
	// Another project is untouched.
	assert.deepEqual(await listProjectAllowPatterns(root, 'p2'), []);

	const remaining = await removeProjectAllowPattern(root, 'p1', 'bash:mvn');
	assert.deepEqual(remaining, ['bash:git']);
	assert.deepEqual(await listProjectAllowPatterns(root, 'p1'), ['bash:git']);
});

test('SAFETY: non-persistable grants are dropped on write AND on read', async () => {
	const root = await createRoot();
	// Write path: the store filters what the approval flow hands it.
	await addProjectAllowPatterns(root, 'p1', ['bash:mvn', 'bash-nosandbox:rm', 'edit:*']);
	assert.deepEqual(await listProjectAllowPatterns(root, 'p1'), ['bash:mvn']);

	// Read path: a hand-edited file cannot smuggle wider grants in.
	const file = join(root, 'projects', 'p1', 'approvals.json');
	await writeFile(file, JSON.stringify({ version: 1, allow: ['bash:git', 'bash-nosandbox:rm', 'edit:*', 42] }), 'utf8');
	assert.deepEqual([...(await readProjectAllowlist(root, 'p1'))], ['bash:git']);
});

test('corrupt or missing files fold to an empty allowlist', async () => {
	const root = await createRoot();
	assert.deepEqual([...(await readProjectAllowlist(root, 'missing'))], []);
	await mkdir(join(root, 'projects', 'p1'), { recursive: true });
	await writeFile(join(root, 'projects', 'p1', 'approvals.json'), 'not json', 'utf8');
	assert.deepEqual([...(await readProjectAllowlist(root, 'p1'))], []);
	await writeFile(join(root, 'projects', 'p1', 'approvals.json'), JSON.stringify({ allow: 'nope' }), 'utf8');
	assert.deepEqual([...(await readProjectAllowlist(root, 'p1'))], []);
});

test('the file on disk is tidy json with a version marker', async () => {
	const root = await createRoot();
	await addProjectAllowPatterns(root, 'p1', ['bash:mvn']);
	const raw = JSON.parse(await readFile(join(root, 'projects', 'p1', 'approvals.json'), 'utf8')) as { version: number; allow: string[] };
	assert.equal(raw.version, 1);
	assert.deepEqual(raw.allow, ['bash:mvn']);
});
