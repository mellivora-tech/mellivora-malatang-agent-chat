/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, globToRegExp, invalid, resolveInWorkspace, toWorkspacePath, valid, walkFiles, workspaceMatchPath } from './workspace.js';

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 240;
/** Context is capped so a wide `context` × many matches can't dump a whole file. */
const MAX_CONTEXT = 20;
/** Hard ceiling on emitted lines once context expands each match into a block. */
const MAX_OUTPUT_LINES = 4000;

interface IGrepInput {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
	readonly context?: number;
}

/** Merge match indices into inclusive line ranges, coalescing overlapping/adjacent windows. */
function contextRanges(matchIdx: readonly number[], ctx: number, lineCount: number): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const idx of matchIdx) {
		const lo = Math.max(0, idx - ctx);
		const hi = Math.min(lineCount - 1, idx + ctx);
		const last = ranges[ranges.length - 1];
		// +1 so windows that merely touch (no gap between them) still merge into one block.
		if (last && lo <= last[1] + 1) {
			last[1] = Math.max(last[1], hi);
		} else {
			ranges.push([lo, hi]);
		}
	}
	return ranges;
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

export function createGrepTool(roots: readonly string[]): IAgentTool {
	return defineTool({
		name: 'grep',
		description:
			'Search file contents by JavaScript regular expression. Returns "path:line: text" matches; ignores node_modules, .git, build output and binary files. ' +
			'Set `context` to also return N lines around each match (context lines use "path-line- text") — one grep with context often answers what would otherwise be a grep followed by a read_file.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'JavaScript regular expression to search for.' },
				path: { type: 'string', description: 'Directory to search under, relative to the workspace root. Defaults to the root.' },
				glob: { type: 'string', description: 'Only search files whose relative path matches this glob (e.g. "**/*.ts").' },
				ignoreCase: { type: 'boolean', description: 'Case-insensitive match. Defaults to false.' },
				context: {
					type: 'integer',
					minimum: 0,
					maximum: MAX_CONTEXT,
					description: `Lines of surrounding context to include on each side of a match (0–${MAX_CONTEXT}, default 0). Prefer this over a follow-up read_file when you just need to see a match in situ.`,
				},
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
			if (record.context !== undefined && (typeof record.context !== 'number' || !Number.isInteger(record.context) || record.context < 0 || record.context > MAX_CONTEXT)) {
				return invalid(`"context" must be an integer between 0 and ${MAX_CONTEXT}`);
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { pattern, path, glob, ignoreCase, context: ctxInput } = input as IGrepInput;
			const ctx = typeof ctxInput === 'number' ? ctxInput : 0;
			// A `path` scopes to one directory; otherwise every code root is searched.
			const searchDirs = path !== undefined ? [resolveInWorkspace(roots, path)] : [...roots];
			const regExp = new RegExp(pattern, ignoreCase ? 'i' : '');
			const globRegExp = glob ? globToRegExp(glob) : undefined;

			// `blocks` groups per-file (and, with context, per-window) output; a `--`
			// separator is inserted between non-contiguous blocks at join time.
			const blocks: string[][] = [];
			let matchCount = 0;
			let emittedLines = 0;
			let truncated = false;
			// `remaining` counts against the match budget, not the (larger) context-expanded line count.
			const trim = (line: string): string => line.trim().slice(0, MAX_LINE_LENGTH);
			outer: for (const dir of searchDirs) {
				for await (const absolute of walkFiles(dir, { signal: context.signal })) {
					if (globRegExp && !globRegExp.test(workspaceMatchPath(roots, absolute))) {
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

					const display = toWorkspacePath(roots, absolute);
					const fileLines = buffer.toString('utf8').split('\n');
					const matchIdx: number[] = [];
					for (let i = 0; i < fileLines.length; i++) {
						if (regExp.test(fileLines[i]!)) {
							matchIdx.push(i);
							if (matchCount + matchIdx.length >= MAX_MATCHES) {
								truncated = true;
								break;
							}
						}
					}
					if (matchIdx.length === 0) {
						continue;
					}
					matchCount += matchIdx.length;

					if (ctx === 0) {
						// Flat "path:line: text" — one line per match (original behaviour).
						blocks.push(matchIdx.map(i => `${display}:${i + 1}: ${trim(fileLines[i]!)}`));
						emittedLines += matchIdx.length;
					} else {
						// One block per merged window; match lines use ":line:", context lines "-line-".
						const matchSet = new Set(matchIdx);
						for (const [lo, hi] of contextRanges(matchIdx, ctx, fileLines.length)) {
							const block: string[] = [];
							for (let li = lo; li <= hi; li++) {
								const sep = matchSet.has(li) ? ':' : '-';
								block.push(`${display}${sep}${li + 1}${sep} ${trim(fileLines[li]!)}`);
							}
							blocks.push(block);
							emittedLines += block.length;
						}
					}

					if (truncated || emittedLines >= MAX_OUTPUT_LINES) {
						truncated = truncated || emittedLines >= MAX_OUTPUT_LINES;
						break outer;
					}
				}
			}

			if (blocks.length === 0) {
				return { content: `No matches for /${pattern}/${ignoreCase ? 'i' : ''}.` };
			}

			// With context, separate blocks with "--" (ripgrep convention); without, a plain newline join keeps the flat list.
			let content = ctx === 0 ? blocks.map(b => b.join('\n')).join('\n') : blocks.map(b => b.join('\n')).join('\n--\n');
			if (truncated) {
				content += `\n\n[… stopped at ${MAX_MATCHES} matches; refine the pattern or scope with glob/path.]`;
			}
			return { content };
		},
	});
}
