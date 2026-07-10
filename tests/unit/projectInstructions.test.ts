/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { formatInstructionsBlock, isProjectInstructionsEnabled, loadProjectInstructions } from '../../src/main/agent/projectInstructions.js';

async function fixture(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'mmac-instructions-'));
}

test('AGENTS.md at the root wins', async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, 'AGENTS.md'), '# House rules\nAlways run the unit suite.', 'utf8');
	await writeFile(join(cwd, 'CLAUDE.md'), 'should not be picked', 'utf8');

	const instructions = await loadProjectInstructions(cwd);
	assert.ok(instructions);
	assert.equal(instructions.file, 'AGENTS.md');
	assert.match(instructions.text, /House rules/);
	assert.equal(instructions.truncated, false);
});

test('CLAUDE.md is the fallback when AGENTS.md is absent', async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, 'CLAUDE.md'), 'claude-specific conventions', 'utf8');

	const instructions = await loadProjectInstructions(cwd);
	assert.equal(instructions?.file, 'CLAUDE.md');
});

test('no candidate files, or empty ones, yield undefined', async () => {
	const bare = await fixture();
	assert.equal(await loadProjectInstructions(bare), undefined);

	const empty = await fixture();
	await writeFile(join(empty, 'AGENTS.md'), '   \n\n  ', 'utf8');
	assert.equal(await loadProjectInstructions(empty), undefined, 'whitespace-only file is skipped');
});

test('an empty AGENTS.md falls through to a non-empty CLAUDE.md', async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, 'AGENTS.md'), '', 'utf8');
	await writeFile(join(cwd, 'CLAUDE.md'), 'fallback content', 'utf8');
	assert.equal((await loadProjectInstructions(cwd))?.file, 'CLAUDE.md');
});

test('oversized instructions are truncated at 40K chars with a marker', async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, 'AGENTS.md'), 'r'.repeat(50_000), 'utf8');

	const instructions = await loadProjectInstructions(cwd);
	assert.ok(instructions);
	assert.equal(instructions.truncated, true);
	assert.match(instructions.text, /\[instructions truncated at 40000 chars\]$/);
	assert.ok(instructions.text.length < 40_100);
});

test('kill switch: MELLIVORA_PROJECT_INSTRUCTIONS=off disables, anything else enables', () => {
	assert.equal(isProjectInstructionsEnabled({ MELLIVORA_PROJECT_INSTRUCTIONS: 'off' }), false);
	assert.equal(isProjectInstructionsEnabled({}), true);
});

test('the system-prompt block names the source file and carries the text', () => {
	const block = formatInstructionsBlock({ file: 'AGENTS.md', text: 'use tabs, not spaces', truncated: false });
	assert.match(block, /^Project instructions from AGENTS\.md/);
	assert.match(block, /use tabs, not spaces/);
});
