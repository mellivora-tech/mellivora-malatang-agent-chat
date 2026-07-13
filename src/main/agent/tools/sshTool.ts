/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDataSourceSecret, IServerCoordinates } from '../../../sessions/services/environments/common/environments.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { runSsh, type SshRunner } from '../sshExec.js';
import { asRecord, invalid, requireString, valid } from './workspace.js';

const TIMEOUT_MS = 120_000;

/** A server the agent may SSH into, with resolved coordinates (secret fetched per command). */
export interface ISshServer {
	readonly id: string;
	readonly label: string;
	readonly environmentName: string;
	readonly coordinates: IServerCoordinates;
}

export interface ISshToolDeps {
	readonly servers: readonly ISshServer[];
	getSecret(dataSourceId: string): Promise<IDataSourceSecret | undefined>;
	/** Injectable for tests; defaults to the real ssh2-backed runner. */
	readonly runSsh?: SshRunner;
}

function describe(server: ISshServer): string {
	const c = server.coordinates;
	return `- ${server.label} (env: ${server.environmentName}, ${c.user}@${c.host}:${c.port}, ${c.auth === 'key' ? 'key' : 'password'} auth, id: ${server.id})`;
}

/**
 * Build the SSH tools for a run: `list_servers` (what's configured) and
 * `run_on_server` (execute a command). Command execution is NOT read-only — it
 * runs through the permission gate like bash. Credentials (password / key) come
 * from the encrypted store, resolved per command.
 */
export function createSshTools(deps: ISshToolDeps): readonly IAgentTool[] {
	const run = deps.runSsh ?? runSsh;

	const resolve = (source: string): ISshServer | ISshServer[] | undefined => {
		const byId = deps.servers.find(candidate => candidate.id === source);
		if (byId) {
			return byId;
		}
		const byLabel = deps.servers.filter(candidate => candidate.label === source);
		return byLabel.length === 1 ? byLabel[0] : byLabel.length > 1 ? byLabel : undefined;
	};

	const listTool = defineTool({
		name: 'list_servers',
		description: "List the project's configured servers (label, environment, user@host). Use run_on_server with a label or id to execute a command.",
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: () => valid({}),
		call: async () => ({ content: deps.servers.length > 0 ? deps.servers.map(describe).join('\n') : 'No servers are configured for this project.' }),
	});

	const execTool = defineTool({
		name: 'run_on_server',
		description: 'Run a shell command over SSH on a configured server and return its output. `server` is its label or id — see list_servers. May pause for approval.',
		inputSchema: {
			type: 'object',
			properties: {
				server: { type: 'string', description: 'The server label or id.' },
				command: { type: 'string', description: 'The shell command to run over SSH.' },
			},
			required: ['server', 'command'],
			additionalProperties: false,
		},
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'server');
				requireString(record, 'command');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { server, command } = input as { server: string; command: string };
			const match = resolve(server);
			if (!match) {
				return { content: `No server named "${server}". Call list_servers to see the options.`, isError: true };
			}
			if (Array.isArray(match)) {
				return { content: `"${server}" is ambiguous across environments — pass one of these ids: ${match.map(candidate => candidate.id).join(', ')}.`, isError: true };
			}
			const secret = await deps.getSecret(match.id);
			if (match.coordinates.auth === 'key' && !secret?.privateKey) {
				return { content: `Server "${match.label}" has no private key configured. Set it in the project's Server config.`, isError: true };
			}
			if (match.coordinates.auth === 'password' && !secret?.password) {
				return { content: `Server "${match.label}" has no password configured. Set it in the project's Server config.`, isError: true };
			}
			const result = await run(match.coordinates, secret, command, { signal: context.signal, timeoutMs: TIMEOUT_MS });
			const body = result.output.trim() === '' ? '(no output)' : result.output;
			const status = result.code === 0 ? '' : `\n\n[exit code: ${result.code ?? 'n/a'}]`;
			return { content: `${body}${status}`, isError: result.code !== 0 };
		},
	});

	return [listTool, execTool];
}
