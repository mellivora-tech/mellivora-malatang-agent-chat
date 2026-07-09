/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, requireString, resolveInWorkspace, toWorkspacePath, valid } from './workspace.js';

interface IWriteFileInput {
	readonly path: string;
	readonly content: string;
}

export function createWriteFileTool(cwd: string): IAgentTool {
	return defineTool({
		name: 'write_file',
		description: 'Create or overwrite a UTF-8 text file in the workspace. Parent directories are created as needed. Prefer edit_file for changing part of an existing file.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root.' },
				content: { type: 'string', description: 'Full file contents to write.' },
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'path');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			if (typeof record.content !== 'string') {
				return invalid('"content" must be a string');
			}
			return valid(record);
		},
		call: async input => {
			const { path, content } = input as IWriteFileInput;
			const absolute = resolveInWorkspace(cwd, path);

			let existed = false;
			try {
				existed = (await stat(absolute)).isFile();
			} catch {
				// New file.
			}

			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, content, 'utf8');
			const lines = content === '' ? 0 : content.split('\n').length;
			return { content: `${existed ? 'Overwrote' : 'Created'} ${toWorkspacePath(cwd, absolute)} (${lines} lines).` };
		},
	});
}
