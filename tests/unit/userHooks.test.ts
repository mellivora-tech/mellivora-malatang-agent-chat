/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommandHook, parseUserHookConfig } from '../../src/main/agent/hooks/userHooks.js';
import type { IHookDecision } from '../../src/main/agent/hooks/hooks.js';

/** A shell command that runs a node one-liner (single-quoted, so use double quotes inside the script). */
function nodeCmd(script: string): string {
	return `"${process.execPath}" -e '${script}'`;
}

async function fire(command: string, input: Record<string, unknown> = { event: 'PreToolUse' }, timeoutMs = 4000): Promise<IHookDecision> {
	const hook = createCommandHook({ id: 't', event: 'PreToolUse', command, timeoutMs });
	return (await hook.run({ event: 'PreToolUse', ...input })) as IHookDecision;
}

// --- config parsing --------------------------------------------------------------

test('parseUserHookConfig: a valid entry parses; id is derived when absent', () => {
	const full = parseUserHookConfig({ id: 'my-hook', event: 'PreToolUse', command: 'echo hi', toolMatcher: '^bash$', timeoutMs: 2000 }, 0);
	assert.deepEqual(full, { id: 'my-hook', event: 'PreToolUse', command: 'echo hi', toolMatcher: '^bash$', timeoutMs: 2000 });

	const derived = parseUserHookConfig({ event: 'Stop', command: 'echo hi' }, 3);
	assert.equal(derived?.id, 'user:Stop:3', 'id derived from event + index');
});

test('parseUserHookConfig: malformed entries reject (never throw)', () => {
	assert.equal(parseUserHookConfig(null, 0), undefined);
	assert.equal(parseUserHookConfig({ event: 'NotAnEvent', command: 'x' }, 0), undefined, 'unknown event');
	assert.equal(parseUserHookConfig({ event: 'Stop', command: '   ' }, 0), undefined, 'empty command');
	assert.equal(parseUserHookConfig({ event: 'Stop', command: 'x', toolMatcher: '([' }, 0), undefined, 'invalid regex matcher');
	assert.equal(parseUserHookConfig({ event: 'Stop', command: 'x', timeoutMs: 0 }, 0), undefined, 'non-positive timeout');
	assert.equal(parseUserHookConfig({ event: 'Stop', command: 'x', timeoutMs: 'soon' }, 0), undefined, 'non-numeric timeout');
});

// --- command execution + I/O contract --------------------------------------------

test('command hook: JSON stdout drives the decision (block / allow+context / modify)', async () => {
	const blocked = await fire(nodeCmd('console.log(JSON.stringify({decision:"block",reason:"nope"}))'));
	assert.equal(blocked.decision, 'block');
	assert.equal(blocked.reason, 'nope');

	const injected = await fire(nodeCmd('console.log(JSON.stringify({decision:"allow",additionalContext:"reminder!"}))'));
	assert.equal(injected.decision, 'allow');
	assert.equal(injected.additionalContext, 'reminder!');

	const modified = await fire(nodeCmd('console.log(JSON.stringify({decision:"modify",modifiedInput:{x:9}}))'));
	assert.equal(modified.decision, 'modify');
	assert.deepEqual(modified.modifiedInput, { x: 9 });
});

test('command hook: non-JSON stdout on exit 0 becomes injected context; exit 2 blocks', async () => {
	const context = await fire(nodeCmd('console.log("plain reminder")'));
	assert.equal(context.decision, 'allow');
	assert.equal(context.additionalContext, 'plain reminder');

	const blocked = await fire(nodeCmd('process.stderr.write("boom");process.exit(2)'));
	assert.equal(blocked.decision, 'block');
	assert.equal(blocked.reason, 'boom');
});

test('command hook: the input is delivered as JSON on stdin', async () => {
	const script =
		'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify({decision:"allow",additionalContext:"tool="+JSON.parse(d).toolName})))';
	const decision = await fire(nodeCmd(script), { toolName: 'bash' });
	assert.equal(decision.additionalContext, 'tool=bash', 'the hook input reached the command via stdin');
});

test('command hook: fail-open — timeout, a crash, and a missing command all resolve to allow', async () => {
	const timedOut = await fire(nodeCmd('setTimeout(()=>console.log("late"),10000)'), { event: 'PreToolUse' }, 200);
	assert.deepEqual(timedOut, { decision: 'allow' }, 'a hook that overruns its timeout never blocks');

	const crashed = await fire(nodeCmd('process.exit(7)'));
	assert.equal(crashed.decision, 'allow', 'an unexpected non-zero exit is fail-open, not a block');

	const missing = await fire('this_command_definitely_does_not_exist_xyz_123');
	assert.equal(missing.decision, 'allow', 'a command that cannot run never harms the run');
});
