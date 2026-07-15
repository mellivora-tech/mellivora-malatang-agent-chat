/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dialog, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { ICodeRootView, IDiscoveredRepo, IRemoteRepoInput, IRemoteRepoView } from '../sessions/services/projects/common/projects.js';
import { walkFiles, toWorkspacePath } from './agent/tools/workspace.js';
import type { IProject, IProjectInput } from './projectsStorage.js';
import { addCodeRoot, addRemote, cloneProjectRemote, createProject, deleteProject, ensureCodeRootsSeeded, ensureProject, getProject, listCodeRoots, listProjects, listRemotes, removeCodeRoot, removeRemote } from './projectsStorage.js';
import { listProjectAllowPatterns, removeProjectAllowPattern } from './agent/approvalStore.js';
import { scanRepos } from './repoScan.js';

// Enough for @-mention pickers on real repos; beyond this the fuzzy filter
// works on a truncated set rather than stalling the walk.
const MAX_LISTED_FILES = 5000;

export function registerProjectsIpc(dataRoot: string): void {
	ipcMain.handle('projects:list', () => listProjects(dataRoot));
	ipcMain.handle('projects:create', (_event, input: IProjectInput) => createProject(dataRoot, input));
	ipcMain.handle('projects:delete', (_event, projectId: string) => deleteProject(dataRoot, projectId));
	// Workspace-relative file paths for the composer's @-mention picker. The
	// project root is resolved from storage — never from a renderer-supplied path.
	ipcMain.handle('projects:listFiles', async (_event, projectId: string): Promise<readonly string[]> => {
		const project = await getProject(dataRoot, projectId);
		if (!project) {
			return [];
		}
		const files: string[] = [];
		for await (const absolute of walkFiles(project.path)) {
			files.push(toWorkspacePath([project.path], absolute));
			if (files.length >= MAX_LISTED_FILES) {
				break;
			}
		}
		return files.sort();
	});
	ipcMain.handle('projects:revealInFolder', async (_event, projectId: string): Promise<boolean> => {
		const project = await getProject(dataRoot, projectId);
		if (!project) {
			return false;
		}
		// Opens the project directory in the OS file manager.
		const error = await shell.openPath(project.path);
		return error === '';
	});
	ipcMain.handle('projects:pickAndCreate', async (): Promise<IProject | undefined> => {
		const result = await dialog.showOpenDialog({
			title: 'Add Project',
			properties: ['openDirectory', 'createDirectory'],
		});
		const directory = result.filePaths[0];
		if (result.canceled || !directory) {
			return undefined;
		}

		return ensureProject(dataRoot, { name: basename(directory), path: directory });
	});

	ipcMain.handle('projects:listCodeRoots', async (_event, projectId: string): Promise<readonly ICodeRootView[]> => {
		// First open seeds the workspace's own repos; later calls are pure reads.
		await ensureCodeRootsSeeded(dataRoot, projectId);
		return listCodeRoots(dataRoot, projectId);
	});

	// Scan for repos to offer as code roots. `scanRoot` is a renderer-picked
	// directory; without one, scan the user's home (pruned + capped in scanRepos).
	ipcMain.handle('projects:discoverRepos', async (_event, _projectId: string, scanRoot?: string): Promise<readonly IDiscoveredRepo[]> => {
		return scanRepos(scanRoot && scanRoot.length > 0 ? scanRoot : homedir());
	});

	ipcMain.handle('projects:addCodeRoot', async (_event, projectId: string, path: string): Promise<readonly ICodeRootView[]> => {
		await addCodeRoot(dataRoot, projectId, path);
		return listCodeRoots(dataRoot, projectId);
	});

	ipcMain.handle('projects:removeCodeRoot', async (_event, projectId: string, path: string): Promise<readonly ICodeRootView[]> => {
		await removeCodeRoot(dataRoot, projectId, path);
		return listCodeRoots(dataRoot, projectId);
	});

	ipcMain.handle('projects:listRemotes', (_event, projectId: string): Promise<readonly IRemoteRepoView[]> => listRemotes(dataRoot, projectId));
	// The project's persisted "always allow" patterns (#5) — list for the config
	// UI, remove to revoke. Writes happen on the approval path (agentIpc).
	ipcMain.handle('projects:listApprovalAllowlist', (_event, projectId: string): Promise<readonly string[]> => listProjectAllowPatterns(dataRoot, projectId));
	ipcMain.handle('projects:removeApprovalAllowPattern', (_event, projectId: string, pattern: string): Promise<readonly string[]> => removeProjectAllowPattern(dataRoot, projectId, pattern));

	ipcMain.handle('projects:addRemote', async (_event, projectId: string, input: IRemoteRepoInput): Promise<readonly IRemoteRepoView[]> => {
		await addRemote(dataRoot, projectId, input);
		return listRemotes(dataRoot, projectId);
	});

	ipcMain.handle('projects:removeRemote', async (_event, projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]> => {
		await removeRemote(dataRoot, projectId, remoteId);
		return listRemotes(dataRoot, projectId);
	});

	ipcMain.handle('projects:cloneRemote', (_event, projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]> => cloneProjectRemote(dataRoot, projectId, remoteId, new AbortController().signal));

	ipcMain.handle('projects:pickCodeRoot', async (_event, projectId: string): Promise<readonly ICodeRootView[] | undefined> => {
		const result = await dialog.showOpenDialog({ title: '添加代码路径', properties: ['openDirectory'] });
		const directory = result.filePaths[0];
		if (result.canceled || !directory) {
			return undefined;
		}
		await addCodeRoot(dataRoot, projectId, directory);
		return listCodeRoots(dataRoot, projectId);
	});
}
