/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IInputValidation } from '../agentTypes.js';

/** Directories the workspace walkers skip by default (noise / VCS / build output). */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.cache', 'coverage', '.turbo']);

/** True when `absolute` is `root` itself or lives inside it (no `..`/absolute escape). */
function isInside(root: string, absolute: string): boolean {
	const rel = relative(root, absolute);
	return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The first code root that contains `absolute`, or undefined if none does. */
function containingRoot(roots: readonly string[], absolute: string): string | undefined {
	return roots.find(root => isInside(root, absolute));
}

/**
 * Resolve a model-supplied path against the code roots, refusing to escape them.
 * Relative paths resolve against the PRIMARY root (`roots[0]`); a path is allowed
 * when it falls inside ANY root. Anything outside every root throws — the
 * fail-closed boundary between the model and the filesystem.
 */
export function resolveInWorkspace(roots: readonly string[], input: string): string {
	const absolute = isAbsolute(input) ? resolve(input) : resolve(roots[0] ?? process.cwd(), input);
	if (!containingRoot(roots, absolute)) {
		throw new Error(`Path escapes the workspace: ${input}`);
	}
	return absolute;
}

/**
 * The path shown back to the model. With a single root it is root-relative
 * (compact). With multiple roots it is ABSOLUTE — unambiguous across repos and
 * always resolvable via {@link resolveInWorkspace}.
 */
export function toWorkspacePath(roots: readonly string[], absolute: string): string {
	if (roots.length > 1) {
		return absolute;
	}
	const rel = relative(roots[0] ?? '', absolute);
	return rel === '' ? '.' : rel.split(sep).join('/');
}

/** The path RELATIVE to its containing root — what glob/grep patterns match against, so `src/**` works per repo. */
export function workspaceMatchPath(roots: readonly string[], absolute: string): string {
	const root = containingRoot(roots, absolute) ?? roots[0] ?? '';
	const rel = relative(root, absolute);
	return rel === '' ? '.' : rel.split(sep).join('/');
}

/** Depth-first walk of the workspace, yielding absolute file paths, skipping ignored dirs. */
export async function* walkFiles(root: string, options?: { readonly signal?: AbortSignal; readonly ignoredDirs?: ReadonlySet<string> }): AsyncGenerator<string> {
	const ignored = options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
	const stack: string[] = [root];
	while (stack.length > 0) {
		options?.signal?.throwIfAborted();
		const dir = stack.pop();
		if (dir === undefined) {
			break;
		}
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!ignored.has(entry.name)) {
					stack.push(abs);
				}
			} else if (entry.isFile()) {
				yield abs;
			}
		}
	}
}

/**
 * Convert a glob pattern to an anchored RegExp. Supports `**` (crosses `/`),
 * `*` and `?` (within a segment), `{a,b}` alternation, and character classes.
 */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				re += '.*';
				i++;
				if (glob[i + 1] === '/') {
					i++;
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '{') {
			braceDepth++;
			re += '(?:';
		} else if (c === '}') {
			braceDepth = Math.max(0, braceDepth - 1);
			re += ')';
		} else if (c === ',' && braceDepth > 0) {
			re += '|';
		} else if ('.+^$()|[]\\/'.includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------
// Small input-validation helpers shared by the tools. The harness turns a
// failed validation into an InputValidationError tool_result for the model.
// ---------------------------------------------------------------------------

export function asRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

export function invalid(error: string): IInputValidation {
	return { ok: false, error };
}

export function valid(value: unknown): IInputValidation {
	return { ok: true, value };
}

export function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`"${key}" must be a non-empty string`);
	}
	return value;
}

export function optionalPositiveInt(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`"${key}" must be a non-negative integer`);
	}
	return value;
}
