/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { sandboxedShellCommand } from './bashSandbox.js';
import { asRecord, invalid, optionalPositiveInt, requireString, valid } from './workspace.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

interface IBashInput {
	readonly command: string;
	readonly timeout_ms?: number;
}

/**
 * Runs a shell command with the workspace as cwd. On macOS it runs inside a
 * Seatbelt sandbox that confines file WRITES to the workspace and standard
 * scratch/cache dirs (reads and network stay open so builds/tests/git work);
 * elsewhere it is unsandboxed. Either way the permission gates route bash to
 * explicit approval in every mode short of full access.
 */
export function createBashTool(cwd: string): IAgentTool {
	return defineTool({
		name: 'bash',
		description: 'Run a shell command from the workspace root and return its output. Use for builds, tests, git, and other project commands.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The shell command to execute.' },
				timeout_ms: { type: 'integer', minimum: 1, description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
			},
			required: ['command'],
			additionalProperties: false,
		},
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'command');
				optionalPositiveInt(record, 'timeout_ms');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { command, timeout_ms } = input as IBashInput;
			const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

			return new Promise(resolve => {
				const { file, args } = sandboxedShellCommand(command, cwd, process.env);
				const child = spawn(file, args, { cwd, env: process.env });
				let output = '';
				let truncated = false;
				let settled = false;

				const collect = (chunk: Buffer): void => {
					if (output.length < MAX_OUTPUT_CHARS) {
						output += chunk.toString('utf8');
						if (output.length >= MAX_OUTPUT_CHARS) {
							output = output.slice(0, MAX_OUTPUT_CHARS);
							truncated = true;
						}
					}
				};
				child.stdout.on('data', collect);
				child.stderr.on('data', collect);

				const finish = (summary: string, isError: boolean): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					context.signal.removeEventListener('abort', onAbort);
					const body = output.trim() === '' ? '(no output)' : output;
					resolve({ content: `${body}${truncated ? '\n\n[output truncated]' : ''}${summary ? `\n\n${summary}` : ''}`, isError });
				};

				const timer = setTimeout(() => {
					child.kill('SIGKILL');
					finish(`Command timed out after ${timeout}ms.`, true);
				}, timeout);

				const onAbort = (): void => {
					child.kill('SIGKILL');
					finish('Command aborted.', true);
				};
				context.signal.addEventListener('abort', onAbort, { once: true });

				child.on('error', error => finish(`Failed to start command: ${error.message}`, true));
				child.on('close', code => finish(code === 0 ? '' : `Exit code: ${code}.`, code !== 0));
			});
		},
	});
}
