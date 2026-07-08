/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from 'node:fs/promises';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, requireString, resolveInWorkspace, toWorkspacePath, valid } from './workspace.js';

interface IEditFileInput {
	readonly path: string;
	readonly old_string: string;
	readonly new_string: string;
	readonly replace_all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export function createEditFileTool(cwd: string): IAgentTool {
	return defineTool({
		name: 'edit_file',
		description: 'Replace an exact string in a workspace file. `old_string` must match exactly (including whitespace) and be unique in the file unless `replace_all` is true.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root.' },
				old_string: { type: 'string', description: 'Exact text to replace.' },
				new_string: { type: 'string', description: 'Replacement text.' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
			},
			required: ['path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'path');
				requireString(record, 'old_string');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			if (typeof record.new_string !== 'string') {
				return invalid('"new_string" must be a string');
			}
			if (record.old_string === record.new_string) {
				return invalid('"new_string" must differ from "old_string"');
			}
			if (record.replace_all !== undefined && typeof record.replace_all !== 'boolean') {
				return invalid('"replace_all" must be a boolean');
			}
			return valid(record);
		},
		call: async input => {
			const { path, old_string, new_string, replace_all } = input as IEditFileInput;
			const absolute = resolveInWorkspace(cwd, path);
			const display = toWorkspacePath(cwd, absolute);

			const original = await readFile(absolute, 'utf8');
			const occurrences = countOccurrences(original, old_string);
			if (occurrences === 0) {
				return { content: `old_string not found in ${display}. Read the file and match the text exactly.`, isError: true };
			}
			if (occurrences > 1 && !replace_all) {
				return { content: `old_string occurs ${occurrences} times in ${display}. Add surrounding context to make it unique, or set replace_all.`, isError: true };
			}

			const updated = replace_all ? original.split(old_string).join(new_string) : original.replace(old_string, new_string);
			await writeFile(absolute, updated, 'utf8');
			return { content: `Edited ${display} (${replace_all ? `${occurrences} replacements` : '1 replacement'}).` };
		},
	});
}
