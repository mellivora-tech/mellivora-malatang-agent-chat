/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { IModelConfigInput } from '../sessions/services/models/common/models.js';
import { listModels, removeModel, setDefaultModel, upsertModel } from './modelConfigStorage.js';

export function registerModelConfigIpc(dataRoot: string): void {
	ipcMain.handle('models:list', () => listModels(dataRoot));
	ipcMain.handle('models:upsert', (_event, input: IModelConfigInput) => upsertModel(dataRoot, input));
	ipcMain.handle('models:remove', (_event, id: string) => removeModel(dataRoot, id));
	ipcMain.handle('models:setDefault', (_event, id: string) => setDefaultModel(dataRoot, id));
}
