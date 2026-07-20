/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChangeSetEntry, changeSetContentHash } from '../../src/sessions/services/artifacts/common/changeSet.js';

const files = [
	{ path: 'src/app/main.ts', added: 10, removed: 3 },
	{ path: 'docs/notes.md', added: 2, removed: 0 },
];

test('buildChangeSetEntry: empty diff is noise, not an artifact', () => {
	assert.equal(buildChangeSetEntry({ sessionId: 's1', files: [], createdAt: '2026-07-20T10:00:00.000Z' }), undefined);
});

test('buildChangeSetEntry: content-hash id, Chinese literal title, inlined payload', () => {
	const entry = buildChangeSetEntry({ sessionId: 's1', projectId: 'p1', files, createdAt: '2026-07-20T10:00:00.000Z' });
	assert.ok(entry);
	assert.match(entry.id, /^s1:changeset:[0-9a-f]{8}$/);
	assert.equal(entry.kind, 'change-set');
	assert.equal(entry.projectId, 'p1');
	// Persisted title — stored in the source language on purpose (index lines
	// are written once, read under any later locale; see changeSet.ts).
	assert.equal(entry.title, '2 个文件改动');
	assert.deepEqual(entry.payload, { type: 'change-set', files });
	// No projectId → the field is absent, not undefined (the line is JSON).
	const bare = buildChangeSetEntry({ sessionId: 's1', files, createdAt: '2026-07-20T10:00:00.000Z' })!;
	assert.equal(Object.keys(bare).includes('projectId'), false);
});

test('changeSetContentHash: order-insensitive, content-sensitive — the dedup key', () => {
	const hash = changeSetContentHash(files);
	assert.equal(changeSetContentHash([...files].reverse()), hash, 'git output order must not change the id');
	assert.notEqual(changeSetContentHash([{ ...files[0]!, added: 11 }, files[1]!]), hash, 'a changed count is new content');
	assert.notEqual(changeSetContentHash(files.slice(0, 1)), hash, 'a dropped file is new content');

	// Same content → same id → the index fold collapses repeated snapshots.
	const first = buildChangeSetEntry({ sessionId: 's1', files, createdAt: '2026-07-20T10:00:00.000Z' })!;
	const second = buildChangeSetEntry({ sessionId: 's1', files, createdAt: '2026-07-20T11:00:00.000Z' })!;
	assert.equal(first.id, second.id);
});
