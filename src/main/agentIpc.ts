/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { runAgentLoop } from './agent/agentLoop.js';
import type { IAgentMessage, IAgentTerminal, IAgentTool } from './agent/agentTypes.js';
import { agentLog } from './agent/observability/agentLog.js';
import { createJsonlFileSink, resolveAgentLogsDir } from './agent/observability/jsonlFileSink.js';
import { createRunLogger } from './agent/observability/runLogger.js';
import { asPermissionMode, createGateForMode, describeToolCall, type PermissionMode } from './agent/permission.js';
import { formatInstructionsBlock, isProjectInstructionsEnabled, loadProjectInstructions } from './agent/projectInstructions.js';
import { createWorkspaceTools } from './agent/tools/index.js';
import { createModelClient } from './agent/createModelClient.js';
import { generateSessionTitle } from './agent/sessionTitle.js';
import { getProject } from './projectsStorage.js';
import { resolveModelConfig } from './modelConfigStorage.js';

const DEFAULT_SYSTEM = 'You are a helpful coding agent.';

/** System prompt for a run bound to a workspace, reflecting the permission mode. */
function workspaceSystemPrompt(cwd: string, mode: PermissionMode): string {
	const lines = ["You are a helpful coding agent working inside the user's project.", `Working directory: ${cwd}`];
	if (mode === 'plan') {
		lines.push(
			'You are in plan mode: explore with the read-only tools (read_file, list_dir, glob, grep) and present a plan.',
			'Do not attempt to change files or run commands — propose what you would do instead.',
		);
	} else {
		lines.push(
			'Tools: read_file, list_dir, glob, grep to explore; write_file, edit_file to change files; bash to run commands.',
			'Prefer reading before writing. Some actions may pause for the user to approve.',
			// Steer bash away from commands that block a turn or fabricate "evidence".
			'For tasks that only need understanding the code — assessing, summarizing, reviewing, explaining — read the relevant files; do NOT run the build or test suite just to "check".',
			'Use bash only for short, purposeful commands. Avoid long-running or blocking ones — dev servers, watch modes, full end-to-end / integration suites, or anything that launches the app or waits indefinitely — as they stall the turn. If a long command is genuinely required, scope it narrowly and set a timeout.',
			'Batch independent work into a single step: when you need several files or several searches, issue those tool calls together in one turn rather than one at a time — it is far faster and avoids running out of steps.',
			'For any multi-step task, call update_plan first to lay out a short finite checklist, keep it updated as you go, and once every step is done STOP and give your final answer — do not keep pulling threads. If a question cannot be answered from the code alone (e.g. it depends on runtime data), say so and stop rather than reading more.',
		);
	}
	lines.push('All paths are relative to the working directory; you cannot access files outside it.');
	return lines.join('\n');
}

interface IAgentRunPayload {
	readonly sessionId: string;
	readonly messages: readonly IAgentMessage[];
	readonly modelId?: string;
	readonly projectId?: string;
	readonly permissionMode?: string;
}

interface IApprovalResponsePayload {
	readonly requestId: string;
	readonly approved: boolean;
}

interface IAgentTitlePayload {
	readonly query: string;
	readonly modelId?: string;
}

// A title is a handful of tokens; the budget only needs to absorb a chatty model.
const TITLE_MAX_TOKENS = 256;
const TITLE_TIMEOUT_MS = 20_000;

/**
 * Drives the agent loop in the main process and streams its events to the
 * renderer over `agent:event`. Mutating tools consult the permission gate for
 * the session's mode; 'ask'/'auto-edit' route through an approval round-trip
 * with the renderer (`agent:approval-request` / `agent:approval-response`).
 */
