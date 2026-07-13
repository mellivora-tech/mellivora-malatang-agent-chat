/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IAgentTool } from '../../src/main/agent/agentTypes.js';
import type { SshRunner } from '../../src/main/agent/sshExec.js';
import { createSshTools, type ISshServer } from '../../src/main/agent/tools/sshTool.js';

const SERVERS: ISshServer[] = [
	{ id: 'srv-1', label: 'web', environmentName: 'dev', coordinates: { host: 'h1', port: 22, user: 'root', auth: 'password' } },
	{ id: 'srv-2', label: 'web', environmentName: 'prod', coordinates: { host: 'h2', port: 22, user: 'deploy', auth: 'key' } },
	{ id: 'srv-3', label: 'batch', environmentName: 'dev', coordinates: { host: 'h3', port: 2222, user: 'ubuntu', auth: 'password' } },
];

const context = { toolUseId: 't', signal: new AbortController().signal };

function byName(tools: readonly IAgentTool[], name: string): IAgentTool {
	const tool = tools.find(candidate => candidate.name === name);
	assert.ok(tool, `${name} registered`);
	return tool;
}
async function run(tool: IAgentTool, input: unknown): Promise<{ content: string; isError: boolean }> {
	const validation = tool.validateInput(input);
	assert.ok(validation.ok, `validation failed: ${validation.ok ? '' : validation.error}`);
	const result = await tool.call(validation.value, context);
	return { content: result.content, isError: result.isError ?? false };
}

test('run_on_server is a mutation-class tool (permission-gated), list_servers is read-only', () => {
	const tools = createSshTools({ servers: SERVERS, getSecret: async () => undefined });
	assert.equal(byName(tools, 'list_servers').isReadOnly({}), true);
	assert.equal(byName(tools, 'run_on_server').isReadOnly({}), false);
});

test('run_on_server resolves a unique label, runs the command, reports output + exit code', async () => {
	let seen: { host: string; command: string } | undefined;
	const runSsh: SshRunner = async (coordinates, _secret, command) => {
		seen = { host: coordinates.host, command };
		return { code: 0, output: 'uid=1000(ubuntu)\n' };
	};
	const tools = createSshTools({ servers: SERVERS, getSecret: async () => ({ password: 'pw' }), runSsh });
	const result = await run(byName(tools, 'run_on_server'), { server: 'batch', command: 'id' });
	assert.equal(result.isError, false);
	assert.equal(seen?.host, 'h3');
	assert.match(result.content, /uid=1000/);

	const failed = await run(byName(tools, 'run_on_server'), { server: 'batch', command: 'false' });
	// exit code surfaced when non-zero
	const failing: SshRunner = async () => ({ code: 1, output: '' });
	const tools2 = createSshTools({ servers: SERVERS, getSecret: async () => ({ password: 'pw' }), runSsh: failing });
	const nonzero = await run(byName(tools2, 'run_on_server'), { server: 'batch', command: 'false' });
	assert.equal(nonzero.isError, true);
	assert.match(nonzero.content, /exit code: 1/);
	void failed;
});

test('run_on_server refuses ambiguous / unknown servers and missing credentials', async () => {
	const runSsh: SshRunner = async () => ({ code: 0, output: '' });
	const noSecret = createSshTools({ servers: SERVERS, getSecret: async () => undefined, runSsh });
	const exec = byName(noSecret, 'run_on_server');

	const ambiguous = await run(exec, { server: 'web', command: 'ls' });
	assert.equal(ambiguous.isError, true);
	assert.match(ambiguous.content, /srv-1, srv-2/);

	const unknown = await run(exec, { server: 'nope', command: 'ls' });
	assert.equal(unknown.isError, true);

	// password auth, no password on file → refused before connecting.
	const noPassword = await run(exec, { server: 'srv-3', command: 'ls' });
	assert.equal(noPassword.isError, true);
	assert.match(noPassword.content, /no password/);

	// key auth, no private key → refused.
	const keyServer = createSshTools({ servers: SERVERS, getSecret: async () => ({}), runSsh });
	const noKey = await run(byName(keyServer, 'run_on_server'), { server: 'srv-2', command: 'ls' });
	assert.equal(noKey.isError, true);
	assert.match(noKey.content, /no private key/);
});
