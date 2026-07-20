/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { createLanguageServerManager, type ILanguageServerManager } from '../../src/main/agent/lsp/languageServerManager.js';
import type { ServerOverrides } from '../../src/main/agent/lsp/serverResolver.js';

const MOCK_SERVER = fileURLToPath(new URL('./helpers/mockLspServer.js', import.meta.url));

// targetFn spans 0-based lines 2–4, matching the mock server's advertised range.
const FIXTURE = ['// fixture', '', 'function targetFn(a) {', '  return a + 1;', '}', '// end'].join('\n');

async function withManager(body: (manager: ILanguageServerManager, root: string, fixtureAbs: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'lsp-test-'));
	const fixtureAbs = join(root, 'sample.ts');
	await writeFile(fixtureAbs, FIXTURE, 'utf8');
	const overrides: ServerOverrides = { typescript: ['node', MOCK_SERVER, pathToFileURL(fixtureAbs).toString()] };
	const manager = createLanguageServerManager([root], overrides);
	try {
		await body(manager, root, fixtureAbs);
	} finally {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
}

test('read_symbol with a file hint returns the full definition body via documentSymbol', async () => {
	await withManager(async (manager, _root, fixtureAbs) => {
		const hit = await manager.readSymbol('targetFn', fixtureAbs);
		assert.ok(!('error' in hit), `expected a hit, got ${JSON.stringify(hit)}`);
		assert.equal(hit.startLine, 3); // 1-based
		assert.equal(hit.endLine, 5);
		assert.match(hit.text, /function targetFn\(a\) \{/);
		assert.match(hit.text, /return a \+ 1;/);
		assert.doesNotMatch(hit.text, /\/\/ end/); // body only, not the trailing line
	});
});

test('read_symbol without a hint locates the file via workspace/symbol, then reads the body', async () => {
	await withManager(async manager => {
		const hit = await manager.readSymbol('targetFn');
		assert.ok(!('error' in hit), `expected a hit, got ${JSON.stringify(hit)}`);
		assert.equal(hit.startLine, 3);
		assert.match(hit.text, /return a \+ 1;/);
	});
});

test('read_symbol reports a clear miss when the symbol is not defined', async () => {
	await withManager(async (manager, _root, fixtureAbs) => {
		const result = await manager.readSymbol('doesNotExist', fixtureAbs);
		assert.ok('error' in result);
		assert.match(result.error, /not found/);
	});
});

test('read_symbol degrades gracefully (error result, never a throw) when the server fails to start', async () => {
	const root = await mkdtemp(join(tmpdir(), 'lsp-badsrv-'));
	await writeFile(join(root, 'sample.ts'), FIXTURE, 'utf8');
	// A bogus launch command: the process dies immediately, so initialize can't complete.
	const overrides: ServerOverrides = { typescript: ['node', join(root, 'does-not-exist.js')] };
	const manager = createLanguageServerManager([root], overrides);
	try {
		const result = await manager.readSymbol('targetFn', join(root, 'sample.ts'));
		assert.ok('error' in result, 'a dead server must surface as an error result, not a hit');
	} finally {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
