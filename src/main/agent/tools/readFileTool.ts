/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, optionalPositiveInt, requireString, resolveInWorkspace, valid } from './workspace.js';

const MAX_LINES = 2000;
const MAX_BYTES = 1_000_000;

interface IReadFileInput {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
}

export function createReadFileTool(cwd: string): IAgentTool {
	return defineTool({
		name: 'read_file',
		description: 'Read a UTF-8 text file from the workspace. Returns the file contents; use `offset` (1-based line) and `limit` to page through large files.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root.' },
				offset: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Defaults to the start.' },
				limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to read.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'path');
				optionalPositiveInt(record, 'offset');
				optionalPositiveInt(record, 'limit');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			return valid(record);
		},
		call: async input => {
			const { path, offset, limit } = input as IReadFileInput;
			const absolute = resolveInWorkspace(cwd, path);

			const info = await stat(absolute);
			if (info.isDirectory()) {
				return { content: `"${path}" is a directory. Use list_dir to inspect it.`, isError: true };
			}
			if (info.size > MAX_BYTES && offset === undefined && limit === undefined) {
				return { content: `File is large (${info.size} bytes). Re-read with offset/limit to page through it.`, isError: true };
			}

			const raw = await readFile(absolute, 'utf8');
			const lines = raw.split('\n');
			// Drop the empty element a trailing newline leaves behind, so line counts
			// and the truncation note reflect real content.
			if (lines.length > 1 && lines[lines.length - 1] === '') {
				lines.pop();
			}
			const start = offset === undefined ? 0 : offset - 1;
			const end = limit === undefined ? Math.min(lines.length, start + MAX_LINES) : Math.min(lines.length, start + limit);
			const selected = lines.slice(start, end);

			let content = selected.join('\n');
			const notes: string[] = [];
			if (end < lines.length) {
				notes.push(`… truncated at line ${end} of ${lines.length}; re-read with offset=${end + 1} to continue.`);
			}
			if (notes.length > 0) {
				content += `\n\n[${notes.join(' ')}]`;
			}
			return { content: content === '' ? '(empty file)' : content };
		},
	});
}
