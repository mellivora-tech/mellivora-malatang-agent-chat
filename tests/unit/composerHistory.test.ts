/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { caretOnFirstLine, caretOnLastLine, collectPromptHistory, PromptHistoryCursor } from '../../src/sessions/browser/parts/composerHistory.js';

test('collectPromptHistory trims, drops blanks, and collapses duplicates onto the newest occurrence', () => {
	assert.deepEqual(collectPromptHistory(['a', '  ', 'b', 'a', 'c ']), ['b', 'a', 'c']);
});

test('collectPromptHistory keeps only the newest `limit` unique entries', () => {
	const texts = Array.from({ length: 60 }, (_, i) => `prompt ${i}`);
	const entries = collectPromptHistory(texts);
	assert.equal(entries.length, 50);
	assert.equal(entries[0], 'prompt 10', 'oldest surviving entry');
	assert.equal(entries.at(-1), 'prompt 59', 'newest stays last');
});

test('caret guards only pass a collapsed caret on the first/last line', () => {
	assert.equal(caretOnFirstLine('ab\ncd', 1, 1), true);
	assert.equal(caretOnFirstLine('ab\ncd', 4, 4), false, 'caret on line 2');
	assert.equal(caretOnFirstLine('ab', 0, 2), false, 'selection is not a caret');
	assert.equal(caretOnLastLine('ab\ncd', 4, 4), true);
	assert.equal(caretOnLastLine('ab\ncd', 1, 1), false, 'caret on line 1');
});

test('cursor walks newest→oldest on up, back to the draft on down, and stops at the oldest', () => {
	const cursor = new PromptHistoryCursor(['one', 'two', 'three'], 'draft');
	assert.equal(cursor.active, false);
	assert.equal(cursor.up(), 'three');
	assert.equal(cursor.up(), 'two');
	assert.equal(cursor.up(), 'one');
	assert.equal(cursor.up(), undefined, 'oldest entry is a wall, not a wrap');
	assert.equal(cursor.up(), undefined);
	assert.equal(cursor.down(), 'two');
	assert.equal(cursor.down(), 'three');
	assert.equal(cursor.down(), 'draft', 'past the newest entry the draft comes back');
	assert.equal(cursor.active, false, 'returning to the draft deactivates');
});

test('cancel restores the draft from any depth', () => {
	const cursor = new PromptHistoryCursor(['one', 'two'], 'draft');
	cursor.up();
	cursor.up();
	assert.equal(cursor.cancel(), 'draft');
	assert.equal(cursor.active, false);
	assert.equal(cursor.up(), 'two', 'navigation can restart after cancel');
});
