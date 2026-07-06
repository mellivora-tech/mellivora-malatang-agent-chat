/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge } from 'electron';

const mockResponseDelayMs = Number.parseInt(process.env['AGENT_CHAT_MOCK_DELAY_MS'] ?? '', 10);

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
});
