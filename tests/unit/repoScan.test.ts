/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanRepos } from '../../src/main/repoScan.js';

async function tree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'reposcan-'));
	await mkdir(join(root, 'repo-a', '.git'), { recursive: true });
	await mkdir(join(root, 'nested', 'repo-b', '.git'), { recursive: true });
	await mkdir(join(root, 'sub', 'repo-c', '.svn'), { recursive: true });
	// A submodule/worktree marks its repo with a `.git` FILE, not a directory.
	await mkdir(join(root, 'mod'), { recursive: true });
	await writeFile(join(root, 'mod', '.git'), 'gitdir: /elsewhere\n', 'utf8');
	// Heavy dir with a vendored repo — must be skipped.
	await mkdir(join(root, 'node_modules', 'dep', '.git'), { recursive: true });
	// A nested repo INSIDE repo-a must not be surfaced (descent stops at repo-a).
	await mkdir(join(root, 'repo-a', 'inner', '.git'), { recursive: true });
	// A plain directory, no VCS.
	await mkdir(join(root, 'plain'), { recursive: true });
	return root;
}

test('scanRepos finds git/svn repos, handles .git files, and prunes heavy dirs', async () => {
	const root = await tree();
	try {
		const found = await scanRepos(root);
		const byName = new Map(found.map(repo => [repo.name, repo.vcs]));
		assert.equal(byName.get('repo-a'), 'git');
		assert.equal(byName.get('repo-b'), 'git');
		assert.equal(byName.get('repo-c'), 'svn');
		assert.equal(byName.get('mod'), 'git', 'a .git FILE marks a repo');
		assert.equal(byName.has('dep'), false, 'repos under node_modules are pruned');
		assert.equal(byName.has('inner'), false, 'descent stops at a repo — no nested repos');
		assert.equal(byName.has('plain'), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('scanRepos respects maxResults and maxDepth', async () => {
	const root = await mkdtemp(join(tmpdir(), 'reposcan-'));
	try {
		await mkdir(join(root, 'a', '.git'), { recursive: true });
		await mkdir(join(root, 'b', '.git'), { recursive: true });
		await mkdir(join(root, 'c', '.git'), { recursive: true });
		assert.equal((await scanRepos(root, { maxResults: 2 })).length, 2, 'stops at the result cap');

		await mkdir(join(root, 'x', 'y', 'z', 'deep', '.git'), { recursive: true });
		const shallow = await scanRepos(root, { maxDepth: 1 });
		assert.equal(
			shallow.some(repo => repo.name === 'deep'),
			false,
			'a repo below maxDepth is not reached',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('scanRepos returns empty for a missing root instead of throwing', async () => {
	assert.deepEqual(await scanRepos(join(tmpdir(), 'reposcan-does-not-exist-xyz')), []);
});
