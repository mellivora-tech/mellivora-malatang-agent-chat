/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import type {
	IModelEntryInput,
	IProviderInput,
	IProviderVerificationRequest,
	IQuotaSnapshot,
	IRemoteModelsRequest,
	ModelEffort,
} from '../sessions/services/models/common/models.js';
import { fetchCodingQuota, supportsCodingQuota } from './codingQuota.js';
import { findProviderConnection, listModels, moveModel, removeModel, removeProvider, setModelEffort, setModelEnabled, upsertModel, upsertProvider } from './modelConfigStorage.js';
import { fetchRemoteModels, verifyProviderConnection, type IRemoteModelsConnection } from './remoteModels.js';

export function registerModelConfigIpc(dataRoot: string): void {
	registerHandler('models:list', () => listModels(dataRoot));
	registerHandler('models:upsertProvider', (_event, input: IProviderInput) => upsertProvider(dataRoot, input));
	registerHandler('models:removeProvider', (_event, id: string) => removeProvider(dataRoot, id));
	registerHandler('models:upsertModel', (_event, providerId: string, input: IModelEntryInput) => upsertModel(dataRoot, providerId, input));
	registerHandler('models:removeModel', (_event, modelId: string) => removeModel(dataRoot, modelId));
	registerHandler('models:setModelEnabled', (_event, modelId: string, enabled: boolean) => setModelEnabled(dataRoot, modelId, enabled));
	registerHandler('models:setModelEffort', (_event, modelId: string, effort: ModelEffort | undefined) => setModelEffort(dataRoot, modelId, effort));
	registerHandler('models:moveModel', (_event, modelId: string, direction: 'up' | 'down') => moveModel(dataRoot, modelId, direction));
	registerHandler('models:listRemoteModels', async (_event, request: IRemoteModelsRequest) => {
		return fetchRemoteModels(await resolveConnection(dataRoot, request));
	});
	registerHandler('models:verifyProvider', async (_event, request: IProviderVerificationRequest) => {
		await verifyProviderConnection(await resolveConnection(dataRoot, request), request.probeModel);
	});
	registerHandler('models:codingQuota', () => readCodingQuota(dataRoot));
}

/** First provider whose plan exposes a usage endpoint; undefined on any failure (best-effort contract). */
async function readCodingQuota(dataRoot: string): Promise<IQuotaSnapshot | undefined> {
	const registry = await listModels(dataRoot);
	const provider = registry.providers.find(supportsCodingQuota);
	if (!provider) {
		return undefined;
	}
	const connection = await findProviderConnection(dataRoot, provider.id);
	if (!connection?.apiKey) {
		return undefined;
	}
	const parsed = await fetchCodingQuota(connection.baseURL, connection.apiKey);
	if (!parsed) {
		return undefined;
	}
	return { providerId: provider.id, providerName: provider.name, ...parsed, fetchedAt: new Date().toISOString() };
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
