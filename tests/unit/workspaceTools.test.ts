/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('mutating tools appear only with includeMutations, marked non-read-only', () => {
	const cwd = tmpdir();
	const readOnly = createWorkspaceTools(cwd).map(tool => tool.name);
	assert.deepEqual(readOnly, ['read_file', 'list_dir', 'glob', 'grep']);

	const all = byName(createWorkspaceTools(cwd, { includeMutations: true }));
	for (const name of ['write_file', 'edit_file', 'bash']) {
		assert.ok(all[name], `${name} registered`);
		assert.equal(all[name]!.isReadOnly({}), false, `${name} must not claim read-only`);
	}
});

test('write_file creates parents and reports overwrite; refuses escapes', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd, { includeMutations: true }));

	const created = await run(tools.write_file!, { path: 'deep/dir/new.txt', content: 'a\nb' });
	assert.match(created.content, /^Created deep\/dir\/new\.txt/);
	assert.equal(await readFile(join(cwd, 'deep/dir/new.txt'), 'utf8'), 'a\nb');

	const overwrote = await run(tools.write_file!, { path: 'deep/dir/new.txt', content: 'c' });
	assert.match(overwrote.content, /^Overwrote/);

	await assert.rejects(() => run(tools.write_file!, { path: '../outside.txt', content: 'x' }), /escapes the workspace/);
});

test('edit_file replaces a unique match and rejects ambiguity without replace_all', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd, { includeMutations: true }));
	await writeFile(join(cwd, 'multi.txt'), 'aaa bbb aaa\n');

	const ambiguous = await run(tools.edit_file!, { path: 'multi.txt', old_string: 'aaa', new_string: 'zzz' });
	assert.equal(ambiguous.isError, true);
	assert.match(ambiguous.content, /occurs 2 times/);

	const all = await run(tools.edit_file!, { path: 'multi.txt', old_string: 'aaa', new_string: 'zzz', replace_all: true });
	assert.match(all.content, /2 replacements/);
	assert.equal(await readFile(join(cwd, 'multi.txt'), 'utf8'), 'zzz bbb zzz\n');

	const missing = await run(tools.edit_file!, { path: 'multi.txt', old_string: 'nope', new_string: 'x' });
	assert.equal(missing.isError, true);
});

test('bash runs in the workspace cwd and reports failures', async () => {
	const cwd = await fixture();
	const tools = byName(createWorkspaceTools(cwd, { includeMutations: true }));

	const pwd = await run(tools.bash!, { command: 'pwd' });
	assert.equal(pwd.isError, false);
	assert.ok(pwd.content.trim().endsWith(cwd.split('/').pop()!), `runs in workspace: ${pwd.content}`);

	const fail = await run(tools.bash!, { command: 'exit 3' });
	assert.equal(fail.isError, true);
	assert.match(fail.content, /Exit code: 3/);
});
