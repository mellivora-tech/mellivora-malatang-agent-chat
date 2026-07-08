/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, globToRegExp, invalid, resolveInWorkspace, toWorkspacePath, valid, walkFiles } from './workspace.js';

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 240;

interface IGrepInput {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
}

/** A NUL byte in the head of the buffer is a reliable "this is binary" signal. */
function looksBinary(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 4096);
	for (let i = 0; i < limit; i++) {
		if (buffer[i] === 0) {
			return true;
		}
	}
	return false;
}

export function createGrepTool(cwd: string): IAgentTool {
	return defineTool({
		name: 'grep',
		description: 'Search file contents by JavaScript regular expression. Returns "path:line: text" matches; ignores node_modules, .git, build output and binary files.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'JavaScript regular expression to search for.' },
				path: { type: 'string', description: 'Directory to search under, relative to the workspace root. Defaults to the root.' },
				glob: { type: 'string', description: 'Only search files whose relative path matches this glob (e.g. "**/*.ts").' },
				ignoreCase: { type: 'boolean', description: 'Case-insensitive match. Defaults to false.' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			if (typeof record.pattern !== 'string' || record.pattern.length === 0) {
				return invalid('"pattern" must be a non-empty string');
			}
			try {
				new RegExp(record.pattern);
			} catch (error) {
				return invalid(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (record.path !== undefined && typeof record.path !== 'string') {
				return invalid('"path" must be a string');
			}
			if (record.glob !== undefined && typeof record.glob !== 'string') {
				return invalid('"glob" must be a string');
			}
			if (record.ignoreCase !== undefined && typeof record.ignoreCase !== 'boolean') {
				return invalid('"ignoreCase" must be a boolean');
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { pattern, path, glob, ignoreCase } = input as IGrepInput;
			const root = resolveInWorkspace(cwd, path ?? '.');
			const regExp = new RegExp(pattern, ignoreCase ? 'i' : '');
			const globRegExp = glob ? globToRegExp(glob) : undefined;

			const lines: string[] = [];
			let truncated = false;
			outer: for await (const absolute of walkFiles(root, { signal: context.signal })) {
				const relative = toWorkspacePath(cwd, absolute);
				if (globRegExp && !globRegExp.test(relative)) {
					continue;
				}

				const info = await stat(absolute);
				if (info.size > MAX_FILE_BYTES) {
					continue;
				}
				const buffer = await readFile(absolute);
				if (looksBinary(buffer)) {
					continue;
				}

				const fileLines = buffer.toString('utf8').split('\n');
				for (let i = 0; i < fileLines.length; i++) {
					if (regExp.test(fileLines[i]!)) {
						const text = fileLines[i]!.trim().slice(0, MAX_LINE_LENGTH);
						lines.push(`${relative}:${i + 1}: ${text}`);
						if (lines.length >= MAX_MATCHES) {
							truncated = true;
							break outer;
						}
					}
				}
			}

			if (lines.length === 0) {
				return { content: `No matches for /${pattern}/${ignoreCase ? 'i' : ''}.` };
			}

			let content = lines.join('\n');
			if (truncated) {
				content += `\n\n[… stopped at ${MAX_MATCHES} matches; refine the pattern or scope with glob/path.]`;
			}
			return { content };
		},
	});
}
