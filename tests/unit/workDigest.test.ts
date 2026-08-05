/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildWorkDigestEvent,
	buildWorkDigestText,
	createWorkDigest,
	isWorkDigestEnabled,
	recordWorkDigest,
	seedWorkDigestFromMessages,
	seedWorkDigestFromText,
	summarizeWorkDigest,
} from '../../src/main/agent/workDigest.js';
import type { IAgentMessage } from '../../src/main/agent/agentTypes.js';

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

test('recordWorkDigest reports tracked tools true and unknown ones false', () => {
	const digest = createWorkDigest();
	assert.equal(recordWorkDigest(digest, 'read_file', { path: 'a.ts' }), true);
	assert.equal(recordWorkDigest(digest, 'bash', { command: 'ls' }), true);
	assert.equal(recordWorkDigest(digest, 'propose_plan', { title: 'x' }), false);
	assert.equal(recordWorkDigest(digest, 'write_walkthrough', {}), false);
});

test('a rendered digest round-trips: render → seed reproduces the file buckets', () => {
	const original = digestOf([
		['read_file', { path: 'src/a.ts' }],
		['read_file', { path: 'src/b.ts' }],
		['edit_file', { path: 'src/c.ts' }],
		['write_file', { path: 'src/d.ts' }],
		['list_dir', { path: 'src/' }],
		['grep', { pattern: 'x' }],
	]);
	const text = buildWorkDigestText(original);
	assert.ok(text);

	const seeded = createWorkDigest();
	seedWorkDigestFromText(seeded, text);
	assert.deepEqual([...seeded.filesRead], ['src/a.ts', 'src/b.ts']);
	assert.deepEqual([...seeded.filesEdited], ['src/c.ts']);
	assert.deepEqual([...seeded.filesWritten], ['src/d.ts']);
	assert.deepEqual([...seeded.dirsListed], ['src/']);
	// Activity counts are per-run telemetry — not carried across the seed.
	assert.equal(seeded.searches, 0);
});

test('seeding is cumulative: a new run unions its files onto the previous digest', () => {
	const first = buildWorkDigestText(digestOf([['read_file', { path: 'a.ts' }]]));
	assert.ok(first);

	// Second run seeds from the first digest, then reads a new file.
	const second = createWorkDigest();
	seedWorkDigestFromText(second, first);
	recordWorkDigest(second, 'read_file', { path: 'b.ts' });
	assert.deepEqual([...second.filesRead], ['a.ts', 'b.ts']);

	// Third run seeds from the second digest — a.ts survives two hops.
	const secondText = buildWorkDigestText(second);
	assert.ok(secondText);
	const third = createWorkDigest();
	seedWorkDigestFromText(third, secondText);
	assert.deepEqual([...third.filesRead], ['a.ts', 'b.ts']);
});

test('seedWorkDigestFromMessages reads the digest out of an assistant transcript turn', () => {
	const digestText = buildWorkDigestText(digestOf([['read_file', { path: 'a.ts' }]]));
	assert.ok(digestText);
	const messages: IAgentMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: 'question' }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
		{ role: 'assistant', content: [{ type: 'text', text: digestText }] },
	];
	const digest = createWorkDigest();
	seedWorkDigestFromMessages(digest, messages);
	assert.deepEqual([...digest.filesRead], ['a.ts']);
});

test('seeding ignores a body with no digest block and drops the truncation marker', () => {
	const noBlock = createWorkDigest();
	seedWorkDigestFromText(noBlock, 'just a normal reply, nothing to seed');
	assert.equal(summarizeWorkDigest(noBlock).toolCalls, 0);

	// A capped list seeds the named files but not the "…+N more" marker.
	const capped = createWorkDigest();
	for (let i = 0; i < 45; i++) {
		recordWorkDigest(capped, 'read_file', { path: `f${i}.ts` });
	}
	const reseeded = createWorkDigest();
	seedWorkDigestFromText(reseeded, buildWorkDigestText(capped)!);
	assert.equal(reseeded.filesRead.size, 40, 'exactly the capped 40 seed back, marker skipped');
});

test('kill switch: MELLIVORA_WORK_DIGEST=off disables, anything else enables', () => {
	assert.equal(isWorkDigestEnabled({ MELLIVORA_WORK_DIGEST: 'off' }), false);
	assert.equal(isWorkDigestEnabled({ MELLIVORA_WORK_DIGEST: '1' }), true);
	assert.equal(isWorkDigestEnabled({}), true);
});

test('remember_fact records facts into the digest, capped at MAX_FACTS', () => {
	const digest = createWorkDigest();
	for (let i = 0; i < 10; i++) {
		recordWorkDigest(digest, 'remember_fact', { fact: `fact-${i}` });
	}
	assert.equal(digest.facts.length, 8, 'capped at MAX_FACTS');
	assert.equal(recordWorkDigest(digest, 'remember_fact', { fact: '   ' }), true, 'tracked as a tool call even when the fact is blank');
	assert.equal(recordWorkDigest(digest, 'remember_fact', {}), true);
	assert.equal(digest.facts.length, 8, 'blank/malformed facts add nothing');
});

test('known facts render as one line and round-trip through seed', () => {
	const original = createWorkDigest();
	recordWorkDigest(original, 'remember_fact', { fact: 'data root = ~/.mellivora' });
	recordWorkDigest(original, 'remember_fact', { fact: 'run logs live in logs/' });
	const text = buildWorkDigestText(original);
	assert.ok(text?.includes('Known facts: data root = ~/.mellivora | run logs live in logs/'));

	const seeded = createWorkDigest();
	seedWorkDigestFromText(seeded, text!);
	assert.deepEqual(seeded.facts, ['data root = ~/.mellivora', 'run logs live in logs/']);
});

test('facts count toward the summary toolCalls', () => {
	const digest = createWorkDigest();
	recordWorkDigest(digest, 'remember_fact', { fact: 'a = 1' });
	recordWorkDigest(digest, 'remember_fact', { fact: 'b = 2' });
	assert.equal(summarizeWorkDigest(digest).toolCalls, 2);
});
