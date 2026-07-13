/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdir } from 'node:fs/promises';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, resolveInWorkspace, valid } from './workspace.js';

const MAX_ENTRIES = 400;

interface IListDirInput {
	readonly path?: string;
}

export function createListDirTool(roots: readonly string[]): IAgentTool {
	return defineTool({
		name: 'list_dir',
		description: 'List the immediate entries of a directory in the workspace. Directories are suffixed with "/". Not recursive.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to the root.' },
			},
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input) ?? {};
			if (record.path !== undefined && typeof record.path !== 'string') {
				return invalid('"path" must be a string');
			}
			return valid(record);
		},
		call: async input => {
			const { path } = input as IListDirInput;
			const absolute = resolveInWorkspace(roots, path ?? '.');
			const entries = await readdir(absolute, { withFileTypes: true });
			if (entries.length === 0) {
				return { content: '(empty directory)' };
			}

			const sorted = [...entries].sort((a, b) => {
				const aDir = a.isDirectory() ? 0 : 1;
				const bDir = b.isDirectory() ? 0 : 1;
				return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name);
			});

			const shown = sorted.slice(0, MAX_ENTRIES).map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
			let content = shown.join('\n');
			if (sorted.length > MAX_ENTRIES) {
				content += `\n\n[… ${sorted.length - MAX_ENTRIES} more entries omitted]`;
			}
			return { content };
		},
	});
}
