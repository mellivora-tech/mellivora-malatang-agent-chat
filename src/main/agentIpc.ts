/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { runAgentLoop } from './agent/agentLoop.js';
import { allowAllPermissionGate } from './agent/agentTools.js';
import type { IAgentMessage, IAgentTerminal, IAgentTool } from './agent/agentTypes.js';
import { createWorkspaceTools } from './agent/tools/index.js';
import { createModelClient } from './agent/createModelClient.js';
import { getProject } from './projectsStorage.js';
import { resolveModelConfig } from './modelConfigStorage.js';

const DEFAULT_SYSTEM = 'You are a helpful coding agent.';

/** System prompt for a run bound to a workspace, listing the available tools. */
function workspaceSystemPrompt(cwd: string): string {
	return [
		"You are a helpful coding agent working inside the user's project.",
		`Working directory: ${cwd}`,
		'You have read-only tools to explore the codebase: read_file, list_dir, glob, grep.',
		'Prefer these tools to inspect files before answering. All paths are relative to the working directory; you cannot access files outside it.',
	].join('\n');
}

interface IAgentRunPayload {
	readonly sessionId: string;
	readonly messages: readonly IAgentMessage[];
	readonly modelId?: string;
	readonly projectId?: string;
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

		// Bind file tools to the session's project directory. The workspace root is
		// resolved here from the stored project — never from a renderer-supplied path.
		const project = payload.projectId ? await getProject(dataRoot, payload.projectId) : undefined;
		const cwd = project?.path;
		const tools: readonly IAgentTool[] = cwd ? createWorkspaceTools(cwd) : [];

		const controller = new AbortController();
		abortControllers.set(payload.sessionId, controller);
		const sender = event.sender;

		try {
			const loop = runAgentLoop(payload.messages, {
				system: cwd ? workspaceSystemPrompt(cwd) : DEFAULT_SYSTEM,
				tools,
				// Read-only tools only today; swap in the approval gate with the mutating tools.
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
