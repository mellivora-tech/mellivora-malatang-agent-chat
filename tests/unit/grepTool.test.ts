/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { IAgentTool } from '../../src/main/agent/agentTypes.js';
import { createGrepTool } from '../../src/main/agent/tools/grepTool.js';

const context = { toolUseId: 't', signal: new AbortController().signal };

async function run(tool: IAgentTool, input: unknown): Promise<{ content: string; isError: boolean }> {
	const validation = tool.validateInput(input);
	assert.ok(validation.ok, `validation failed: ${validation.ok ? '' : validation.error}`);
	const result = await tool.call(validation.value, context);
	return { content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), isError: result.isError ?? false };
}

async function withWorkspace(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'grep-test-'));
	try {
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(root, name), content, 'utf8');
		}
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const SAMPLE = ['line one', 'line two', 'target here', 'line four', 'line five'].join('\n');

test('grep without context returns the flat "path:line: text" form', async () => {
	await withWorkspace({ 'a.txt': SAMPLE }, async root => {
		const result = await run(createGrepTool([root]), { pattern: 'target' });
		assert.match(result.content, /a\.txt:3: target here/);
		// No context lines and no window separators.
		assert.doesNotMatch(result.content, /a\.txt-\d+-/);
		assert.doesNotMatch(result.content, /^--$/m);
	});
});

test('grep with context includes surrounding lines marked with "-line-"', async () => {
	await withWorkspace({ 'a.txt': SAMPLE }, async root => {
		const result = await run(createGrepTool([root]), { pattern: 'target', context: 1 });
		// The match keeps the ":line:" separator; neighbours use "-line-".
		assert.match(result.content, /a\.txt:3: target here/);
		assert.match(result.content, /a\.txt-2- line two/);
		assert.match(result.content, /a\.txt-4- line four/);
		// One line above and below only — line one / five stay out.
		assert.doesNotMatch(result.content, /line one/);
		assert.doesNotMatch(result.content, /line five/);
	});
});

test('grep merges adjacent context windows into one block', async () => {
	const dense = ['a', 'hit b', 'c', 'hit d', 'e'].join('\n');
	await withWorkspace({ 'a.txt': dense }, async root => {
		const result = await run(createGrepTool([root]), { pattern: 'hit', context: 1 });
		// Two matches one line apart → windows overlap → a single block, no "--" inside.
		assert.doesNotMatch(result.content, /\n--\n/);
		assert.match(result.content, /a\.txt:2: hit b/);
		assert.match(result.content, /a\.txt:4: hit d/);
		assert.match(result.content, /a\.txt-3- c/);
	});
});

test('grep rejects out-of-range context', async () => {
	await withWorkspace({ 'a.txt': SAMPLE }, async root => {
		const tool = createGrepTool([root]);
		assert.equal(tool.validateInput({ pattern: 'x', context: 21 }).ok, false);
		assert.equal(tool.validateInput({ pattern: 'x', context: -1 }).ok, false);
		assert.equal(tool.validateInput({ pattern: 'x', context: 1.5 }).ok, false);
	});
});
