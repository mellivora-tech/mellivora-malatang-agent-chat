/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { computeDiffStat, parseNumstat } from '../../src/main/gitDiff.js';

const execFileAsync = promisify(execFile);

test('parseNumstat: per-file rows plus the legacy line-accumulated totals', () => {
	const parsed = parseNumstat('10\t3\tsrc/app/main.ts\n0\t7\tdocs/notes.md\n');
	assert.deepEqual(parsed.files, [
		{ path: 'src/app/main.ts', added: 10, removed: 3 },
		{ path: 'docs/notes.md', added: 0, removed: 7 },
	]);
	assert.equal(parsed.additions, 10);
	assert.equal(parsed.deletions, 10);
});

test('parseNumstat: binary files carry no counts but still count as changed', () => {
	const parsed = parseNumstat('-\t-\tassets/logo.png\n2\t1\ta.ts\n');
	assert.deepEqual(parsed.files[0], { path: 'assets/logo.png', added: 0, removed: 0, status: 'binary' });
	assert.equal(parsed.files.length, 2);
	assert.equal(parsed.additions, 2);
	assert.equal(parsed.deletions, 1);
});

test('parseNumstat: rename arrows and tabs-in-path survive verbatim (the old changed-set口径)', () => {
	const parsed = parseNumstat('1\t2\tsrc/{old => new}/x.ts\n3\t0\tweird\tname.txt\n');
	assert.deepEqual(
		parsed.files.map(file => file.path),
		['src/{old => new}/x.ts', 'weird\tname.txt'],
	);
	assert.equal(parsed.additions, 4);
	assert.equal(parsed.deletions, 2);
});

test('parseNumstat: a duplicate path folds to one file while totals keep counting per line', () => {
	// The pre-P2 implementation counted `changed.size` (unique paths) for the
	// badge but accumulated additions per LINE — the file list must not change
	// either number.
	const parsed = parseNumstat('1\t0\tsame.ts\n2\t0\tsame.ts\n');
	assert.deepEqual(parsed.files, [{ path: 'same.ts', added: 3, removed: 0 }]);
	assert.equal(parsed.additions, 3);
});

test('parseNumstat: empty output yields no files and zero totals', () => {
	assert.deepEqual(parseNumstat(''), { files: [], additions: 0, deletions: 0 });
});

test('computeDiffStat: real repo — tracked numstat plus whole-content untracked, same totals as the count-only era', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'agent-chat-gitdiff-'));
	const git = (...args: string[]): Promise<unknown> =>
		execFileAsync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args]);
	try {
		await git('init', '-q');
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
		await git('add', '.');
		await git('commit', '-q', '-m', 'init');

		// A clean tree reports "no stats", exactly like a non-repo path.
		assert.equal(await computeDiffStat(dir), undefined);
		assert.equal(await computeDiffStat(tmpdir()), undefined);

		// Tracked edit: +2 lines. Untracked file: whole content, and the historic
		// 口径 counts the trailing-newline split ('x\ny\n' → 3 "lines").
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n', 'utf8');
		await writeFile(join(dir, 'b.txt'), 'x\ny\n', 'utf8');

		const stat = await computeDiffStat(dir);
		assert.ok(stat);
		assert.equal(stat.files.length, 2);
		assert.equal(stat.additions, 5);
		assert.equal(stat.deletions, 0);
		const tracked = stat.files.find(file => file.path === 'a.txt');
		assert.deepEqual(tracked, { path: 'a.txt', added: 2, removed: 0 });
		const untracked = stat.files.find(file => file.path === 'b.txt');
		assert.deepEqual(untracked, { path: 'b.txt', added: 3, removed: 0, status: 'untracked' });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
