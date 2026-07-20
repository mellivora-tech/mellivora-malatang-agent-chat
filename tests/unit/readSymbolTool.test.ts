/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import type { ILanguageServerManager, ISymbolHit } from '../../src/main/agent/lsp/languageServerManager.js';
import { createReadSymbolTool } from '../../src/main/agent/tools/readSymbolTool.js';

const ROOT = '/workspace/proj';
const context = { toolUseId: 't', signal: new AbortController().signal };

function managerReturning(result: ISymbolHit | { error: string }, spy?: (symbol: string, hint?: string) => void): ILanguageServerManager {
	return {
		async readSymbol(symbol, fileHint) {
			spy?.(symbol, fileHint);
			return result;
		},
		async dispose() {},
	};
}

async function run(tool: ReturnType<typeof createReadSymbolTool>, input: unknown): Promise<string> {
	const validation = tool.validateInput(input);
	assert.ok(validation.ok, `validation failed: ${validation.ok ? '' : validation.error}`);
	const result = await tool.call(validation.value, context);
	return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

test('read_symbol renders "path:start-end" + the body, with a workspace-relative path', async () => {
	const hit: ISymbolHit = { path: join(ROOT, 'src/Svc.ts'), startLine: 3, endLine: 5, text: 'function x() {\n  return 1;\n}' };
	const tool = createReadSymbolTool({ roots: [ROOT], manager: managerReturning(hit) });
	const content = await run(tool, { symbol: 'x' });
	assert.match(content, /^src\/Svc\.ts:3-5/);
	assert.match(content, /return 1;/);
});

test('read_symbol resolves a relative path hint to an absolute path for the manager', async () => {
	let seenHint: string | undefined;
	const tool = createReadSymbolTool({
		roots: [ROOT],
		manager: managerReturning({ path: join(ROOT, 'a.ts'), startLine: 1, endLine: 1, text: 'x' }, (_s, hint) => {
			seenHint = hint;
		}),
	});
	await run(tool, { symbol: 'x', path: 'src/a.ts' });
	assert.equal(seenHint, join(ROOT, 'src/a.ts'));
});

test('read_symbol passes a manager error through as a readable note, not a crash', async () => {
	const tool = createReadSymbolTool({ roots: [ROOT], manager: managerReturning({ error: 'no java language server found' }) });
	const content = await run(tool, { symbol: 'Foo' });
	assert.match(content, /read_symbol: no java language server found/);
});

test('read_symbol clips a pathologically large definition and points at read_file for the rest', async () => {
	const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
	const hit: ISymbolHit = { path: join(ROOT, 'Big.ts'), startLine: 10, endLine: 509, text: big };
	const tool = createReadSymbolTool({ roots: [ROOT], manager: managerReturning(hit) });
	const content = await run(tool, { symbol: 'Big' });
	assert.match(content, /showing the first 400/);
	assert.match(content, /offset=10/);
});
