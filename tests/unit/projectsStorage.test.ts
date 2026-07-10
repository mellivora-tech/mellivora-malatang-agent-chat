/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createProject, ensureProject, ensureProjectsRoot, getProject, listProjects, resolveDataRoot } from '../../src/main/projectsStorage.js';

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
