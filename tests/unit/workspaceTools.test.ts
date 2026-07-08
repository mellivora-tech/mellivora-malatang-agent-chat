/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceTools } from '../../src/main/agent/tools/index.js';
import type { IAgentTool } from '../../src/main/agent/agentTypes.js';

const context = { toolUseId: 'test', signal: new AbortController().signal };

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'mmac-tools-'));
	await mkdir(join(root, 'src'), { recursive: true });
	await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
	await writeFile(join(root, 'README.md'), 'hello world\nsecond line\n');
	await writeFile(join(root, 'src', 'a.ts'), 'export const answer = 42;\n');
	await writeFile(join(root, 'src', 'b.ts'), 'import { answer } from "./a";\nconsole.log(answer);\n');
	await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'export const answer = 0;\n');
	return root;
}

function byName(tools: readonly IAgentTool[]): Record<string, IAgentTool> {
	return Object.fromEntries(tools.map(tool => [tool.name, tool]));
}

async function run(tool: IAgentTool, input: unknown): Promise<{ content: string; isError: boolean }> {
	const validation = tool.validateInput(input);
	assert.ok(validation.ok, `validation failed: ${validation.ok ? '' : validation.error}`);
	const result = await tool.call(validation.value, context);
	return { content: result.content, isError: result.isError ?? false };
}

test('read_file returns contents and pages with offset/limit', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd));

	const full = await run(tools.read_file!, { path: 'README.md' });
	assert.match(full.content, /hello world/);

	const paged = await run(tools.read_file!, { path: 'README.md', offset: 2, limit: 1 });
	assert.equal(paged.content, 'second line');
});

test('list_dir lists entries with a trailing slash on directories', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd));

	const result = await run(tools.list_dir!, { path: '.' });
	assert.match(result.content, /^src\/$/m);
	assert.match(result.content, /^README\.md$/m);
});

test('glob matches by pattern and skips node_modules', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd));

	const result = await run(tools.glob!, { pattern: '**/*.ts' });
	assert.match(result.content, /src\/a\.ts/);
	assert.match(result.content, /src\/b\.ts/);
	assert.doesNotMatch(result.content, /node_modules/);
});

test('grep finds content and reports path:line', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd));

	const result = await run(tools.grep!, { pattern: 'answer', glob: '**/*.ts' });
	assert.match(result.content, /src\/a\.ts:1:/);
	assert.doesNotMatch(result.content, /node_modules/);
});

test('paths that escape the workspace are refused', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd));

	await assert.rejects(() => run(tools.read_file!, { path: '../../../etc/passwd' }), /escapes the workspace/);
});
