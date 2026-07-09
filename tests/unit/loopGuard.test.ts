/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalStringify, createLoopGuard } from '../../src/main/agent/loopGuard.js';
import type { IToolUseBlock } from '../../src/main/agent/agentTypes.js';

function use(name: string, input: unknown, id = 'tu'): IToolUseBlock {
	return { type: 'tool_use', id, name, input };
}

test('third consecutive identical call is blocked; the first two pass', () => {
	const guard = createLoopGuard({});
	assert.equal(guard.check(use('grep', { pattern: 'x' })), undefined);
	assert.equal(guard.check(use('grep', { pattern: 'x' })), undefined);
	const verdict = guard.check(use('grep', { pattern: 'x' }));
	assert.ok(verdict, 'third identical call blocked');
	assert.equal(verdict.repeatCount, 3);
	assert.match(verdict.message, /Loop guard/);
	assert.match(verdict.message, /grep/);
});

test('the fourth identical call is still blocked (blocked calls count too)', () => {
	const guard = createLoopGuard({});
	guard.check(use('grep', { pattern: 'x' }));
	guard.check(use('grep', { pattern: 'x' }));
	guard.check(use('grep', { pattern: 'x' }));
	const fourth = guard.check(use('grep', { pattern: 'x' }));
	assert.ok(fourth);
	assert.equal(fourth.repeatCount, 4);
});

test('a different call resets the streak (A A B A never triggers)', () => {
	const guard = createLoopGuard({});
	assert.equal(guard.check(use('grep', { pattern: 'a' })), undefined);
	assert.equal(guard.check(use('grep', { pattern: 'a' })), undefined);
	assert.equal(guard.check(use('grep', { pattern: 'b' })), undefined);
	assert.equal(guard.check(use('grep', { pattern: 'a' })), undefined, 'streak was broken; the count restarted');
});

test('same tool with different inputs never triggers', () => {
	const guard = createLoopGuard({});
	assert.equal(guard.check(use('read_file', { path: 'a.ts' })), undefined);
	assert.equal(guard.check(use('read_file', { path: 'b.ts' })), undefined);
	assert.equal(guard.check(use('read_file', { path: 'c.ts' })), undefined);
});

test('key order does not defeat the guard: {a,b} and {b,a} are the same input', () => {
	const guard = createLoopGuard({});
	assert.equal(guard.check(use('read_file', { path: 'a.ts', offset: 1 })), undefined);
	assert.equal(guard.check(use('read_file', { offset: 1, path: 'a.ts' })), undefined);
	const verdict = guard.check(use('read_file', { path: 'a.ts', offset: 1 }));
	assert.ok(verdict, 'key-order variation still counted as identical');
});

test('AGENT_CHAT_LOOP_GUARD=off disables the guard entirely', () => {
	const guard = createLoopGuard({ AGENT_CHAT_LOOP_GUARD: 'off' });
	for (let i = 0; i < 6; i++) {
		assert.equal(guard.check(use('grep', { pattern: 'x' })), undefined);
	}
});

test('canonicalStringify sorts keys recursively and preserves array order', () => {
	assert.equal(canonicalStringify({ b: 1, a: { d: 2, c: 3 } }), canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }));
	assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]), 'array order is significant');
	assert.equal(canonicalStringify(null), 'null');
	assert.equal(canonicalStringify('x'), '"x"');
});
