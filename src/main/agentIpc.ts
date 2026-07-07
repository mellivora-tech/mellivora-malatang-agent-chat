/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { runAgentLoop } from './agent/agentLoop.js';
import { allowAllPermissionGate } from './agent/agentTools.js';
import type { IAgentMessage, IAgentTerminal } from './agent/agentTypes.js';
import { createModelClient } from './agent/createModelClient.js';
import { resolveModelConfig } from './modelConfigStorage.js';

const DEFAULT_SYSTEM = 'You are a helpful coding agent.';

interface IAgentRunPayload {
	readonly sessionId: string;
	readonly messages: readonly IAgentMessage[];
	readonly modelId?: string;
}

/**
 * Drives the agent loop in the main process and streams its events to the
 * renderer over `agent:event`. Tools are not wired yet, so this handles
 * streaming text turns; the loop, clients, and gate are ready for tools.
 */
export function registerAgentIpc(dataRoot: string): void {
	const abortControllers = new Map<string, AbortController>();

	ipcMain.handle('agent:run', async (event, payload: IAgentRunPayload): Promise<IAgentTerminal> => {
		const config = await resolveModelConfig(dataRoot, payload.modelId ?? '');
		if (!config) {
			throw new Error('No model is configured. Add one in Settings → Models.');
		}

		const controller = new AbortController();
		abortControllers.set(payload.sessionId, controller);
		const sender = event.sender;

		try {
			const loop = runAgentLoop(payload.messages, {
				system: DEFAULT_SYSTEM,
				tools: [],
				modelClient: createModelClient(config),
				permissionGate: allowAllPermissionGate,
				signal: controller.signal,
			});

			let step = await loop.next();
			while (!step.done) {
				if (!sender.isDestroyed()) {
					sender.send('agent:event', { sessionId: payload.sessionId, event: step.value });
				}
				step = await loop.next();
			}

			// The terminal rides the same channel so it can never overtake a
			// trailing event the way the handler's return value can.
			if (!sender.isDestroyed()) {
				sender.send('agent:event', { sessionId: payload.sessionId, done: step.value });
			}

			return step.value;
		} finally {
			abortControllers.delete(payload.sessionId);
		}
	});

	ipcMain.handle('agent:stop', (_event, sessionId: string) => {
		abortControllers.get(sessionId)?.abort();
	});
}
