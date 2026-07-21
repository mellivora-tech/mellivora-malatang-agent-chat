/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { HookRegistry, runHooks, type IHook, type IHookDecision } from '../../src/main/agent/hooks/hooks.js';
import { createReplyVerifierHook } from '../../src/main/agent/hooks/builtinHooks.js';
import type { IModelClient } from '../../src/main/agent/agentTypes.js';

/** A trivial hook that returns a fixed decision, ignoring its input. */
function fixed(id: string, decision: IHookDecision): IHook {
	return { id, event: 'Stop', run: () => decision };
}

test('runHooks: all-allow yields allow with no reason/context', async () => {
	const outcome = await runHooks([fixed('a', { decision: 'allow' }), fixed('b', { decision: 'allow' })], { event: 'Stop' });
	assert.deepEqual(outcome, { decision: 'allow' });
});

test('runHooks: any block wins; reasons and blockedBy aggregate', async () => {
	const outcome = await runHooks([fixed('a', { decision: 'allow' }), fixed('b', { decision: 'block', reason: 'nope-b' }), fixed('c', { decision: 'block', reason: 'nope-c' })], {
		event: 'Stop',
	});
	assert.equal(outcome.decision, 'block');
	assert.deepEqual(outcome.blockedBy, ['b', 'c']);
	assert.equal(outcome.reason, 'nope-b\nnope-c');
});

test('runHooks: additionalContext accumulates across hooks — even under a block', async () => {
	const outcome = await runHooks([fixed('a', { decision: 'allow', additionalContext: 'ctx-a' }), fixed('b', { decision: 'block', reason: 'r', additionalContext: 'ctx-b' })], {
		event: 'Stop',
	});
	assert.equal(outcome.decision, 'block');
	assert.equal(outcome.additionalContext, 'ctx-a\nctx-b');
});

test('runHooks: modify chains — each hook sees the previous modifiedInput', async () => {
	const bump: IHook = {
		id: 'bump',
		event: 'PreToolUse',
		run: input => ({ decision: 'modify', modifiedInput: { n: ((input.toolInput as { n: number }).n ?? 0) + 1 } }),
	};
	const outcome = await runHooks([bump, { ...bump, id: 'bump2' }], { event: 'PreToolUse', toolName: 'bash', toolInput: { n: 0 } });
	assert.equal(outcome.decision, 'modify');
	assert.deepEqual(outcome.modifiedInput, { n: 2 });
});

test('runHooks: a throwing hook is skipped (fail-open), others still apply', async () => {
	const boom: IHook = {
		id: 'boom',
		event: 'Stop',
		run: () => {
			throw new Error('hook exploded');
		},
	};
	const outcome = await runHooks([boom, fixed('ok', { decision: 'block', reason: 'still-here' })], { event: 'Stop' });
	assert.equal(outcome.decision, 'block');
	assert.deepEqual(outcome.blockedBy, ['ok'], 'the broken hook did not block or crash; the healthy one still did');
});

test('HookRegistry.forEvent: filters by event and by tool matcher', () => {
	const registry = new HookRegistry();
	const stopHook = fixed('stop', { decision: 'allow' });
	const bashOnly: IHook = { id: 'bash', event: 'PreToolUse', toolMatcher: /^(bash|query_data_source)$/, run: () => ({ decision: 'allow' }) };
	const anyTool: IHook = { id: 'any', event: 'PreToolUse', run: () => ({ decision: 'allow' }) };
	registry.register(stopHook);
	registry.register(bashOnly);
	registry.register(anyTool);

	assert.deepEqual(
		registry.forEvent('Stop').map(h => h.id),
		['stop'],
	);
	assert.deepEqual(
		registry.forEvent('PreToolUse', 'bash').map(h => h.id),
		['bash', 'any'],
		'matcher hit + matcher-less both apply',
	);
	assert.deepEqual(
		registry.forEvent('PreToolUse', 'read_file').map(h => h.id),
		['any'],
		'the bash-only matcher is filtered out for a non-matching tool',
	);
});

// --- built-in reply-verifier Stop hook (design §7 first migration) ---

/** Minimal IModelClient stub: streams one text reply, or throws to exercise fail-open. */
function stubClient(reply: string | Error): IModelClient {
	return {
		stream() {
			if (reply instanceof Error) {
				throw reply;
			}
			return (async function* () {
				yield { type: 'text_delta', text: reply } as const;
			})();
		},
	} as unknown as IModelClient;
}

const signal = () => new AbortController().signal;

test('reply-verifier hook: judge NO → block with retry feedback', async () => {
	const hook = createReplyVerifierHook({ client: stubClient('NO\ntalks about a different topic'), signal });
	const decision = await hook.run({ event: 'Stop', question: '把订单表迁到新库', answer: '今天天气不错' });
	assert.equal(decision.decision, 'block');
	assert.match(decision.reason ?? '', /did not address the user's actual message/);
	assert.match(decision.reason ?? '', /把订单表迁到新库/);
	assert.match(decision.note ?? '', /verdict=fail/);
});

test('reply-verifier hook: judge YES → allow; judge error → allow (fail-open); empty answer → allow', async () => {
	const yes = await createReplyVerifierHook({ client: stubClient('YES\naddresses it'), signal }).run({ event: 'Stop', question: 'q', answer: 'a' });
	assert.equal(yes.decision, 'allow');
	assert.match(yes.note ?? '', /verdict=pass/);

	const errored = await createReplyVerifierHook({ client: stubClient(new Error('judge down')), signal }).run({ event: 'Stop', question: 'q', answer: 'a' });
	assert.equal(errored.decision, 'allow', 'a broken judge never blocks a normal reply');

	const empty = await createReplyVerifierHook({ client: stubClient('NO\nx'), signal }).run({ event: 'Stop', question: 'q', answer: '   ' });
	assert.equal(empty.decision, 'allow', 'nothing to verify without a real reply');
});
