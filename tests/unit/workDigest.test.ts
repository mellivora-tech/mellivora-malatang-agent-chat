/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkDigestEvent, buildWorkDigestText, createWorkDigest, isWorkDigestEnabled, recordWorkDigest, summarizeWorkDigest } from '../../src/main/agent/workDigest.js';

function digestOf(calls: readonly (readonly [string, unknown])[]): ReturnType<typeof createWorkDigest> {
	const digest = createWorkDigest();
	for (const [name, input] of calls) {
		recordWorkDigest(digest, name, input);
	}
	return digest;
}

test('records reads, edits, writes, and lists into distinct buckets', () => {
	const digest = digestOf([
		['read_file', { path: 'a.ts' }],
		['read_file', { path: 'b.ts' }],
		['edit_file', { path: 'c.ts' }],
		['write_file', { path: 'd.ts' }],
		['list_dir', { path: 'src/' }],
	]);
	assert.deepEqual([...digest.filesRead], ['a.ts', 'b.ts']);
	assert.deepEqual([...digest.filesEdited], ['c.ts']);
	assert.deepEqual([...digest.filesWritten], ['d.ts']);
	assert.deepEqual([...digest.dirsListed], ['src/']);
});

test('dedupes repeated file paths — a re-read counts once', () => {
	const digest = digestOf([
		['read_file', { path: 'a.ts' }],
		['read_file', { path: 'a.ts' }],
		['read_file', { path: 'a.ts' }],
	]);
	assert.equal(digest.filesRead.size, 1);
});

test('grep/glob count as searches, bash as commands', () => {
	const digest = digestOf([
		['grep', { pattern: 'foo' }],
		['glob', { pattern: '*.ts' }],
		['bash', { command: 'ls' }],
		['bash', { command: 'git status' }],
	]);
	assert.equal(digest.searches, 2);
	assert.equal(digest.commands, 2);
});

test('unknown tools and malformed inputs are ignored, never throw', () => {
	const digest = digestOf([
		['propose_plan', { title: 'x' }],
		['read_file', {}],
		['read_file', { path: '' }],
		['read_file', null],
		['read_file', 'oops'],
	]);
	assert.equal(digest.filesRead.size, 0);
	assert.equal(summarizeWorkDigest(digest).toolCalls, 0);
});

test('summary counts are export-safe: written = write + edit, toolCalls totals everything', () => {
	const digest = digestOf([
		['read_file', { path: 'a.ts' }],
		['edit_file', { path: 'b.ts' }],
		['write_file', { path: 'c.ts' }],
		['grep', { pattern: 'x' }],
		['bash', { command: 'ls' }],
	]);
	const summary = summarizeWorkDigest(digest);
	assert.equal(summary.filesRead, 1);
	assert.equal(summary.filesWritten, 2);
	assert.equal(summary.toolCalls, 5);
});

test('digest text lists each bucket and the activity line', () => {
	const text = buildWorkDigestText(
		digestOf([
			['read_file', { path: 'a.ts' }],
			['read_file', { path: 'b.ts' }],
			['edit_file', { path: 'c.ts' }],
			['grep', { pattern: 'x' }],
			['bash', { command: 'ls' }],
		]),
	);
	assert.ok(text);
	assert.match(text, /^<work-digest>/);
	assert.match(text, /<\/work-digest>$/);
	assert.match(text, /Read: a\.ts, b\.ts/);
	assert.match(text, /Edited: c\.ts/);
	assert.match(text, /Also ran 1 search, 1 shell command\./);
});

test('an empty run yields no digest text and no event', () => {
	assert.equal(buildWorkDigestText(createWorkDigest()), undefined);
	assert.equal(buildWorkDigestEvent(createWorkDigest()), undefined);
	// A run that only ran conversationally (no tracked tools) also yields nothing.
	assert.equal(buildWorkDigestEvent(digestOf([['propose_plan', { title: 'x' }]])), undefined);
});

test('the event pairs the rendered text with export-safe counts', () => {
	const event = buildWorkDigestEvent(
		digestOf([
			['read_file', { path: 'a.ts' }],
			['edit_file', { path: 'b.ts' }],
		]),
	);
	assert.ok(event);
	assert.equal(event.filesRead, 1);
	assert.equal(event.filesWritten, 1);
	assert.equal(event.toolCalls, 2);
	assert.match(event.text, /Read: a\.ts/);
});

test('a large read list is capped with an overflow marker', () => {
	const digest = createWorkDigest();
	for (let i = 0; i < 45; i++) {
		recordWorkDigest(digest, 'read_file', { path: `file-${i}.ts` });
	}
	const text = buildWorkDigestText(digest);
	assert.ok(text);
	assert.match(text, /…\+5 more/);
});

test('kill switch: MELLIVORA_WORK_DIGEST=off disables, anything else enables', () => {
	assert.equal(isWorkDigestEnabled({ MELLIVORA_WORK_DIGEST: 'off' }), false);
	assert.equal(isWorkDigestEnabled({ MELLIVORA_WORK_DIGEST: '1' }), true);
	assert.equal(isWorkDigestEnabled({}), true);
});
