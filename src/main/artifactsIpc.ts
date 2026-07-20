/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain, shell } from 'electron';
import { stat } from 'node:fs/promises';
import type { IArtifactFilter } from '../sessions/services/artifacts/common/artifacts.js';
import { listArtifacts, rebuildArtifacts } from './artifactsStorage.js';

export function registerArtifactsIpc(dataRoot: string): void {
	ipcMain.handle('artifacts:list', (_event, filter?: IArtifactFilter) => listArtifacts(dataRoot, filter ?? {}));
	ipcMain.handle('artifacts:rebuild', (_event, projectId?: string) => rebuildArtifacts(dataRoot, projectId));
	ipcMain.handle('artifacts:reveal', async (_event, path: string) => {
		// showItemInFolder silently no-ops on a missing path — probe first so the
		// renderer can mark the row stale instead of the click just doing nothing.
		try {
			await stat(path);
		} catch {
			return false;
		}
		shell.showItemInFolder(path);
		return true;
	});
}
