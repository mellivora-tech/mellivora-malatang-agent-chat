/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type Vcs = 'git' | 'svn';

export interface IDiscoveredRepo {
	readonly path: string;
	readonly name: string;
	readonly vcs: Vcs;
}

/**
 * Directories never worth descending into when hunting for repos: dependency
 * caches, build output, and OS/tooling stores that hold thousands of files (and
 * sometimes their own vendored `.git`, which is noise, not a project repo).
 */
const SKIP_DIRS = new Set([
	'node_modules',
	'.cache',
	'.npm',
	'.pnpm-store',
	'.yarn',
	'.gradle',
	'.m2',
	'.venv',
	'venv',
	'__pycache__',
	'vendor',
	'dist',
	'build',
	'out',
	'target',
	'Library',
	'Applications',
	'.Trash',
	'DerivedData',
	'Pods',
]);

export interface IScanOptions {
	/** How deep below the root to descend. Default 6 — deep enough for real trees, shallow enough to stay fast. */
	readonly maxDepth?: number;
	/** Stop after this many repos (a runaway-scan backstop). Default 500. */
	readonly maxResults?: number;
	readonly signal?: AbortSignal;
}

/**
 * Walk `root` for git/svn repositories. A repo is a directory containing `.git`
 * (a directory for normal clones, a FILE for submodules/worktrees) or `.svn`.
 * Descent stops at a found repo (repos do not meaningfully nest), skips hidden
 * and heavy directories, and never follows symlinks (avoids cycles). Unreadable
 * directories (permission denied) are skipped, not fatal.
 */
export async function scanRepos(root: string, options: IScanOptions = {}): Promise<IDiscoveredRepo[]> {
	const maxDepth = options.maxDepth ?? 6;
	const maxResults = options.maxResults ?? 500;
	const signal = options.signal;
	const results: IDiscoveredRepo[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (results.length >= maxResults || depth > maxDepth || signal?.aborted) {
			return;
		}
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		// A `.git` / `.svn` entry (dir OR file) marks this dir as a repo root.
		const marker = entries.find(entry => entry.name === '.git' || entry.name === '.svn');
		if (marker) {
			results.push({ path: dir, name: basename(dir), vcs: marker.name === '.svn' ? 'svn' : 'git' });
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
				continue;
			}
			await walk(join(dir, entry.name), depth + 1);
			if (results.length >= maxResults || signal?.aborted) {
				return;
			}
		}
	}

	await walk(root, 0);
	return results;
}
