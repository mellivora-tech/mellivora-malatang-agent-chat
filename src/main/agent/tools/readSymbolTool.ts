/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import type { ILanguageServerManager } from '../lsp/languageServerManager.js';
import { asRecord, invalid, requireString, resolveInWorkspace, toWorkspacePath, valid } from './workspace.js';

const MAX_BODY_LINES = 400;

interface IReadSymbolInput {
	readonly symbol: string;
	readonly path?: string;
}

export interface IReadSymbolDeps {
	readonly roots: readonly string[];
	readonly manager: ILanguageServerManager;
}

/**
 * read_symbol — return a symbol's whole definition (function/method/class body)
 * located by a language server, so the model skips the grep→sed two-step:
 * "find the line, then read the range" collapses into one call that already
 * knows the definition's full extent. Backed by LSP (workspace/symbol +
 * documentSymbol); if no server for the language is available it says so and
 * the model falls back to grep/read_file.
 */
export function createReadSymbolTool(deps: IReadSymbolDeps): IAgentTool {
	return defineTool({
		name: 'read_symbol',
		description:
			'Read the FULL definition of a named symbol (function, method, class, interface) — the whole body, located by a language server, not just the matching line. ' +
			"Prefer this over grep-then-read_file when you want to see how something is defined: it returns the definition's complete source in one call. " +
			'Pass `path` to pin the file/language when the name is ambiguous or the symbol lives in a known file. Java, TypeScript/JavaScript and Vue are supported; ' +
			"if no language server is installed for the file's language, it returns a note and you should fall back to grep + read_file.",
		inputSchema: {
			type: 'object',
			properties: {
				symbol: { type: 'string', description: 'The symbol name to define, e.g. "buildWorkflowDetail" or "DriveEngineServiceImpl".' },
				path: { type: 'string', description: 'Optional file (relative to the workspace root) to pin the language and search first — use it to disambiguate a common name.' },
			},
			required: ['symbol'],
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
				requireString(record, 'symbol');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			if (record.path !== undefined && typeof record.path !== 'string') {
				return invalid('"path" must be a string');
			}
			return valid(record);
		},
		call: async input => {
			const { symbol, path } = input as IReadSymbolInput;
			// The hint is resolved to an absolute path so the manager can pick the
			// containing root's server and open the exact file.
			const fileHint = path !== undefined ? resolveInWorkspace(deps.roots, path) : undefined;
			const result = await deps.manager.readSymbol(symbol, fileHint);
			if ('error' in result) {
				return { content: `read_symbol: ${result.error}` };
			}

			const display = toWorkspacePath(deps.roots, result.path);
			const bodyLines = result.text.split('\n');
			// Guard against a pathological "whole file is one symbol" range.
			const clipped = bodyLines.length > MAX_BODY_LINES;
			const shown = clipped ? bodyLines.slice(0, MAX_BODY_LINES).join('\n') : result.text;
			const header = `${display}:${result.startLine}-${result.endLine}`;
			const note = clipped
				? `\n\n[… definition is ${bodyLines.length} lines; showing the first ${MAX_BODY_LINES}. Use read_file with offset=${result.startLine} to page the rest.]`
				: '';
			return { content: `${header}\n\n${shown}${note}` };
		},
	});
}
