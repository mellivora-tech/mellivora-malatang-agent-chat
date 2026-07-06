/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
import type { IProjectInput, IProjectsBridge } from '../sessions/services/projects/common/projects.js';

const mockResponseDelayMs = Number.parseInt(process.env['AGENT_CHAT_MOCK_DELAY_MS'] ?? '', 10);

const projects: IProjectsBridge = {
	list: () => ipcRenderer.invoke('projects:list'),
	create: (input: IProjectInput) => ipcRenderer.invoke('projects:create', input),
	pickAndCreate: () => ipcRenderer.invoke('projects:pickAndCreate'),
};

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	projects,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
});
