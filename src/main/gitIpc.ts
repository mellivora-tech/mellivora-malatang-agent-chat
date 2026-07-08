/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { getProject } from './projectsStorage.js';

const execFileAsync = promisify(execFile);

/** Branch names we are willing to pass to `git checkout` (defense in depth). */
const SAFE_BRANCH = /^[A-Za-z0-9][\w./-]*$/;

export interface IGitBranchesResult {
	readonly current: string;
	readonly branches: readonly string[];
}

export type IGitCheckoutResult = { readonly ok: true; readonly current: string } | { readonly ok: false; readonly error: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000 });
	return stdout.trim();
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
