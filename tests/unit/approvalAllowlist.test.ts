/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveGrant, isAlwaysAllowable, matchesAllowlist } from '../../src/main/agent/approvalAllowlist.js';

/** A session allowlist built by "always allow"-ing each of the given calls. */
function allowlistFrom(calls: readonly (readonly [string, unknown])[]): Set<string> {
	const set = new Set<string>();
	for (const [toolName, input] of calls) {
		for (const pattern of deriveGrant(toolName, input)?.patterns ?? []) {
			set.add(pattern);
		}
	}
	return set;
}

test('only bash / write_file / edit_file are always-allowable', () => {
	assert.equal(isAlwaysAllowable('bash'), true);
	assert.equal(isAlwaysAllowable('write_file'), true);
	assert.equal(isAlwaysAllowable('edit_file'), true);
	assert.equal(isAlwaysAllowable('run_on_server'), false);
	assert.equal(isAlwaysAllowable('query_data_source'), false);
});

test('bash grant is the leading token as a word-boundary prefix', () => {
	const grant = deriveGrant('bash', { command: 'mvn test -DskipTests' });
	assert.deepEqual(grant?.patterns, ['bash:mvn']);
	assert.equal(grant?.display, 'mvn *');
});

test('word-boundary prefix: `mvn *` matches `mvn test` but never `mvnd`', () => {
	const allowlist = allowlistFrom([['bash', { command: 'mvn test' }]]);
	assert.equal(matchesAllowlist('bash', { command: 'mvn test -q' }, allowlist), true);
	assert.equal(matchesAllowlist('bash', { command: 'mvn' }, allowlist), true);
	assert.equal(matchesAllowlist('bash', { command: 'mvnd test' }, allowlist), false, 'mvnd must not be covered by mvn');
	assert.equal(matchesAllowlist('bash', { command: 'rm -rf /' }, allowlist), false);
});

test('compound command: grant covers every sub-command token', () => {
	const grant = deriveGrant('bash', { command: 'git pull && mvn test | tee log' });
	assert.deepEqual(grant?.patterns, ['bash:git', 'bash:mvn', 'bash:tee']);
	assert.equal(grant?.display, 'git *, mvn *, tee *');
});

test('deny-first: a compound line passes only if ALL sub-commands are allowlisted', () => {
	const allowlist = allowlistFrom([['bash', { command: 'git status' }]]);
	// git is allowed, but the second sub-command (rm) is not → the whole line asks.
	assert.equal(matchesAllowlist('bash', { command: 'git status && rm -rf build' }, allowlist), false);
	// Allowlist rm too, and now the compound passes.
	allowlist.add('bash:rm');
	assert.equal(matchesAllowlist('bash', { command: 'git status && rm -rf build' }, allowlist), true);
});

test('an empty bash command offers no grant and never matches', () => {
	assert.equal(deriveGrant('bash', { command: '   ' }), undefined);
	assert.equal(deriveGrant('bash', {}), undefined);
	assert.equal(matchesAllowlist('bash', { command: '' }, new Set(['bash:mvn'])), false);
});

test('edit/write share one `edit:*` grant covering all file changes this session', () => {
	const writeGrant = deriveGrant('write_file', { path: 'src/a.ts' });
	const editGrant = deriveGrant('edit_file', { path: 'src/b.ts' });
	assert.deepEqual(writeGrant?.patterns, ['edit:*']);
	assert.deepEqual(editGrant?.patterns, ['edit:*']);

	const allowlist = allowlistFrom([['edit_file', { path: 'src/b.ts' }]]);
	// Allow-all-edits covers both edit_file and write_file, any path.
	assert.equal(matchesAllowlist('edit_file', { path: 'anything.ts' }, allowlist), true);
	assert.equal(matchesAllowlist('write_file', { path: 'other.ts' }, allowlist), true);
	// ...but not bash.
	assert.equal(matchesAllowlist('bash', { command: 'ls' }, allowlist), false);
});

test('SAFETY: run_on_server can never be granted or matched, even with a full allowlist', () => {
	// It offers no grant, so the "always allow" button is never shown for SSH.
	assert.equal(deriveGrant('run_on_server', { command: 'systemctl restart prod' }), undefined);
	// And even against an allowlist that (somehow) holds every pattern, it never matches —
	// prod SSH write protection cannot be bypassed by the session allowlist.
	const everything = new Set(['edit:*', 'bash:systemctl', 'bash:rm', 'bash:ssh']);
	assert.equal(matchesAllowlist('run_on_server', { command: 'systemctl restart prod' }, everything), false);
	assert.equal(matchesAllowlist('query_data_source', { sql: 'DROP TABLE t' }, everything), false);
});
