/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IComponentSpec } from './catalog.js';
import { parseRawStatement, resolveProgram, splitStatements, type IDslError, type IDslProgram, type IDslStatement, type IParsedRaw } from './parser.js';

/**
 * Streaming support (#12 M3, design §2): Autocloser completes a truncated
 * trailing statement into legal text so everything already streamed renders
 * NOW, and the incremental parser memoizes per-statement parse results so a
 * growing stream costs O(new statements) per paint, not O(all statements)²
 * (OpenUI's statement-level cache, reproduced).
 */

/**
 * Complete a stream PREFIX into parseable text: close an open string, then
 * unwind the bracket stack. A dangling fragment that cannot be a statement
 * yet (`name`, `name =`) is dropped instead — rendering half a name helps
 * nobody. The completed tail may still fail arity validation (e.g.
 * `Text(` → `Text()`); that statement stays pending until more chunks arrive,
 * which is exactly the graceful-degradation contract.
 */
export function autocloseFragment(source: string): string {
	const stack: string[] = [];
	let inString = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i]!;
		if (inString) {
			if (ch === '\\') {
				i++;
			} else if (ch === '"') {
				inString = false;
			}
		} else if (ch === '"') {
			inString = true;
		} else if (ch === '(' || ch === '[') {
			stack.push(ch === '(' ? ')' : ']');
		} else if (ch === ')' || ch === ']') {
			stack.pop();
		}
	}
	if (!inString && stack.length === 0) {
		// Balanced already — but a dangling `name` / `name =` tail is not a
		// statement; cut it so the parser sees only complete lines.
		const lines = source.split('\n');
		const last = lines[lines.length - 1]?.trim() ?? '';
		if (last !== '' && !/=/.test(last)) {
			return lines.slice(0, -1).join('\n');
		}
		if (/=\s*$/.test(last)) {
			return lines.slice(0, -1).join('\n');
		}
		return source;
	}
	let closed = source;
	if (inString) {
		closed += '"';
	}
	for (let i = stack.length - 1; i >= 0; i--) {
		closed += stack[i];
	}
	return closed;
}

export interface IIncrementalParser {
	/** Feed the WHOLE accumulated stream text; returns the program view for this paint. `final` skips autoclosing (the stream is complete). */
	push(source: string, options?: { readonly final?: boolean }): IDslProgram;
	/** Memo hits since creation — observability for the O(N) claim. */
	readonly stats: { parses: number; hits: number };
}

export function createIncrementalParser(catalog: readonly IComponentSpec[]): IIncrementalParser {
	const byName = new Map(catalog.map(component => [component.name, component]));
	// Keyed by the statement's exact text — lines shift as the stream grows, so
	// results are re-stamped with the current line on reuse.
	const memo = new Map<string, IParsedRaw>();
	const stats = { parses: 0, hits: 0 };

	const parseMemo = (text: string, line: number): IParsedRaw => {
		const cached = memo.get(text);
		if (cached) {
			stats.hits++;
			if (cached.statement) {
				return { statement: { ...cached.statement, line } };
			}
			if (cached.error) {
				return { error: { ...cached.error, line } };
			}
			return cached;
		}
		stats.parses++;
		const parsed = parseRawStatement(text, line, byName);
		memo.set(text, parsed);
		return parsed;
	};

	return {
		stats,
		push(source, options) {
			const effective = options?.final ? source : autocloseFragment(source);
			const raw = splitStatements(effective);
			const errors: IDslError[] = [];
			const statements = new Map<string, IDslStatement>();
			for (const { text, line } of raw) {
				const parsed = parseMemo(text, line);
				if (parsed.error) {
					errors.push(parsed.error);
				} else if (parsed.statement) {
					statements.set(parsed.statement.name, parsed.statement);
				}
			}
			// Mid-stream, a missing root/unresolved forward ref is EXPECTED — the
			// rest of the program is still arriving. Only the final pass judges.
			resolveProgram(statements, errors, { requireRoot: options?.final ?? false });
			const filtered = options?.final ? errors : errors.filter(error => !/is never defined|is never declared/.test(error.message));
			return { statements, errors: filtered, attempts: raw.length };
		},
	};
}
