/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
	addCodeRoot,
	addRemote,
	createProject,
	detectVcs,
	ensureCodeRootsSeeded,
	ensureProject,
	ensureProjectsRoot,
	getProject,
	listCodeRoots,
	listProjects,
	listRemotes,
	remoteLocalPath,
	removeCodeRoot,
	removeRemote,
	resolveDataRoot,
} from '../../src/main/projectsStorage.js';
import type { CommandRunner } from '../../src/main/repoClone.js';

async function createTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-projects-'));
}

test('resolveDataRoot honors MELLIVORA_DATA_DIR override', () => {
	assert.equal(resolveDataRoot({ MELLIVORA_DATA_DIR: '/custom/data' }, '/home/user'), '/custom/data');
});

test('resolveDataRoot defaults to ~/.mellivora', () => {
	assert.equal(resolveDataRoot({}, '/home/user'), join('/home/user', '.mellivora'));
});

test('resolveDataRoot ignores an empty override', () => {
	assert.equal(resolveDataRoot({ MELLIVORA_DATA_DIR: '' }, '/home/user'), join('/home/user', '.mellivora'));
});

test('listProjects returns empty for a missing root', async () => {
	const root = await createTempRoot();
	try {
		assert.deepEqual(await listProjects(join(root, 'does-not-exist')), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('createProject round-trips through listProjects and getProject', async () => {
	const root = await createTempRoot();
	try {
		const created = await createProject(root, { name: 'my-app', path: '/Users/someone/workspace/my-app' });

		assert.match(created.id, /^[0-9a-f]{8}$/);
		assert.equal(created.name, 'my-app');
		assert.equal(created.path, resolve('/Users/someone/workspace/my-app'));
		assert.ok(!Number.isNaN(Date.parse(created.createdAt)));

		const listed = await listProjects(root);
		assert.deepEqual(listed, [created]);
		assert.deepEqual(await getProject(root, created.id), created);

		const raw = JSON.parse(await readFile(join(root, 'projects', created.id, 'project.json'), 'utf8')) as unknown;
		assert.deepEqual(raw, { ...created });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('getProject returns undefined for an unknown id', async () => {
	const root = await createTempRoot();
	try {
		assert.equal(await getProject(root, 'deadbeef'), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('ensureProject reuses an existing project for the same path', async () => {
	const root = await createTempRoot();
	try {
		const first = await ensureProject(root, { name: 'my-app', path: '/Users/someone/workspace/my-app' });
		const second = await ensureProject(root, { name: 'renamed', path: '/Users/someone/workspace/other/../my-app' });

		assert.deepEqual(second, first);
		assert.equal((await listProjects(root)).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('ensureProject creates a project when the path is new', async () => {
	const root = await createTempRoot();
	try {
		await ensureProject(root, { name: 'a', path: '/tmp/a' });
		const second = await ensureProject(root, { name: 'b', path: '/tmp/b' });

		assert.equal(second.name, 'b');
		assert.equal((await listProjects(root)).length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('listProjects skips corrupt and mismatched entries', async () => {
	const root = await createTempRoot();
	try {
		const valid = await createProject(root, { name: 'valid', path: '/tmp/valid' });

		const corruptDir = join(root, 'projects', 'aaaa1111');
		await mkdir(corruptDir, { recursive: true });
		await writeFile(join(corruptDir, 'project.json'), '{ not json', 'utf8');

		const mismatchedDir = join(root, 'projects', 'bbbb2222');
		await mkdir(mismatchedDir, { recursive: true });
		await writeFile(join(mismatchedDir, 'project.json'), JSON.stringify({ id: 'cccc3333', name: 'x', path: '/tmp/x', createdAt: new Date().toISOString() }), 'utf8');

		const missingFieldsDir = join(root, 'projects', 'dddd4444');
		await mkdir(missingFieldsDir, { recursive: true });
		await writeFile(join(missingFieldsDir, 'project.json'), JSON.stringify({ id: 'dddd4444' }), 'utf8');

		const emptyDir = join(root, 'projects', 'eeee5555');
		await mkdir(emptyDir, { recursive: true });

		assert.deepEqual(await listProjects(root), [valid]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('listProjects orders projects by createdAt', async () => {
	const root = await createTempRoot();
	try {
		const seed = async (id: string, createdAt: string) => {
			const dir = join(root, 'projects', id);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, 'project.json'), JSON.stringify({ id, name: id, path: `/tmp/${id}`, createdAt }), 'utf8');
		};
		await seed('bbbb2222', '2026-07-02T00:00:00.000Z');
		await seed('aaaa1111', '2026-07-01T00:00:00.000Z');

		const listed = await listProjects(root);
		assert.deepEqual(
			listed.map(project => project.id),
			['aaaa1111', 'bbbb2222'],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('ensureProjectsRoot creates the projects directory', async () => {
	const root = await createTempRoot();
	try {
		const dataRoot = join(root, 'nested', 'data');
		await ensureProjectsRoot(dataRoot);
		const stats = await stat(join(dataRoot, 'projects'));
		assert.ok(stats.isDirectory());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('addCodeRoot / removeCodeRoot persist absolute, deduped paths', async () => {
	const root = await createTempRoot();
	try {
		const project = await createProject(root, { name: 'app', path: '/tmp/app' });
		await addCodeRoot(root, project.id, '/tmp/app/../app/service');
		const afterAdd = await addCodeRoot(root, project.id, '/tmp/app/service'); // same resolved path → deduped
		assert.deepEqual(afterAdd, [resolve('/tmp/app/service')]);
		assert.deepEqual((await getProject(root, project.id))?.codeRoots, [resolve('/tmp/app/service')]);

		const afterRemove = await removeCodeRoot(root, project.id, resolve('/tmp/app/service'));
		assert.deepEqual(afterRemove, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('detectVcs / listCodeRoots annotate roots by their VCS marker', async () => {
	const root = await createTempRoot();
	try {
		const gitDir = join(root, 'code', 'gitrepo');
		await mkdir(join(gitDir, '.git'), { recursive: true });
		const plainDir = join(root, 'code', 'plain');
		await mkdir(plainDir, { recursive: true });

		assert.equal(await detectVcs(gitDir), 'git');
		assert.equal(await detectVcs(plainDir), undefined);

		const project = await createProject(root, { name: 'app', path: '/tmp/app' });
		await addCodeRoot(root, project.id, gitDir);
		await addCodeRoot(root, project.id, plainDir);
		const views = await listCodeRoots(root, project.id);
		assert.deepEqual(
			views.map(view => [view.name, view.vcs]),
			[
				['gitrepo', 'git'],
				['plain', undefined],
			],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('ensureCodeRootsSeeded seeds workspace repos once, then respects removals', async () => {
	const root = await createTempRoot();
	const ws = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
	try {
		await mkdir(join(ws, 'svc-a', '.git'), { recursive: true });
		await mkdir(join(ws, 'plain'), { recursive: true }); // not a repo — not seeded
		const project = await createProject(root, { name: 'app', path: ws });

		await ensureCodeRootsSeeded(root, project.id);
		const seeded = await listCodeRoots(root, project.id);
		assert.deepEqual(
			seeded.map(view => view.name),
			['svc-a'],
			'only the git repo under the workspace is seeded',
		);

		// Remove it, then re-seed — the empty (present) array must not be re-populated.
		await removeCodeRoot(root, project.id, seeded[0]!.path);
		await ensureCodeRootsSeeded(root, project.id);
		assert.deepEqual(await listCodeRoots(root, project.id), []);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(ws, { recursive: true, force: true });
	}
});

test('addRemote / listRemotes / removeRemote manage remote repos and their clone state', async () => {
	const root = await createTempRoot();
	try {
		const project = await createProject(root, { name: 'app', path: '/tmp/app' });
		const added = await addRemote(root, project.id, { url: 'https://github.com/acme/order-service.git' });
		// A normalized-equal URL (ssh form here) is rejected as a duplicate.
		await assert.rejects(() => addRemote(root, project.id, { url: 'git@github.com:acme/order-service.git' }), /已添加/);
		assert.equal(added.length, 1);
		const remote = added[0]!;
		assert.equal(remote.name, 'order-service');
		assert.equal(remote.vcs, 'git');
		assert.match(remote.id, /^repo-/);

		const views = await listRemotes(root, project.id);
		assert.equal(views[0]!.localPath, remoteLocalPath(root, project.id, remote.id));
		assert.equal(views[0]!.cloned, false, 'not cloned until fetched');

		// Simulate a clone landing on disk → cloned becomes true.
		await mkdir(join(remoteLocalPath(root, project.id, remote.id), '.git'), { recursive: true });
		assert.equal((await listRemotes(root, project.id))[0]!.cloned, true);

		await removeRemote(root, project.id, remote.id);
		assert.deepEqual(await listRemotes(root, project.id), []);
		await assert.rejects(() => stat(remoteLocalPath(root, project.id, remote.id)), 'the clone dir is deleted');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('addRemote dedups against a local code root by its git origin (normalized)', async () => {
	const root = await createTempRoot();
	try {
		const project = await createProject(root, { name: 'app', path: '/tmp/app' });
		await addCodeRoot(root, project.id, '/code/order-service');
		// Fake `git -C <path> config --get remote.origin.url` for that local root.
		const fakeGit: CommandRunner = async (_file, args) =>
			args.includes('/code/order-service') ? { code: 0, output: 'git@github.com:acme/order-service.git\n' } : { code: 1, output: '' };

		// Same repo (https form) as the local root → rejected.
		await assert.rejects(() => addRemote(root, project.id, { url: 'https://github.com/acme/order-service.git' }, fakeGit), /本地代码/);
		// A different repo is accepted.
		const ok = await addRemote(root, project.id, { url: 'https://github.com/acme/gateway.git' }, fakeGit);
		assert.equal(ok.length, 1);
		assert.equal(ok[0]!.name, 'gateway');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('concurrent createProject calls yield unique ids', async () => {
	const root = await createTempRoot();
	try {
		const created = await Promise.all(Array.from({ length: 8 }, (_, index) => createProject(root, { name: `p${index}`, path: `/tmp/p${index}` })));
		const ids = new Set(created.map(project => project.id));
		assert.equal(ids.size, created.length);
		assert.equal((await listProjects(root)).length, created.length);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
