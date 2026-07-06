/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
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
};

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	projects,
	sessions,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
});
