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
	const tools = createSshTools({ servers: SERVERS, roots: [], getSecret: async () => undefined });
	assert.equal(byName(tools, 'list_servers').isReadOnly({}), true);
	assert.equal(byName(tools, 'run_on_server').isReadOnly({}), false);
});

test('run_on_server resolves a unique label, runs the command, reports output + exit code', async () => {
	let seen: { host: string; command: string } | undefined;
	const runSsh: SshRunner = async (coordinates, _secret, command) => {
		seen = { host: coordinates.host, command };
		return { code: 0, output: 'uid=1000(ubuntu)\n' };
	};
	const tools = createSshTools({ servers: SERVERS, roots: [], getSecret: async () => ({ password: 'pw' }), runSsh });
	const result = await run(byName(tools, 'run_on_server'), { server: 'batch', command: 'id' });
	assert.equal(result.isError, false);
	assert.equal(seen?.host, 'h3');
	assert.match(result.content, /uid=1000/);

	const failed = await run(byName(tools, 'run_on_server'), { server: 'batch', command: 'false' });
	// exit code surfaced when non-zero
	const failing: SshRunner = async () => ({ code: 1, output: '' });
	const tools2 = createSshTools({ servers: SERVERS, roots: [], getSecret: async () => ({ password: 'pw' }), runSsh: failing });
	const nonzero = await run(byName(tools2, 'run_on_server'), { server: 'batch', command: 'false' });
	assert.equal(nonzero.isError, true);
	assert.match(nonzero.content, /exit code: 1/);
	void failed;
});

test('run_on_server refuses ambiguous / unknown servers and missing credentials', async () => {
	const runSsh: SshRunner = async () => ({ code: 0, output: '' });
	const noSecret = createSshTools({ servers: SERVERS, roots: [], getSecret: async () => undefined, runSsh });
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
	const keyServer = createSshTools({ servers: SERVERS, roots: [], getSecret: async () => ({}), runSsh });
	const noKey = await run(byName(keyServer, 'run_on_server'), { server: 'srv-2', command: 'ls' });
	assert.equal(noKey.isError, true);
	assert.match(noKey.content, /no private key/);
});

test('upload_to_server: refuses paths outside the workspace, uploads in-workspace files with size + duration', async () => {
	const { mkdtempSync, writeFileSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const root = mkdtempSync(join(tmpdir(), 'ssh-upload-'));
	writeFileSync(join(root, 'app.jar'), 'jar-bytes');

	const uploads: { local: string; remote: string }[] = [];
	const tools = createSshTools({
		servers: SERVERS,
		roots: [root],
		getSecret: async () => ({ password: 'pw' }),
		uploadOverSsh: async (_c, _s, local, remote) => {
			uploads.push({ local, remote });
			return { ok: true, detail: 'uploaded' };
		},
	});
	const upload = byName(tools, 'upload_to_server');
	assert.equal(upload.isReadOnly({}), false, 'upload is mutation-class (approval-gated)');

	// Anti-exfiltration: an out-of-workspace source is refused before any connection.
	const escape = await run(upload, { server: 'batch', local_path: '/etc/passwd', remote_path: '/tmp/x' });
	assert.ok(escape.isError);
	assert.match(escape.content, /inside the workspace/);
	assert.equal(uploads.length, 0);

	// Happy path: relative in-workspace file, byte count and destination reported.
	const ok = await run(upload, { server: 'batch', local_path: 'app.jar', remote_path: '/data/app.jar' });
	assert.ok(!ok.isError, ok.content);
	assert.match(ok.content, /9 bytes/);
	assert.match(ok.content, /batch:\/data\/app\.jar/);
	assert.deepEqual(uploads, [{ local: join(root, 'app.jar'), remote: '/data/app.jar' }]);
});

test('upload_to_server: transfer failure and missing credential are error results, not throws', async () => {
	const { mkdtempSync, writeFileSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const root = mkdtempSync(join(tmpdir(), 'ssh-upload-'));
	writeFileSync(join(root, 'a.txt'), 'x');

	const failing = createSshTools({
		servers: SERVERS,
		roots: [root],
		getSecret: async () => ({ password: 'pw' }),
		uploadOverSsh: async () => ({ ok: false, detail: 'SFTP upload error: permission denied' }),
	});
	const failed = await run(byName(failing, 'upload_to_server'), { server: 'batch', local_path: 'a.txt', remote_path: '/data/a.txt' });
	assert.ok(failed.isError);
	assert.match(failed.content, /Upload failed: SFTP upload error/);

	const noSecret = createSshTools({ servers: SERVERS, roots: [root], getSecret: async () => undefined });
	const denied = await run(byName(noSecret, 'upload_to_server'), { server: 'batch', local_path: 'a.txt', remote_path: '/data/a.txt' });
	assert.ok(denied.isError);
	assert.match(denied.content, /no password configured/);
});

test('upload_to_server: progress is throttled and carries percent + rate', async () => {
	const { mkdtempSync, writeFileSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const root = mkdtempSync(join(tmpdir(), 'ssh-upload-'));
	writeFileSync(join(root, 'big.jar'), 'x'.repeat(10));

	const notes: string[] = [];
	const tools = createSshTools({
		servers: SERVERS,
		roots: [root],
		getSecret: async () => ({ password: 'pw' }),
		report: event => notes.push(event.note),
		uploadOverSsh: async (_c, _s, _l, _r, options) => {
			// Simulate the ssh2 step callback: 100 chunks of 1%.
			for (let i = 1; i <= 100; i++) {
				options.onProgress?.(i, 100);
			}
			return { ok: true, detail: 'uploaded' };
		},
	});
	const result = await run(byName(tools, 'upload_to_server'), { server: 'batch', local_path: 'big.jar', remote_path: '/data/big.jar' });
	assert.ok(!result.isError, result.content);
	assert.ok(notes.length >= 2, 'progress reported');
	assert.ok(notes.length <= 60, `throttled (got ${notes.length})`);
	assert.match(notes[notes.length - 1]!, /100%/);
	assert.match(notes[0]!, /MB\/s/);
});
