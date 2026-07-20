/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { computeDiffStat, git, type IGitDiffStat } from './gitDiff.js';
import { getProject } from './projectsStorage.js';

// The renderer-side git bridge types import from this module — keep the diff
// shapes reachable here even though they now live in gitDiff.ts (bare-node
// testable, no electron import).
export type { IGitDiffFile, IGitDiffStat } from './gitDiff.js';

/** Branch names we are willing to pass to `git checkout` (defense in depth). */
const SAFE_BRANCH = /^[A-Za-z0-9][\w./-]*$/;

export interface IGitBranchesResult {
	readonly current: string;
	readonly branches: readonly string[];
}

export type IGitCheckoutResult = { readonly ok: true; readonly current: string } | { readonly ok: false; readonly error: string };

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
