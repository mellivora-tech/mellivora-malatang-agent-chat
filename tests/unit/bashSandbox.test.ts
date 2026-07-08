/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildBashSandboxProfile, sandboxedShellCommand } from '../../src/main/agent/tools/bashSandbox.js';

test('the profile allows writes only under the workspace and scratch dirs', () => {
	const profile = buildBashSandboxProfile('/repo/project');
	assert.match(profile, /\(allow default\)/);
	assert.match(profile, /\(deny file-write\*\)/);
	assert.match(profile, /\(subpath "\/repo\/project"\)/);
	// Home config/system paths are not in the writable allowlist.
	assert.doesNotMatch(profile, /\(subpath "\/etc"\)/);
});

test('sandboxedShellCommand can be disabled with AGENT_CHAT_BASH_SANDBOX=off', () => {
	const off = sandboxedShellCommand('echo hi', '/repo', { AGENT_CHAT_BASH_SANDBOX: 'off' });
	assert.equal(off.sandboxed, false);
	assert.equal(off.file, '/bin/sh');
	assert.deepEqual(off.args, ['-c', 'echo hi']);
});

// Real Seatbelt enforcement — macOS only.
const darwinWithSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

test('sandbox confines writes to the workspace, denies outside, keeps reads', { skip: !darwinWithSandbox }, () => {
	const cwd = mkdtempSync(join(tmpdir(), 'mmac-sb-'));
	const outside = join(homedir(), '.mmac-sandbox-should-not-exist');

	const run = (command: string): { code: number | null } => {
		const { file, args, sandboxed } = sandboxedShellCommand(command, cwd, process.env);
		assert.equal(sandboxed, true, 'sandboxed on darwin');
		return { code: spawnSync(file, args, { cwd, encoding: 'utf8' }).status };
	};

	// Inside the workspace: allowed.
	assert.equal(run('echo hi > inside.txt').code, 0);
	assert.equal(readFileSync(join(cwd, 'inside.txt'), 'utf8').trim(), 'hi');

	// Outside the workspace (home dir): denied → non-zero exit, file never created.
	assert.notEqual(run(`echo leak > ${outside}`).code, 0, 'writing outside the workspace is denied');
	assert.equal(existsSync(outside), false, 'the outside file was never created');

	// Reads outside are still allowed (builds/git need them).
	assert.equal(run('cat /etc/hosts > /dev/null').code, 0);
});
