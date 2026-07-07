/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
import type { IAgentBridge, IAgentEventPayload, IAgentMessage } from '../sessions/services/agent/common/agent.js';
import type { IAppState, IAppStateBridge } from '../sessions/services/appState/common/appState.js';
import type { IModelConfigInput, IModelsBridge } from '../sessions/services/models/common/models.js';
import type { IProjectInput, IProjectsBridge } from '../sessions/services/projects/common/projects.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionsBridge } from '../sessions/services/sessions/common/sessionsBridge.js';

const mockResponseDelayMs = Number.parseInt(process.env['AGENT_CHAT_MOCK_DELAY_MS'] ?? '', 10);

const projects: IProjectsBridge = {
	list: () => ipcRenderer.invoke('projects:list'),
	create: (input: IProjectInput) => ipcRenderer.invoke('projects:create', input),
	pickAndCreate: () => ipcRenderer.invoke('projects:pickAndCreate'),
};

const sessions: ISessionsBridge = {
	list: () => ipcRenderer.invoke('sessions:list'),
	create: (header: ISessionHeader) => ipcRenderer.invoke('sessions:create', header),
	append: (ref: ISessionRef, entry: ISessionEntry) => ipcRenderer.invoke('sessions:append', ref, entry),
	delete: (ref: ISessionRef) => ipcRenderer.invoke('sessions:delete', ref),
};

const appState: IAppStateBridge = {
	get: () => ipcRenderer.invoke('appState:get'),
	set: (state: IAppState) => ipcRenderer.invoke('appState:set', state),
};

const models: IModelsBridge = {
	list: () => ipcRenderer.invoke('models:list'),
	upsert: (input: IModelConfigInput) => ipcRenderer.invoke('models:upsert', input),
	remove: (id: string) => ipcRenderer.invoke('models:remove', id),
	setDefault: (id: string) => ipcRenderer.invoke('models:setDefault', id),
};

const agent: IAgentBridge = {
	run: (sessionId: string, messages: readonly IAgentMessage[], modelId?: string) => ipcRenderer.invoke('agent:run', { sessionId, messages, modelId }),
	stop: (sessionId: string) => ipcRenderer.invoke('agent:stop', sessionId),
	onEvent: (listener: (payload: IAgentEventPayload) => void) => {
		const handler = (_event: unknown, payload: IAgentEventPayload): void => listener(payload);
		ipcRenderer.on('agent:event', handler);
		return () => ipcRenderer.removeListener('agent:event', handler);
	},
};

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	projects,
	sessions,
	appState,
	models,
	agent,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
});
