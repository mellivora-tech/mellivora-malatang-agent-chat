/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dialog, ipcMain, shell } from 'electron';
import { basename } from 'node:path';
import type { IProject, IProjectInput } from './projectsStorage.js';
import { createProject, ensureProject, getProject, listProjects } from './projectsStorage.js';

export function registerProjectsIpc(dataRoot: string): void {
	ipcMain.handle('projects:list', () => listProjects(dataRoot));
	ipcMain.handle('projects:create', (_event, input: IProjectInput) => createProject(dataRoot, input));
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
}
