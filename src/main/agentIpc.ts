/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { runAgentLoop } from './agent/agentLoop.js';
import type { IAgentMessage, IAgentTerminal, IAgentTool, ICompactionAnchor } from './agent/agentTypes.js';
import { restoreAnchor } from './agent/compaction.js';
import { agentLog } from './agent/observability/agentLog.js';
import { createJsonlFileSink, resolveAgentLogsDir } from './agent/observability/jsonlFileSink.js';
import { createRunLogger } from './agent/observability/runLogger.js';
import { asPermissionMode, createGateForMode, describeToolCall, type PermissionMode } from './agent/permission.js';
import { formatInstructionsBlock, isProjectInstructionsEnabled, loadProjectInstructions } from './agent/projectInstructions.js';
import { createWorkspaceTools } from './agent/tools/index.js';
import { createDataSourceTools, type IQueryableSource } from './agent/tools/dataSourceTools.js';
import { createSshTools, type ISshServer } from './agent/tools/sshTool.js';
import { createModelClient } from './agent/createModelClient.js';
import { generateSessionTitle } from './agent/sessionTitle.js';
import { getCredential } from './credentialStorage.js';
import { createSafeStorageCipher } from './secretCipher.js';
import { readWorkspaceConfig } from './workspaceConfigStorage.js';
import { ensureRemotesCloned, getProject, projectCodeRoots } from './projectsStorage.js';
import { resolveModelConfig } from './modelConfigStorage.js';
import { formatSkillBlock, getSkill } from './skillsStorage.js';

const DEFAULT_SYSTEM = 'You are a helpful coding agent.';

/** System prompt for a run bound to a workspace, reflecting the permission mode. */
function workspaceSystemPrompt(roots: readonly string[], mode: PermissionMode): string {
	const lines = ["You are a helpful coding agent working inside the user's project.", `Working directory: ${roots[0]}`];
	if (roots.length > 1) {
		lines.push(`Additional code roots (address files in these with ABSOLUTE paths): ${roots.slice(1).join(', ')}.`);
	}
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
	lines.push(
		roots.length > 1
			? 'Relative paths resolve against the working directory; use absolute paths for the other code roots. You cannot access files outside these roots.'
			: 'All paths are relative to the working directory; you cannot access files outside it.',
	);
	return lines.join('\n');
}

interface IAgentRunPayload {
	readonly sessionId: string;
	readonly messages: readonly IAgentMessage[];
	readonly modelId?: string;
	readonly projectId?: string;
	readonly permissionMode?: string;
	/** $-attached skills; bodies are resolved here (main side) and ride the system prompt. */
	readonly skillIds?: readonly string[];
	/** The session's persisted compaction anchor; untrusted — shape-checked and validated against the transcript before use. */
	readonly anchor?: unknown;
}

/** Renderer input is untrusted: anything but the exact anchor shape is discarded. */
function asAnchorShape(value: unknown): ICompactionAnchor | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const { summary, covered, prefixChars } = candidate;
	if (typeof summary !== 'string' || typeof covered !== 'number' || typeof prefixChars !== 'number') {
		return undefined;
	}
	return { summary, covered, prefixChars };
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