export function registerAgentIpc(dataRoot: string): void {
	const abortControllers = new Map<string, AbortController>();
	const pendingApprovals = new Map<string, { readonly sessionId: string; resolve(approved: boolean): void }>();

	// Agent observability (P1): attach the local JSONL sink when enabled.
	const logsDir = resolveAgentLogsDir(dataRoot, process.env);
	if (logsDir) {
		agentLog.attach(createJsonlFileSink(logsDir));
		console.error(`[agent] observability log: ${logsDir}/latest.jsonl`);
	}

	const settleApprovals = (sessionId: string): void => {
		for (const [requestId, pending] of [...pendingApprovals]) {
			if (pending.sessionId === sessionId) {
				pendingApprovals.delete(requestId);
				pending.resolve(false);
			}
		}
	};

	ipcMain.handle('agent:run', async (event, payload: IAgentRunPayload): Promise<IAgentTerminal> => {
		const config = await resolveModelConfig(dataRoot, payload.modelId ?? '');
		if (!config) {
			throw new Error('No model is configured. Add one in Settings → Models.');
		}

		const mode = asPermissionMode(payload.permissionMode);

		// Bind file tools to the session's project directory. The workspace root is
		// resolved here from the stored project — never from a renderer-supplied path.
		const project = payload.projectId ? await getProject(dataRoot, payload.projectId) : undefined;
		const cwd = project?.path;
		const tools: readonly IAgentTool[] = cwd ? createWorkspaceTools(cwd, { includeMutations: mode !== 'plan' }) : [];

		// Project instructions (AGENTS.md/CLAUDE.md at the root) ride the system
		// prompt deterministically instead of hoping the model reads them.
		const instructions = cwd && isProjectInstructionsEnabled(process.env) ? await loadProjectInstructions(cwd) : undefined;

		const controller = new AbortController();
		abortControllers.set(payload.sessionId, controller);
		const sender = event.sender;

		// A mutation the gate cannot auto-decide becomes a question to the renderer;
		// the reply (or an abort / run end) resolves it. Denied by default.
		const requestApproval = (tool: IAgentTool, input: unknown, context: { toolUseId: string }): Promise<boolean> =>
			new Promise<boolean>(resolve => {
				if (controller.signal.aborted || sender.isDestroyed()) {
					resolve(false);
					return;
				}
				pendingApprovals.set(context.toolUseId, { sessionId: payload.sessionId, resolve });
				controller.signal.addEventListener(
					'abort',
					() => {
						if (pendingApprovals.delete(context.toolUseId)) {
							resolve(false);
						}
					},
					{ once: true },
				);
				sender.send('agent:approval-request', {
					sessionId: payload.sessionId,
					requestId: context.toolUseId,
					toolName: tool.name,
					detail: describeToolCall(tool.name, input),
				});
			});

		const runLogger = createRunLogger({
			runId: `${payload.sessionId}-${Date.now()}`,
			sessionId: payload.sessionId,
			model: config.model,
			mode,
			hasWorkspace: cwd !== undefined,
			toolCount: tools.length,
			...(cwd ? { cwd } : {}),
			...(payload.projectId ? { projectId: payload.projectId } : {}),
			...(instructions ? { instructions: { file: instructions.file, chars: instructions.text.length, truncated: instructions.truncated } } : {}),
			...(config.contextLength !== undefined ? { contextWindow: config.contextLength } : {}),
		});

		try {
			const system = cwd ? workspaceSystemPrompt(cwd, mode) + (instructions ? `\n\n${formatInstructionsBlock(instructions)}` : '') : DEFAULT_SYSTEM;
			const loop = runAgentLoop(payload.messages, {
				system,
				tools,
				modelClient: createModelClient(config),
				permissionGate: createGateForMode(mode, requestApproval),
				signal: controller.signal,
				// No configured context window → compaction stays off (never guessed).
				...(config.contextLength
					? { compaction: { contextWindow: config.contextLength, ...(config.params?.maxTokens !== undefined ? { outputBudget: config.params.maxTokens } : {}) } }
					: {}),
			});

			let step = await loop.next();
			while (!step.done) {
				runLogger.record(step.value);
				if (!sender.isDestroyed()) {
					sender.send('agent:event', { sessionId: payload.sessionId, event: step.value });
				}
				step = await loop.next();
			}

			runLogger.end(step.value);

			// The terminal rides the same channel so it can never overtake a
			// trailing event the way the handler's return value can.
			if (!sender.isDestroyed()) {
				sender.send('agent:event', { sessionId: payload.sessionId, done: step.value });
			}

			return step.value;
		} catch (error) {
			runLogger.error('run', error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			abortControllers.delete(payload.sessionId);
			settleApprovals(payload.sessionId);
			agentLog.flush();
		}
	});

	// One-shot title generation — a plain model call, not an agent run: no tools,
	// thinking off, tiny budget. Failures reject; the renderer keeps its placeholder.
	ipcMain.handle('agent:title', async (_event, payload: IAgentTitlePayload): Promise<string | undefined> => {
		const config = await resolveModelConfig(dataRoot, payload.modelId ?? '');
		if (!config) {
			return undefined;
		}

		const client = createModelClient({ ...config, params: { maxTokens: TITLE_MAX_TOKENS } });
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
		try {
			return await generateSessionTitle(client, payload.query, controller.signal);
		} finally {
			clearTimeout(timeout);
		}
	});

	ipcMain.handle('agent:approval-response', (_event, payload: IApprovalResponsePayload) => {
		const pending = pendingApprovals.get(payload.requestId);
		if (pending) {
			pendingApprovals.delete(payload.requestId);
			pending.resolve(payload.approved === true);
		}
	});

	ipcMain.handle('agent:stop', (_event, sessionId: string) => {
		abortControllers.get(sessionId)?.abort();
	});
}
