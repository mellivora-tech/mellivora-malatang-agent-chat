/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveWorkStepMeta } from '../../src/sessions/services/sessions/common/session.js';

test('read_file: a normal read reports its byte size', () => {
	assert.deepEqual(deriveWorkStepMeta('read_file', 'x'.repeat(2048)), { bytes: 2048 });
});

test("read_file: the dedup guard's rejection is surfaced, not disguised as a read", () => {
	const dedup =
		'File "src/main/agent/tools/grepTool.ts" unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.';
	assert.deepEqual(deriveWorkStepMeta('read_file', dedup), { unchanged: true });
});

test('grep: flat match lines are counted; context lines and separators are not', () => {
	const content = ['src/a.ts:12: const x = 1;', 'src/a.ts-13- after', '--', 'src/b.ts:3: hit here'].join('\n');
	assert.deepEqual(deriveWorkStepMeta('grep', content), { hits: 2 });
});

test('grep: zero hits is a real, renderable signal', () => {
	assert.deepEqual(deriveWorkStepMeta('grep', 'No matches for /dataRoot/.'), { hits: 0 });
});

test('grep: filesOnly output counts one path per line', () => {
	assert.deepEqual(deriveWorkStepMeta('grep', 'src/a.ts\nsrc/b.ts\nsrc/c.ts'), { hits: 3 });
});

test('grep: the truncation note does not inflate the count', () => {
	const content = 'src/a.ts:1: hit\n\n[… stopped at 200 matches; refine the pattern or scope with glob/path.]';
	assert.deepEqual(deriveWorkStepMeta('grep', content), { hits: 1 });
});

test('glob: file lists count lines; empty results report zero', () => {
	assert.deepEqual(deriveWorkStepMeta('glob', 'a.ts\nb.ts'), { hits: 2 });
	assert.deepEqual(deriveWorkStepMeta('glob', 'No files match "**/*.xyz".'), { hits: 0 });
});

test('tools without a derivable semantics get no meta', () => {
	assert.equal(deriveWorkStepMeta('bash', 'total 42'), undefined);
	assert.equal(deriveWorkStepMeta('edit_file', 'Edited src/a.ts (1 replacement).'), undefined);
});
