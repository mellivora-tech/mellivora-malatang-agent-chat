/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stat } from 'node:fs/promises';
import type { IDataSourceSecret, IServerCoordinates } from '../../../sessions/services/environments/common/environments.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { runSsh, uploadOverSsh, type SshRunner, type SshUploader } from '../sshExec.js';
import { asRecord, invalid, requireString, resolveInWorkspace, valid } from './workspace.js';

const TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** A server the agent may SSH into, with resolved coordinates (secret fetched per command). */
export interface ISshServer {
	readonly id: string;
	readonly label: string;
	readonly environmentName: string;
	readonly coordinates: IServerCoordinates;
}

export interface ISshToolDeps {
	readonly servers: readonly ISshServer[];
	/** Code roots — uploads may only source files from inside them (no exfiltrating ~/.ssh et al). */
	readonly roots: readonly string[];
	getSecret(dataSourceId: string): Promise<IDataSourceSecret | undefined>;
	/** Injectable for tests; defaults to the real ssh2-backed runner. */
	readonly runSsh?: SshRunner;
	/** Injectable for tests; defaults to the real ssh2 SFTP uploader. */
	readonly uploadOverSsh?: SshUploader;
	/** Side channel for mid-call progress (an SFTP upload blocks the loop) — agentIpc fans it out to the log and the renderer. */
	readonly report?: (event: { readonly type: 'tool_progress'; readonly toolUseId: string; readonly name: string; readonly note: string }) => void;
}

function formatMb(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
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

	// id → label → environment name, first unique match wins. The env fallback
	// lets "dev" resolve directly when the environment has exactly one server —
	// the model shouldn't need a list_servers round-trip for the common case.
	const resolve = (source: string): ISshServer | ISshServer[] | undefined => {
		const byId = deps.servers.find(candidate => candidate.id === source);
		if (byId) {
			return byId;
		}
		const byLabel = deps.servers.filter(candidate => candidate.label === source);
		if (byLabel.length > 0) {
			return byLabel.length === 1 ? byLabel[0] : byLabel;
		}
		const byEnvironment = deps.servers.filter(candidate => candidate.environmentName === source);
		return byEnvironment.length === 1 ? byEnvironment[0] : byEnvironment.length > 1 ? byEnvironment : undefined;
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
		description:
			'Run a shell command over SSH on a configured server and return its output. `server` is its label, id, or environment name (e.g. "dev") — see list_servers. May pause for approval. ' +
			'For long-lived processes (startup scripts, services) detach them — `nohup … > app.log 2>&1 &` — then verify via the log; a foreground service call just hits the timeout. ' +
			'To transfer files use upload_to_server; NEVER improvise transfers with netcat, base64 pasting, or temporary listeners.',
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

	const uploader = deps.uploadOverSsh ?? uploadOverSsh;
	const uploadTool = defineTool({
		name: 'upload_to_server',
		description:
			'Upload ONE file from the workspace to a configured server over SFTP. `server` is its label, id, or environment name — see list_servers. ' +
			'`local_path` must be inside the workspace (build artifacts, scripts); `remote_path` is the absolute destination file path. Always asks for approval.',
		inputSchema: {
			type: 'object',
			properties: {
				server: { type: 'string', description: 'The server label or id.' },
				local_path: { type: 'string', description: 'Workspace-relative (or absolute in-workspace) path of the file to upload.' },
				remote_path: { type: 'string', description: 'Absolute destination path on the server, including the file name.' },
			},
			required: ['server', 'local_path', 'remote_path'],
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
				requireString(record, 'local_path');
				requireString(record, 'remote_path');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { server, local_path, remote_path } = input as { server: string; local_path: string; remote_path: string };
			const match = resolve(server);
			if (!match) {
				return { content: `No server named "${server}". Call list_servers to see the options.`, isError: true };
			}
			if (Array.isArray(match)) {
				return { content: `"${server}" is ambiguous across environments — pass one of these ids: ${match.map(candidate => candidate.id).join(', ')}.`, isError: true };
			}
			// The workspace boundary is the anti-exfiltration line: only files the
			// agent could already read as project content may leave the machine.
			let localAbsolute: string;
			try {
				localAbsolute = resolveInWorkspace(deps.roots, local_path);
			} catch (error) {
				return { content: `local_path must be inside the workspace: ${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
			let size: number;
			try {
				const info = await stat(localAbsolute);
				if (!info.isFile()) {
					return { content: `local_path is not a regular file: ${local_path}`, isError: true };
				}
				size = info.size;
			} catch (error) {
				return { content: `Cannot read local file: ${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
			const secret = await deps.getSecret(match.id);
			if (match.coordinates.auth === 'key' && !secret?.privateKey) {
				return { content: `Server "${match.label}" has no private key configured. Set it in the project's Server config.`, isError: true };
			}
			if (match.coordinates.auth === 'password' && !secret?.password) {
				return { content: `Server "${match.label}" has no password configured. Set it in the project's Server config.`, isError: true };
			}
			const started = Date.now();
			// Progress throttle: a 95MB jar over LAN fires step every 32KB — emit
			// only on ≥2% advance or ≥1s, so the channel stays light (≤50 events).
			let lastPercent = -2;
			let lastEmit = 0;
			const onProgress = (transferred: number, total: number): void => {
				const percent = total > 0 ? Math.floor((transferred / total) * 100) : 0;
				const now = Date.now();
				// The completion tick always emits — it becomes the step's final label.
				if (percent - lastPercent < 2 && now - lastEmit < 1000 && transferred < total) {
					return;
				}
				lastPercent = percent;
				lastEmit = now;
				const rate = now > started ? (transferred / 1_048_576 / ((now - started) / 1000)).toFixed(1) : '0.0';
				deps.report?.({ type: 'tool_progress', toolUseId: context.toolUseId, name: 'upload_to_server', note: `上传 ${local_path} → ${match.label} · ${percent}% (${formatMb(transferred)}/${formatMb(total)}) · ${rate} MB/s` });
			};
			const result = await uploader(match.coordinates, secret, localAbsolute, remote_path, { signal: context.signal, timeoutMs: UPLOAD_TIMEOUT_MS, onProgress });
			if (!result.ok) {
				return { content: `Upload failed: ${result.detail}`, isError: true };
			}
			return { content: `Uploaded ${local_path} (${size} bytes) to ${match.label}:${remote_path} in ${Date.now() - started}ms.` };
		},
	});

	return [listTool, execTool, uploadTool];
}
