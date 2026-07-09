/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { IModelEntryInput, IProviderInput, IProviderVerificationRequest, IRemoteModelsRequest, ModelEffort } from '../sessions/services/models/common/models.js';
import { findProviderConnection, listModels, moveModel, removeModel, removeProvider, setModelEffort, setModelEnabled, upsertModel, upsertProvider } from './modelConfigStorage.js';
import { fetchRemoteModels, verifyProviderConnection, type IRemoteModelsConnection } from './remoteModels.js';

export function registerModelConfigIpc(dataRoot: string): void {
	ipcMain.handle('models:list', () => listModels(dataRoot));
	ipcMain.handle('models:upsertProvider', (_event, input: IProviderInput) => upsertProvider(dataRoot, input));
	ipcMain.handle('models:removeProvider', (_event, id: string) => removeProvider(dataRoot, id));
	ipcMain.handle('models:upsertModel', (_event, providerId: string, input: IModelEntryInput) => upsertModel(dataRoot, providerId, input));
	ipcMain.handle('models:removeModel', (_event, modelId: string) => removeModel(dataRoot, modelId));
	ipcMain.handle('models:setModelEnabled', (_event, modelId: string, enabled: boolean) => setModelEnabled(dataRoot, modelId, enabled));
	ipcMain.handle('models:setModelEffort', (_event, modelId: string, effort: ModelEffort | undefined) => setModelEffort(dataRoot, modelId, effort));
	ipcMain.handle('models:moveModel', (_event, modelId: string, direction: 'up' | 'down') => moveModel(dataRoot, modelId, direction));
	ipcMain.handle('models:listRemoteModels', async (_event, request: IRemoteModelsRequest) => {
		return fetchRemoteModels(await resolveConnection(dataRoot, request));
	});
	ipcMain.handle('models:verifyProvider', async (_event, request: IProviderVerificationRequest) => {
		await verifyProviderConnection(await resolveConnection(dataRoot, request), request.probeModel);
	});
}

/**
 * The stored provider fills any omitted field — notably the API key, which
 * never round-trips through the renderer once saved.
 */
async function resolveConnection(dataRoot: string, request: IRemoteModelsRequest): Promise<IRemoteModelsConnection> {
	const stored = request.providerId ? await findProviderConnection(dataRoot, request.providerId) : undefined;
	const type = request.type ?? stored?.type;
	const baseURL = request.baseURL ?? stored?.baseURL;
	if (!type || !baseURL) {
		throw new Error('A provider type and base URL are required.');
	}
	const apiKey = request.apiKey && request.apiKey.length > 0 ? request.apiKey : stored?.apiKey;
	return { type, baseURL, ...(apiKey ? { apiKey } : {}) };
}
