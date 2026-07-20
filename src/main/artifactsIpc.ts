/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { IArtifactFilter } from '../sessions/services/artifacts/common/artifacts.js';
import { listArtifacts, rebuildArtifacts } from './artifactsStorage.js';

export function registerArtifactsIpc(dataRoot: string): void {
	ipcMain.handle('artifacts:list', (_event, filter?: IArtifactFilter) => listArtifacts(dataRoot, filter ?? {}));
	ipcMain.handle('artifacts:rebuild', (_event, projectId?: string) => rebuildArtifacts(dataRoot, projectId));
}
