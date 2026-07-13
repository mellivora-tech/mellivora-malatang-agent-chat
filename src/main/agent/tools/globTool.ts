/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, globToRegExp, invalid, resolveInWorkspace, toWorkspacePath, valid, walkFiles, workspaceMatchPath } from './workspace.js';

const MAX_RESULTS = 200;

interface IGlobInput {
	readonly pattern: string;
	readonly path?: string;
}

export function createGlobTool(roots: readonly string[]): IAgentTool {
	return defineTool({
		name: 'glob',
		description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{ts,css}"). Matches against workspace-relative paths; ignores node_modules, .git and build output.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Glob pattern. Use ** to match across directories.' },
				path: { type: 'string', description: 'Directory to search under, relative to the workspace root. Defaults to the root.' },
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
			if (record.path !== undefined && typeof record.path !== 'string') {
				return invalid('"path" must be a string');
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { pattern, path } = input as IGlobInput;
			// A `path` scopes to one directory; otherwise every code root is searched.
			const searchDirs = path !== undefined ? [resolveInWorkspace(roots, path)] : [...roots];
			const regExp = globToRegExp(pattern);

			const matches: string[] = [];
			let truncated = false;
			for (const dir of searchDirs) {
				for await (const absolute of walkFiles(dir, { signal: context.signal })) {
					if (regExp.test(workspaceMatchPath(roots, absolute))) {
						matches.push(toWorkspacePath(roots, absolute));
						if (matches.length >= MAX_RESULTS) {
							truncated = true;
							break;
						}
					}
				}
				if (truncated) {
					break;
				}
			}

			if (matches.length === 0) {
				return { content: `No files match "${pattern}".` };
			}

			matches.sort();
			let content = matches.join('\n');
			if (truncated) {
				content += `\n\n[… stopped at ${MAX_RESULTS} matches; narrow the pattern for more.]`;
			}
			return { content };
		},
	});
}
