/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Working-tree diff stats (#13 P2). Lives outside gitIpc.ts on purpose: no
 * electron import, so the bare-node unit tests can exercise the numstat parser
 * and computeDiffStat against a real temp repository.
 */

const execFileAsync = promisify(execFile);

const MAX_UNTRACKED_SCANNED = 500;

export interface IGitDiffFile {
	/** Repo-relative path exactly as git printed it (renames keep the `{a => b}` arrow). */
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	/** 'untracked': new file counted as whole-content additions; 'binary': numstat had no line counts. */
	readonly status?: 'untracked' | 'binary';
}

export interface IGitDiffStat {
	/** Per-file breakdown; its length IS the old `files` count (same unique-path set, #13 P2). */
	readonly files: readonly IGitDiffFile[];
	readonly additions: number;
	readonly deletions: number;
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
	return stdout.trim();
}

export interface IGitNumstatParse {
	readonly files: readonly IGitDiffFile[];
	readonly additions: number;
	readonly deletions: number;
}

/**
 * Parse `git diff --numstat` output. The totals accumulate per LINE (the
 * pre-P2 badge口径 — a path listed twice counts its lines twice) while the
 * file list dedups by path, matching the old `changed` set's size exactly.
 */
export function parseNumstat(output: string): IGitNumstatParse {
	const byPath = new Map<string, { added: number; removed: number; binary: boolean }>();
	let additions = 0;
	let deletions = 0;
	for (const line of output.split('\n').filter(Boolean)) {
		const [add, del, ...rest] = line.split('\t');
		const path = rest.join('\t');
		const record = byPath.get(path) ?? { added: 0, removed: 0, binary: false };
		if (add !== '-') {
			const count = Number(add) || 0;
			additions += count;
			record.added += count;
		} else {
			record.binary = true;
		}
		if (del !== '-') {
			const count = Number(del) || 0;
			deletions += count;
			record.removed += count;
		} else {
			record.binary = true;
		}
		byPath.set(path, record);
	}
	return {
		files: [...byPath].map(([path, record]) => ({ path, added: record.added, removed: record.removed, ...(record.binary ? { status: 'binary' as const } : {}) })),
		additions,
		deletions,
	};
}

/** Real working-tree change stats: tracked edits (diff vs HEAD) plus new untracked files. */
export async function computeDiffStat(cwd: string): Promise<IGitDiffStat | undefined> {
	// Confirm it's a git repo first; not being one is not an error, just "no stats".
	try {
		await git(cwd, ['rev-parse', '--is-inside-work-tree']);
	} catch {
		return undefined;
	}

	const byPath = new Map<string, IGitDiffFile>();
	let additions = 0;
	let deletions = 0;

	// Tracked changes vs HEAD (empty/absent HEAD → treat as no tracked changes).
	try {
		const parsed = parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat']));
		additions += parsed.additions;
		deletions += parsed.deletions;
		for (const file of parsed.files) {
			byPath.set(file.path, file);
		}
	} catch {
		// No commits yet — everything is untracked, handled below.
	}

	// Untracked new files count as additions of their whole content.
	try {
		const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
		for (const path of untracked.slice(0, MAX_UNTRACKED_SCANNED)) {
			let added = 0;
			try {
				const content = await readFile(join(cwd, path), 'utf8');
				added = content === '' ? 0 : content.split('\n').length;
				additions += added;
			} catch {
				// Binary or unreadable — still counts as a changed file (added stays 0).
			}
			// git never lists an untracked path in `diff HEAD`, but merging keeps
			// the file count equal to the unique-path set even if it ever did.
			const existing = byPath.get(path);
			byPath.set(path, existing ? { ...existing, added: existing.added + added } : { path, added, removed: 0, status: 'untracked' });
		}
	} catch {
		// ls-files failed; keep whatever the tracked pass gathered.
	}

	return byPath.size === 0 ? undefined : { files: [...byPath.values()], additions, deletions };
}
