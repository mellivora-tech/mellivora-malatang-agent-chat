/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { defineTool } from '../../src/main/agent/agentTools.js';
import { asPermissionMode, createGateForMode, describeToolCall } from '../../src/main/agent/permission.js';
import type { IAgentTool } from '../../src/main/agent/agentTypes.js';

function stubTool(name: string, readOnly: boolean): IAgentTool {
	return defineTool({
		name,
		description: name,
		inputSchema: { type: 'object' },
		validateInput: input => ({ ok: true, value: input }),
		isReadOnly: () => readOnly,
		call: async () => ({ content: 'ok' }),
	});
}

const readTool = stubTool('read_file', true);
const editTool = stubTool('edit_file', false);
const writeTool = stubTool('write_file', false);
const bashTool = stubTool('bash', false);
const context = { toolUseId: 't1' };

function approvals(result: boolean): { handler: (tool: IAgentTool) => Promise<boolean>; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		handler: async tool => {
			calls.push(tool.name);
			return result;
		},
	};
}

test('asPermissionMode falls back to ask (fail-closed)', () => {
	assert.equal(asPermissionMode('full'), 'full');
	assert.equal(asPermissionMode('plan'), 'plan');
	assert.equal(asPermissionMode('auto-edit'), 'auto-edit');
	assert.equal(asPermissionMode(undefined), 'ask');
	assert.equal(asPermissionMode('sudo'), 'ask');
});

test('full mode allows everything without asking', async () => {
	const { handler, calls } = approvals(false);
	const gate = createGateForMode('full', handler);
	assert.equal((await gate.check(bashTool, {}, context)).behavior, 'allow');
	assert.deepEqual(calls, []);
});

test('plan mode allows read-only and denies mutations outright', async () => {
	const { handler, calls } = approvals(true);
	const gate = createGateForMode('plan', handler);
	assert.equal((await gate.check(readTool, {}, context)).behavior, 'allow');
	assert.equal((await gate.check(editTool, {}, context)).behavior, 'deny');
	assert.equal((await gate.check(bashTool, {}, context)).behavior, 'deny');
	assert.deepEqual(calls, [], 'plan mode never asks — it denies');
});

test('ask mode auto-allows read-only and routes every mutation to approval', async () => {
	const approved = approvals(true);
	const gate = createGateForMode('ask', approved.handler);
	assert.equal((await gate.check(readTool, {}, context)).behavior, 'allow');
	assert.equal((await gate.check(editTool, {}, context)).behavior, 'allow');
	assert.deepEqual(approved.calls, ['edit_file']);

	const denied = approvals(false);
	const denyGate = createGateForMode('ask', denied.handler);
	assert.equal((await denyGate.check(bashTool, {}, context)).behavior, 'deny');
	assert.deepEqual(denied.calls, ['bash']);
});

test('auto-edit mode runs file edits unattended but still asks for bash', async () => {
	const { handler, calls } = approvals(true);
	const gate = createGateForMode('auto-edit', handler);
	assert.equal((await gate.check(writeTool, {}, context)).behavior, 'allow');
	assert.equal((await gate.check(editTool, {}, context)).behavior, 'allow');
	assert.deepEqual(calls, [], 'edits do not ask');
	assert.equal((await gate.check(bashTool, {}, context)).behavior, 'allow');
	assert.deepEqual(calls, ['bash'], 'bash asks');
});

test('describeToolCall summarizes the mutation for the prompt', () => {
	assert.equal(describeToolCall('bash', { command: 'npm test' }), 'npm test');
	assert.equal(describeToolCall('write_file', { path: 'src/a.ts', content: '' }), 'write src/a.ts');
	assert.equal(describeToolCall('edit_file', { path: 'b.md' }), 'edit b.md');
});

test('full mode still asks for a bash sandbox escape — and only for that', async () => {
	const approved = approvals(true);
	const gate = createGateForMode('full', approved.handler);
	// Plain bash, even mutating, stays unattended in full mode.
	assert.equal((await gate.check(bashTool, { command: 'mvn compile' }, context)).behavior, 'allow');
	assert.deepEqual(approved.calls, []);
	// disable_sandbox removes the last guard → approval fires.
	assert.equal((await gate.check(bashTool, { command: 'mvn compile', disable_sandbox: true }, context)).behavior, 'allow');
	assert.deepEqual(approved.calls, ['bash']);

	const declined = approvals(false);
	const strictGate = createGateForMode('full', declined.handler);
	const denied = await strictGate.check(bashTool, { command: 'rm -rf /', disable_sandbox: true }, context);
	assert.equal(denied.behavior, 'deny');
});

test('describeToolCall marks a sandbox escape so the approval card reads differently', () => {
	assert.equal(describeToolCall('bash', { command: 'mvn compile' }), 'mvn compile');
	assert.equal(describeToolCall('bash', { command: 'mvn compile', disable_sandbox: true }), '[沙箱外] mvn compile');
});
