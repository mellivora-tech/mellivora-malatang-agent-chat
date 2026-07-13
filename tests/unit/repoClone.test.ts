/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cloneOrUpdate, gitRemoteOrigin, normalizeRepoUrl, repoName, type CommandRunner } from '../../src/main/repoClone.js';

const signal = new AbortController().signal;

test('normalizeRepoUrl collapses https / ssh / scp forms of the same repo to one key', () => {
	const key = 'github.com/acme/order-service';
	assert.equal(normalizeRepoUrl('https://github.com/acme/order-service.git'), key);
	assert.equal(normalizeRepoUrl('git@github.com:acme/order-service.git'), key);
	assert.equal(normalizeRepoUrl('ssh://git@github.com/acme/order-service'), key);
	assert.equal(normalizeRepoUrl('https://github.com/Acme/Order-Service/'), key);
	assert.notEqual(normalizeRepoUrl('https://github.com/acme/gateway.git'), key);
});

test('gitRemoteOrigin returns the origin url, or undefined when not a repo', async () => {
	const withOrigin: CommandRunner = async () => ({ code: 0, output: 'git@github.com:acme/x.git\n' });
	assert.equal(await gitRemoteOrigin('/some/repo', signal, withOrigin), 'git@github.com:acme/x.git');
	const noRepo: CommandRunner = async () => ({ code: 128, output: 'fatal: not a git repository' });
	assert.equal(await gitRemoteOrigin('/not/a/repo', signal, noRepo), undefined);
});

test('repoName derives a folder name from assorted URL shapes', () => {
	assert.equal(repoName('https://github.com/acme/order-service.git'), 'order-service');
	assert.equal(repoName('git@github.com:acme/gateway.git'), 'gateway');
	assert.equal(repoName('https://example.com/team/monitor-web/'), 'monitor-web');
	assert.equal(repoName('https://svn.example.com/repos/legacy'), 'legacy');
});

test('cloneOrUpdate clones when absent and fast-forwards when present', async () => {
	const root = await mkdtemp(join(tmpdir(), 'repoclone-'));
	try {
		const localPath = join(root, 'r');
		const calls: string[][] = [];
		const run: CommandRunner = async (file, args) => {
			calls.push([file, ...args]);
			return { code: 0, output: '' };
		};

		const cloned = await cloneOrUpdate(localPath, { url: 'https://x/y.git', vcs: 'git', ref: 'main' }, signal, run);
		assert.equal(cloned.ok, true);
		assert.equal(cloned.message, '已克隆');
		assert.deepEqual(calls[0], ['git', 'clone', '--branch', 'main', '--', 'https://x/y.git', localPath]);

		// Now that the working copy exists, it fast-forwards instead of re-cloning.
		await mkdir(join(localPath, '.git'), { recursive: true });
		calls.length = 0;
		const updated = await cloneOrUpdate(localPath, { url: 'https://x/y.git', vcs: 'git' }, signal, run);
		assert.equal(updated.message, '已更新');
		assert.deepEqual(calls[0], ['git', '-C', localPath, 'pull', '--ff-only']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('cloneOrUpdate surfaces a failure with the last output line, never throwing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'repoclone-'));
	try {
		const run: CommandRunner = async () => ({ code: 128, output: 'Cloning…\nfatal: repository not found\n' });
		const result = await cloneOrUpdate(join(root, 'r'), { url: 'https://x/missing.git', vcs: 'git' }, signal, run);
		assert.equal(result.ok, false);
		assert.match(result.message, /repository not found/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('cloneOrUpdate uses svn checkout/update for svn remotes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'repoclone-'));
	try {
		const localPath = join(root, 'r');
		const calls: string[][] = [];
		const run: CommandRunner = async (file, args) => {
			calls.push([file, ...args]);
			return { code: 0, output: '' };
		};
		await cloneOrUpdate(localPath, { url: 'svn://x/trunk', vcs: 'svn' }, signal, run);
		assert.deepEqual(calls[0], ['svn', 'checkout', 'svn://x/trunk', localPath]);

		await mkdir(join(localPath, '.svn'), { recursive: true });
		calls.length = 0;
		await cloneOrUpdate(localPath, { url: 'svn://x/trunk', vcs: 'svn' }, signal, run);
		assert.deepEqual(calls[0], ['svn', 'update', localPath]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
