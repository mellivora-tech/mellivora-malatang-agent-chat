/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { presentChangedFiles } from '../../src/sessions/contrib/changes/browser/changesView.js';

test('presentChangedFiles: real per-file rows with signed labels and extension icons', () => {
	const presentation = presentChangedFiles({
		files: 3,
		additions: 12,
		deletions: 3,
		changedFiles: [
			{ path: 'src/app/main.ts', added: 10, removed: 3 },
			{ path: 'package.json', added: 1, removed: 0 },
			{ path: 'docs/notes.md', added: 1, removed: 0, status: 'untracked' },
		],
	});
	assert.equal(presentation.kind, 'rows');
	if (presentation.kind === 'rows') {
		assert.deepEqual(presentation.rows, [
			{ path: 'src/app/main.ts', icon: 'codicon-file-code', addedLabel: '+10', removedLabel: '-3' },
			{ path: 'package.json', icon: 'codicon-json', addedLabel: '+1', removedLabel: '-0' },
			{ path: 'docs/notes.md', icon: 'codicon-file-code', addedLabel: '+1', removedLabel: '-0' },
		]);
	}
});

test('presentChangedFiles: a pre-P2 summary (counts, no detail) is stale, not fabricated rows', () => {
	assert.deepEqual(presentChangedFiles({ files: 5, additions: 34, deletions: 8 }), { kind: 'stale' });
});

test('presentChangedFiles: no changes at all is the empty state', () => {
	assert.deepEqual(presentChangedFiles({ files: 0, additions: 0, deletions: 0 }), { kind: 'empty' });
	assert.deepEqual(presentChangedFiles({ files: 0, additions: 0, deletions: 0, changedFiles: [] }), { kind: 'empty' });
});
