/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
import type { IAgentBridge, IAgentEventPayload, IAgentMessage, IApprovalRequestPayload, PermissionMode } from '../sessions/services/agent/common/agent.js';
import type { IAppState, IAppStateBridge } from '../sessions/services/appState/common/appState.js';
import type {
	IModelEntryInput,
	IModelsBridge,
	IProviderInput,
	IProviderVerificationRequest,
	IRemoteModelsRequest,
	ModelEffort,
} from '../sessions/services/models/common/models.js';
import type { IGitBridge } from '../sessions/services/git/common/git.js';
import type { IProjectInput, IProjectsBridge } from '../sessions/services/projects/common/projects.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionsBridge } from '../sessions/services/sessions/common/sessionsBridge.js';

const mockResponseDelayMs = Number.parseInt(process.env['AGENT_CHAT_MOCK_DELAY_MS'] ?? '', 10);

const projects: IProjectsBridge = {
	list: () => ipcRenderer.invoke('projects:list'),
	create: (input: IProjectInput) => ipcRenderer.invoke('projects:create', input),
	pickAndCreate: () => ipcRenderer.invoke('projects:pickAndCreate'),
	revealInFolder: (projectId: string) => ipcRenderer.invoke('projects:revealInFolder', projectId),
	listFiles: (projectId: string) => ipcRenderer.invoke('projects:listFiles', projectId),
};

const sessions: ISessionsBridge = {
	list: () => ipcRenderer.invoke('sessions:list'),
	create: (header: ISessionHeader) => ipcRenderer.invoke('sessions:create', header),
	append: (ref: ISessionRef, entry: ISessionEntry) => ipcRenderer.invoke('sessions:append', ref, entry),
	delete: (ref: ISessionRef) => ipcRenderer.invoke('sessions:delete', ref),
	storeMedia: (ref: ISessionRef, base64: string, mediaType: string) => ipcRenderer.invoke('sessions:storeMedia', ref, base64, mediaType),
	readMedia: (ref: ISessionRef, entryPath: string) => ipcRenderer.invoke('sessions:readMedia', ref, entryPath),
};

const appState: IAppStateBridge = {
	get: () => ipcRenderer.invoke('appState:get'),
	set: (state: IAppState) => ipcRenderer.invoke('appState:set', state),
};

const models: IModelsBridge = {
	list: () => ipcRenderer.invoke('models:list'),
	upsertProvider: (input: IProviderInput) => ipcRenderer.invoke('models:upsertProvider', input),
	removeProvider: (id: string) => ipcRenderer.invoke('models:removeProvider', id),
	upsertModel: (providerId: string, input: IModelEntryInput) => ipcRenderer.invoke('models:upsertModel', providerId, input),
	removeModel: (modelId: string) => ipcRenderer.invoke('models:removeModel', modelId),
	setModelEnabled: (modelId: string, enabled: boolean) => ipcRenderer.invoke('models:setModelEnabled', modelId, enabled),
	setModelEffort: (modelId: string, effort: ModelEffort | undefined) => ipcRenderer.invoke('models:setModelEffort', modelId, effort),
	moveModel: (modelId: string, direction: 'up' | 'down') => ipcRenderer.invoke('models:moveModel', modelId, direction),
	listRemoteModels: (request: IRemoteModelsRequest) => ipcRenderer.invoke('models:listRemoteModels', request),
	verifyProvider: (request: IProviderVerificationRequest) => ipcRenderer.invoke('models:verifyProvider', request),
};

const git: IGitBridge = {
	branches: (projectId: string) => ipcRenderer.invoke('git:branches', projectId),
	checkout: (projectId: string, branch: string) => ipcRenderer.invoke('git:checkout', projectId, branch),
	diffStat: (projectId: string) => ipcRenderer.invoke('git:diffStat', projectId),
};

const agent: IAgentBridge = {
	run: (sessionId: string, messages: readonly IAgentMessage[], modelId?: string, projectId?: string, permissionMode?: PermissionMode) =>
		ipcRenderer.invoke('agent:run', { sessionId, messages, modelId, projectId, permissionMode }),
	stop: (sessionId: string) => ipcRenderer.invoke('agent:stop', sessionId),
	generateTitle: (query: string, modelId?: string) => ipcRenderer.invoke('agent:title', { query, modelId }),
	onEvent: (listener: (payload: IAgentEventPayload) => void) => {
		const handler = (_event: unknown, payload: IAgentEventPayload): void => listener(payload);
		ipcRenderer.on('agent:event', handler);
		return () => ipcRenderer.removeListener('agent:event', handler);
	},
	onApprovalRequest: (listener: (payload: IApprovalRequestPayload) => void) => {
		const handler = (_event: unknown, payload: IApprovalRequestPayload): void => listener(payload);
		ipcRenderer.on('agent:approval-request', handler);
		return () => ipcRenderer.removeListener('agent:approval-request', handler);
	},
	respondApproval: (requestId: string, approved: boolean) => ipcRenderer.invoke('agent:approval-response', { requestId, approved }),
};

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	projects,
	sessions,
	appState,
	models,
	agent,
	git,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
});