/** A model flagged vision: false must not receive image blocks — swap each for a note so the turn still parses. */
function stripImageBlocks(messages: readonly IAgentMessage[]): readonly IAgentMessage[] {
	return messages.map(message => ({
		...message,
		content: message.content.map(block => (block.type === 'image' ? { type: 'text' as const, text: '[Image omitted: the selected model does not support image input.]' } : block)),
	}));
}

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

		const controller = new AbortController();
		abortControllers.set(payload.sessionId, controller);
		const sender = event.sender;

		// Bind file tools to the session's project directory. The workspace root is
		// resolved here from the stored project — never from a renderer-supplied path.
		const project = payload.projectId ? await getProject(dataRoot, payload.projectId) : undefined;
		// The agent operates over ALL the project's code roots: explicit local
		// codeRoots (else the workspace/path) PLUS any remote repos, cloned now if
		// not already on disk (best-effort — a clone failure just drops that root).
		const localRoots = project ? projectCodeRoots(project) : [];
		const remoteRoots = project ? await ensureRemotesCloned(dataRoot, project.id, controller.signal) : [];
		// Dedupe: a path must never reach the file tools twice (e.g. if a clone dir
		// somehow also got tracked as a local root).
		const roots = [...new Set([...localRoots, ...remoteRoots])];
		// The primary root is the bash cwd + where relative paths and project
		// instructions resolve.
		const cwd = roots[0];
		const fileTools = roots.length > 0 ? createWorkspaceTools(roots, { includeMutations: mode !== 'plan' }) : [];

		// Read-only data-source tools: the project's configured databases become
		// queryable (SELECT only). Coordinates come from the workspace config;
		// credentials from the (encrypted) app store, resolved per query.
		const cipher = createSafeStorageCipher();
		const workspacePath = project?.workspacePath ?? project?.path;
		const wsConfig = workspacePath ? await readWorkspaceConfig(workspacePath) : undefined;
		const envName = new Map((wsConfig?.environments ?? []).map(environment => [environment.id, environment.name]));
		const querySources: IQueryableSource[] = (wsConfig?.dataSources ?? [])
			.filter(dataSource => dataSource.kind === 'database')
			.map(dataSource => ({
				id: dataSource.id,
				label: dataSource.label,
				environmentName: envName.get(dataSource.environmentId) ?? '',
				coordinates: dataSource.coordinates as IQueryableSource['coordinates'],
			}));
		const dataSourceTools = querySources.length > 0 ? createDataSourceTools({ sources: querySources, getSecret: id => getCredential(dataRoot, id, cipher) }) : [];

		// SSH servers → run_on_server (mutation-class: gated, and omitted in plan mode like bash).
		const sshServers: ISshServer[] = (wsConfig?.dataSources ?? [])
			.filter(dataSource => dataSource.kind === 'server')
			.map(dataSource => ({
				id: dataSource.id,
				label: dataSource.label,
				environmentName: envName.get(dataSource.environmentId) ?? '',
				coordinates: dataSource.coordinates as ISshServer['coordinates'],
			}));
		const sshTools = sshServers.length > 0 && mode !== 'plan' ? createSshTools({ servers: sshServers, getSecret: id => getCredential(dataRoot, id, cipher) }) : [];

		const tools: readonly IAgentTool[] = [...fileTools, ...dataSourceTools, ...sshTools];

		// Project instructions (AGENTS.md/CLAUDE.md at the root) ride the system
		// prompt deterministically instead of hoping the model reads them.
		const instructions = cwd && isProjectInstructionsEnabled(process.env) ? await loadProjectInstructions(cwd) : undefined;

		// $-attached skills: ids resolve to bodies here — a deleted skill silently
		// drops out rather than failing the run.
		const skillBlocks: string[] = [];
		for (const skillId of payload.skillIds ?? []) {
			const skill = await getSkill(dataRoot, skillId);
			if (skill) {
				skillBlocks.push(formatSkillBlock(skill));
			}
		}

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
			const dbNote =
				querySources.length > 0
					? `\nThis project has ${querySources.length} configured database data source(s). Use list_data_sources to see them and query_data_source (read-only SELECT) to inspect data.`
					: '';
			const sshNote =
				sshTools.length > 0
					? `\nThis project has ${sshServers.length} configured server(s). Use list_servers and run_on_server to execute commands over SSH (may require approval).`
					: '';
			const workspacePrompt = (roots.length > 0 ? workspaceSystemPrompt(roots, mode) : DEFAULT_SYSTEM) + dbNote + sshNote;
			const instructionsBlock = instructions ? formatInstructionsBlock(instructions) : undefined;
			const baseSystem = instructionsBlock ? `${workspacePrompt}\n\n${instructionsBlock}` : workspacePrompt;
			const skillsBlock = skillBlocks.length > 0 ? skillBlocks.join('\n\n') : undefined;
			const system = skillsBlock ? `${baseSystem}\n\n${skillsBlock}` : baseSystem;
			// The breakdown panel's system-side rows: each segment's own length, not
			// the concatenation — the loop attributes it per-category, never guesses.
			const systemBreakdown = { baseChars: workspacePrompt.length, instructionsChars: instructionsBlock?.length ?? 0, skillsChars: skillsBlock?.length ?? 0 };
			const messages = config.params?.vision === false ? stripImageBlocks(payload.messages) : payload.messages;
			// The persisted anchor is validated against the messages ACTUALLY sent
			// (post image-stripping): three fail-closed gates in restoreAnchor —
			// a rejected anchor just means one fresh preflight summary.
			const anchorShape = asAnchorShape(payload.anchor);
			const anchor = anchorShape ? restoreAnchor(messages, anchorShape) : undefined;
			if (anchorShape) {
				runLogger.record({
					type: 'compaction_anchor',
					covered: anchorShape.covered,
					summaryChars: anchorShape.summary.length,
					accepted: anchor !== undefined,
				});
			}
			const loop = runAgentLoop(messages, {
				system,
				systemBreakdown,
				tools,
				modelClient: createModelClient(config),
				permissionGate: createGateForMode(mode, requestApproval),
				signal: controller.signal,
				// No configured context window → compaction stays off (never guessed).
				...(config.contextLength
					? {
							compaction: {
								contextWindow: config.contextLength,
								...(config.params?.maxTokens !== undefined ? { outputBudget: config.params.maxTokens } : {}),
								...(anchor ? { anchor: { summary: anchor.summary, covered: anchor.boundary, prefixChars: anchorShape!.prefixChars } } : {}),
							},
						}
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
