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

// ── bash verify 分类 (2026-08-05 Verified 结论行) ──

test('bash: test runners classify as test, with counts parsed from the summary', () => {
	const nodeTest = deriveWorkStepMeta('bash', 'ℹ tests 41\nℹ pass 41\nℹ fail 0\n', 'node --test dist/tests/unit/*.test.js');
	assert.deepEqual(nodeTest, { verify: { kind: 'test', passed: 41, failed: 0 } });

	const vitest = deriveWorkStepMeta('bash', ' Test Files  5 passed (5)\n      Tests  38 passed (38)\n', 'npm test');
	assert.deepEqual(vitest, { verify: { kind: 'test', passed: 38 } }, 'no failures reported → no failed key');

	const jest = deriveWorkStepMeta('bash', 'Tests:       2 failed, 38 passed, 40 total\n', 'pnpm test');
	assert.deepEqual(jest, { verify: { kind: 'test', passed: 38, failed: 2 } });

	const cargo = deriveWorkStepMeta('bash', 'test result: ok. 12 passed; 0 failed; 0 ignored\n', 'cargo test');
	assert.deepEqual(cargo, { verify: { kind: 'test', passed: 12, failed: 0 } });

	// A runner with no countable summary (go test) still classifies, just without counts.
	assert.deepEqual(deriveWorkStepMeta('bash', 'ok  \texample.com/pkg\t0.3s\n', 'go test ./...'), { verify: { kind: 'test' } });
});

test('bash: typecheck / lint / format classify; mutating forms never do', () => {
	assert.deepEqual(deriveWorkStepMeta('bash', '', 'npx tsc -p tsconfig.json'), { verify: { kind: 'typecheck' } });
	assert.deepEqual(deriveWorkStepMeta('bash', '', 'npx eslint src/'), { verify: { kind: 'lint' } });
	assert.deepEqual(deriveWorkStepMeta('bash', 'All matched files use Prettier code style!\n', 'npx prettier --check src'), { verify: { kind: 'format' } });
	assert.deepEqual(deriveWorkStepMeta('bash', '', 'CI=true npm test'), { verify: { kind: 'test' } }, 'env prefixes are stripped');

	assert.equal(deriveWorkStepMeta('bash', '', 'npx prettier --write src'), undefined, '--write mutates');
	assert.equal(deriveWorkStepMeta('bash', '', 'npx eslint --fix src'), undefined, '--fix mutates');
});

test('bash: fail-closed — chains, pipes and ordinary commands never classify', () => {
	assert.equal(deriveWorkStepMeta('bash', '', 'npm test && git push'), undefined);
	assert.equal(deriveWorkStepMeta('bash', '', 'npm test | tee out.log'), undefined);
	assert.equal(deriveWorkStepMeta('bash', '', 'npm run build'), undefined);
	assert.equal(deriveWorkStepMeta('bash', '', 'git status'), undefined);
	assert.equal(deriveWorkStepMeta('bash', ''), undefined, 'no command, no classification');
});
