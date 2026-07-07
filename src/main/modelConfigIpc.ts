/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { IModelEntryInput, IProviderInput } from '../sessions/services/models/common/models.js';
import { listModels, removeModel, removeProvider, setDefaultModel, upsertModel, upsertProvider } from './modelConfigStorage.js';

export function registerModelConfigIpc(dataRoot: string): void {
	ipcMain.handle('models:list', () => listModels(dataRoot));
	ipcMain.handle('models:upsertProvider', (_event, input: IProviderInput) => upsertProvider(dataRoot, input));
	ipcMain.handle('models:removeProvider', (_event, id: string) => removeProvider(dataRoot, id));
	ipcMain.handle('models:upsertModel', (_event, providerId: string, input: IModelEntryInput) => upsertModel(dataRoot, providerId, input));
	ipcMain.handle('models:removeModel', (_event, modelId: string) => removeModel(dataRoot, modelId));
	ipcMain.handle('models:setDefault', (_event, modelId: string) => setDefaultModel(dataRoot, modelId));
}
