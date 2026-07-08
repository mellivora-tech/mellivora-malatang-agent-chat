/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { getProject } from './projectsStorage.js';

const execFileAsync = promisify(execFile);

/** Branch names we are willing to pass to `git checkout` (defense in depth). */
const SAFE_BRANCH = /^[A-Za-z0-9][\w./-]*$/;
const MAX_UNTRACKED_SCANNED = 500;

export interface IGitBranchesResult {
	readonly current: string;
	readonly branches: readonly string[];
}

export interface IGitDiffStat {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

export type IGitCheckoutResult = { readonly ok: true; readonly current: string } | { readonly ok: false; readonly error: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
	return stdout.trim();
}

/** Real working-tree change stats: tracked edits (diff vs HEAD) plus new untracked files. */
async function computeDiffStat(cwd: string): Promise<IGitDiffStat | undefined> {
	// Confirm it's a git repo first; not being one is not an error, just "no stats".
	try {
		await git(cwd, ['rev-parse', '--is-inside-work-tree']);
	} catch {
		return undefined;
	}

	const changed = new Set<string>();
	let additions = 0;
	let deletions = 0;

	// Tracked changes vs HEAD (empty/absent HEAD → treat as no tracked changes).
	try {
		const numstat = await git(cwd, ['diff', 'HEAD', '--numstat']);
		for (const line of numstat.split('\n').filter(Boolean)) {
			const [add, del, ...rest] = line.split('\t');
			const path = rest.join('\t');
			changed.add(path);
			if (add !== '-') {
				additions += Number(add) || 0;
			}
			if (del !== '-') {
				deletions += Number(del) || 0;
			}
		}
	} catch {
		// No commits yet — everything is untracked, handled below.
	}

	// Untracked new files count as additions of their whole content.
	try {
		const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
		for (const path of untracked.slice(0, MAX_UNTRACKED_SCANNED)) {
			changed.add(path);
			try {
				const content = await readFile(join(cwd, path), 'utf8');
				additions += content === '' ? 0 : content.split('\n').length;
			} catch {
				// Binary or unreadable — still counts as a changed file.
			}
		}
	} catch {
		// ls-files failed; keep whatever the tracked pass gathered.
	}

	return changed.size === 0 ? undefined : { files: changed.size, additions, deletions };
}

/**
 * Real branch data for the conversation context bar. The repository path is
 * resolved from the stored project — never from a renderer-supplied path.
 */
export function registerGitIpc(dataRoot: string): void {
	ipcMain.handle('git:branches', async (_event, projectId: string): Promise<IGitBranchesResult | undefined> => {
		const project = await getProject(dataRoot, projectId);
		if (!project) {
			return undefined;
		}
		try {
			const current = await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
			const list = await git(project.path, ['branch', '--format=%(refname:short)']);
			const branches = list === '' ? [] : list.split('\n').map(name => name.trim());
			return { current, branches };
		} catch {
			// Not a git repository (or git missing) — the pill hides.
			return undefined;
		}
	});

	ipcMain.handle('git:diffStat', async (_event, projectId: string): Promise<IGitDiffStat | undefined> => {
		const project = await getProject(dataRoot, projectId);
		return project ? computeDiffStat(project.path) : undefined;
	});

	ipcMain.handle('git:checkout', async (_event, projectId: string, branch: string): Promise<IGitCheckoutResult> => {
		const project = await getProject(dataRoot, projectId);
		if (!project) {
			return { ok: false, error: 'Unknown project.' };
		}
		if (!SAFE_BRANCH.test(branch)) {
			return { ok: false, error: `Invalid branch name: ${branch}` };
		}
		try {
			await git(project.path, ['checkout', branch]);
			const current = await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
			return { ok: true, current };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Surface git's own reason (e.g. local changes would be overwritten).
			const stderr = (error as { stderr?: string }).stderr?.trim();
			return { ok: false, error: stderr !== undefined && stderr !== '' ? stderr : message };
		}
	});
}
