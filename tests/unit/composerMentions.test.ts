/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { collectMentionAttachments, filterMentionPaths, findMentionQuery, mentionText, type IMentionEntry } from '../../src/sessions/browser/parts/composerMentions.js';

test('findMentionQuery detects an @-token at the caret', () => {
	assert.deepEqual(findMentionQuery('@src', 4), { start: 0, query: 'src' });
	assert.deepEqual(findMentionQuery('look at @src/main', 17), { start: 8, query: 'src/main' });
	assert.deepEqual(findMentionQuery('@', 1), { start: 0, query: '' });
});

test('findMentionQuery rejects emails, mid-word @, and tokens broken by whitespace', () => {
	assert.equal(findMentionQuery('user@example.com', 16), undefined, 'an email is not a mention');
	assert.equal(findMentionQuery('@src and more', 13), undefined, 'whitespace ends the token');
	assert.equal(findMentionQuery('plain text', 5), undefined);
	// Caret before the @ sees no token.
	assert.equal(findMentionQuery('@src', 0), undefined);
});

test('filterMentionPaths ranks basename prefix over path substring and derives folders', () => {
	const files = ['src/main/agentIpc.ts', 'src/sessions/browser/parts/newSessionView.ts', 'tests/unit/agentLoop.test.ts'];
	const results = filterMentionPaths(files, 'agent');
	assert.ok(results.length >= 2);
	assert.equal(results[0]!.path, 'src/main/agentIpc.ts', 'basename prefix match ranks first');

	const folders = filterMentionPaths(files, 'sessions').filter(entry => entry.kind === 'folder');
	assert.ok(
		folders.some(entry => entry.path === 'src/sessions'),
		'folders are derived from file paths',
	);
});

test('filterMentionPaths with an empty query returns entries capped at the limit', () => {
	const files = Array.from({ length: 100 }, (_, index) => `src/file${index}.ts`);
	assert.equal(filterMentionPaths(files, '', 10).length, 10);
});

test('collectMentionAttachments keeps only mentions still present in the text', () => {
	const file: IMentionEntry = { kind: 'file', path: 'src/a.ts' };
	const folder: IMentionEntry = { kind: 'folder', path: 'src/parts' };
	const recorded = new Map<string, IMentionEntry>([
		[mentionText(file), file],
		[mentionText(folder), folder],
	]);
	const attachments = collectMentionAttachments('please read @src/a.ts thanks', recorded);
	assert.deepEqual(attachments, [{ kind: 'file', path: 'src/a.ts' }], 'the deleted folder mention is dropped');
});

test('findMentionQuery supports a custom trigger char ($ for skills)', () => {
	assert.deepEqual(findMentionQuery('$com', 4, '$'), { start: 0, query: 'com' });
	assert.deepEqual(findMentionQuery('use $rev now', 8, '$'), { start: 4, query: 'rev' });
	assert.equal(findMentionQuery('price$5', 7, '$'), undefined, 'mid-word $ is not a mention');
	assert.equal(findMentionQuery('$com', 4), undefined, 'the default trigger stays @');
});
