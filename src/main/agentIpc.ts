/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { runAgentLoop } from './agent/agentLoop.js';
import { deriveGrant, matchesAllowlist, type IAllowlistGrant } from './agent/approvalAllowlist.js';
import { addProjectAllowPatterns, isPersistablePattern, readProjectAllowlist } from './agent/approvalStore.js';
import type { IAgentMessage, IAgentTerminal, IAgentTool, ICompactionAnchor } from './agent/agentTypes.js';
import { restoreAnchor } from './agent/compaction.js';
import { agentLog } from './agent/observability/agentLog.js';
import { createJsonlFileSink, resolveAgentLogsDir } from './agent/observability/jsonlFileSink.js';
import { createRunLogger } from './agent/observability/runLogger.js';
import { asPermissionMode, createGateForMode, describeToolCall, type PermissionMode } from './agent/permission.js';
import { formatInstructionsBlock, isProjectInstructionsEnabled, loadProjectInstructions } from './agent/projectInstructions.js';
import { createWorkspaceTools } from './agent/tools/index.js';
import { createLanguageServerManager } from './agent/lsp/languageServerManager.js';
import { createDataSourceTools, type IQueryableSource } from './agent/tools/dataSourceTools.js';
import { createExecuteDataSourceTool } from './agent/tools/executeDataSourceTool.js';
import { isEffectivelyWritable } from '../sessions/services/environments/common/environments.js';
import { createRenderDataTool } from './agent/tools/renderDataTool.js';
import { storeSessionTableCsv } from './sessionsStorage.js';
import { createSshTools, type ISshServer } from './agent/tools/sshTool.js';
import { createModelClient } from './agent/createModelClient.js';
import { fetchCodingQuota, isQuotaExhaustedError, supportsCodingQuota } from './codingQuota.js';
import { createSpawnAgentTool } from './agent/tools/spawnAgentTool.js';
import { loadUserHooks } from './agent/hooks/userHookLoader.js';
import { generateSessionTitle } from './agent/sessionTitle.js';
import { getCredential } from './credentialStorage.js';
import { createSafeStorageCipher } from './secretCipher.js';
import { readWorkspaceConfig } from './workspaceConfigStorage.js';
import { ensureRemotesCloned, getProject, projectCodeRoots } from './projectsStorage.js';
import { resolveModelConfig, resolveSmallFastConfig } from './modelConfigStorage.js';
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
			'You are in plan mode: explore with the read-only tools (read_file, list_dir, glob, grep), then call propose_plan with a SECTIONED implementation plan — which files change, the approach, the steps, the risks.',
			'Do not attempt to change files or run commands.',
			'The plan card is the deliverable: after propose_plan, close with ONE short sentence and stop — do not restate the plan in prose.',
			'If the user left review comments on plan sections, revise accordingly and call propose_plan again (it becomes a new version).',
		);
	} else {
		lines.push(
			'Tools: read_file, list_dir, glob, grep, read_symbol to explore; write_file, edit_file to change files; bash to run commands; spawn_agent to delegate a read-only exploration to a sub-agent.',
			"Open your reply with ONE sentence sizing up the task, then start. SHAPE sets the discipline: diagnosis → verify against the live code/data THIS run before concluding; change → plan via update_plan first; question → answer directly, read only what the answer needs. For delegation there is exactly ONE test — will you need the files' contents again after the sweep? Needle lookups (a known path, a specific symbol, a 2-3 file scope) are ALWAYS direct reads, never delegated. Sweeps whose contents you will NOT need afterwards (audits, find-all-usages, structure surveys) go to spawn_agent, sharded by module/directory when large, all shards in ONE message so they run concurrently. Multi-step work gets an update_plan checklist first, whichever path executes it.",
			'A diagnosis that turns into an open-ended, multi-round trace — repeated grep→read→grep across modules to reach a verdict — is a sweep too, even though each hop alone looks like a needle. Apply the same test: if you will distill it to a conclusion and will not reread the raw files, delegate it — and when it has independent tracks (e.g. backend / frontend / live data), split them into concurrent spawn_agent calls in ONE message, then keep only the file:line evidence your conclusion needs. Do NOT walk a long grep→read→grep chain by hand in this context when a sub-agent can return just the verdict.',
			'When a sub-agent reports PARTIAL coverage, delegate the REMAINDER with a narrower scope — never redo in this context what it already covered. For mechanical extraction across many files (listing endpoints, counting patterns), a short bash/script pass usually beats reading files one by one — with or without a sub-agent.',
			'Do not make claims about code you have not read this session, and do not propose changes to files you have not read — read them first.',
			'Read-only tools never require approval: use them freely, and never ask the user for permission to read or search. When a tool call does need approval, the system prompts the user automatically; if denied, adjust your approach instead of retrying.',
			'Environment state (database connections, service reachability) is transient: an earlier failure in this conversation says nothing about now — the user may have fixed it. Never claim a resource is unavailable, and never quote an error, unless a tool call in THIS run actually produced it.',
			// Steer bash away from commands that block a turn or fabricate "evidence".
			'For tasks that only need understanding the code — assessing, summarizing, reviewing, explaining — read the relevant files; do NOT run the build or test suite just to "check".',
			'Use bash only for short, purposeful commands. Avoid long-running or blocking ones — dev servers, watch modes, full end-to-end / integration suites, or anything that launches the app or waits indefinitely — as they stall the turn. If a long command is genuinely required, scope it narrowly and set a timeout.',
			'When you need several independent pieces of information, you MUST send a single message with MULTIPLE tool calls — e.g. reading three files is ONE message with three read_file calls; `git status` and `git diff` is ONE message with two bash calls. One tool call per turn wastes a full model round-trip every time; only sequence calls whose inputs depend on an earlier result.',
			'Read WIDE, not in slivers. To understand a file, omit `limit` (read_file returns up to 2000 lines) or read a generous window in one call rather than paging it in 30-line slices — each narrow re-read of the same file burns another round-trip. When a grep hit is all you need to see in situ, pass grep a `context` window instead of following the grep with a separate read_file. To read the full body of a named function/method/class/interface, call read_symbol (one call, language-server-located) instead of grep-then-read_file. Context is cheap; round-trips are not.',
			'For any multi-step task, call update_plan first to lay out a short finite checklist, keep it updated as you go, and once every step is done STOP and give your final answer — do not keep pulling threads. Escalate to the user only when you are genuinely stuck after investigating, not as a first response to friction: verify code-level claims by reading the source, and ask the user only for runtime data (logs, database contents, live request values) that the code cannot show.',
			'After completing a multi-step task that CHANGED files, call write_walkthrough with a short sectioned report — what changed, how to verify — then close with one short sentence. Skip it for trivial or read-only tasks.',
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
	/** The user picked "always allow": add the request's grant to the session allowlist. */
	readonly always?: boolean;
	/** 'project' persists the grant to the project's approvals.json too (bash: only). */
	readonly scope?: 'session' | 'project';
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
	// The grant rides the pending entry because the response only carries a
	// requestId — the tool input (and the pattern derived from it) is long gone
	// by the time "always" comes back.
	const pendingApprovals = new Map<string, { readonly sessionId: string; readonly projectId?: string; readonly grant?: IAllowlistGrant; resolve(approved: boolean): void }>();
	// Session-level "always allow" patterns. In-memory only (never persisted),
	// keyed by sessionId like the pending/abort maps, so it survives across runs
	// of a session but dies with the process — the "会话级、不落盘" contract.
	const sessionAllowlists = new Map<string, Set<string>>();

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
		// The project's PERSISTED "always allow" patterns (bash: only), loaded once
		// per run. Grants made during the run land in the session set immediately,
		// so same-run coverage never depends on a re-read.
		const projectAllowlist = payload.projectId ? await readProjectAllowlist(dataRoot, payload.projectId) : new Set<string>();
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
		// Lazily-spawned language servers back read_symbol (see languageServerManager):
		// nothing starts until the tool is first called, so a run that never reads a
		// symbol pays nothing. Shared with sub-agents so they reuse the same servers.
		const languageServers = roots.length > 0 ? createLanguageServerManager(roots) : undefined;
		const fileTools = roots.length > 0 ? createWorkspaceTools(roots, { includeMutations: mode !== 'plan', ...(languageServers ? { languageServers } : {}) }) : [];

		// Read-only data-source tools: the project's configured databases become
		// queryable (SELECT only). Coordinates come from the workspace config;
		// credentials from the (encrypted) app store, resolved per query.
		const cipher = createSafeStorageCipher();
		const workspacePath = project?.workspacePath ?? project?.path;
		const wsConfig = workspacePath ? await readWorkspaceConfig(workspacePath) : undefined;
		const envName = new Map((wsConfig?.environments ?? []).map(environment => [environment.id, environment.name]));
		const envWritable = new Map((wsConfig?.environments ?? []).map(environment => [environment.id, environment.writable]));
		const querySources: IQueryableSource[] = (wsConfig?.dataSources ?? [])
			.filter(dataSource => dataSource.kind === 'database')
			.map(dataSource => ({
				id: dataSource.id,
				label: dataSource.label,
				environmentName: envName.get(dataSource.environmentId) ?? '',
				coordinates: dataSource.coordinates as IQueryableSource['coordinates'],
				// Effective writability = env writable ∧ account read-write; a
				// missing environment folds to NOT writable (fail closed).
				writable: isEffectivelyWritable(envWritable.get(dataSource.environmentId) ?? false, dataSource.access),
			}));
		const dataSourceTools = querySources.length > 0 ? createDataSourceTools({ sources: querySources, getSecret: id => getCredential(dataRoot, id, cipher) }) : [];
		// The write tool is mutation-class: omitted in plan mode (like bash/ssh);
		// in every other mode the permission gate asks per statement.
		const executeDataSourceTools =
			querySources.length > 0 && mode !== 'plan' ? [createExecuteDataSourceTool({ sources: querySources, getSecret: id => getCredential(dataRoot, id, cipher) })] : [];

		// SSH servers → run_on_server (mutation-class: gated, and omitted in plan mode like bash).
		const sshServers: ISshServer[] = (wsConfig?.dataSources ?? [])
			.filter(dataSource => dataSource.kind === 'server')
			.map(dataSource => ({
				id: dataSource.id,
				label: dataSource.label,
				environmentName: envName.get(dataSource.environmentId) ?? '',
				coordinates: dataSource.coordinates as ISshServer['coordinates'],
			}));
		// Mid-call progress (SFTP uploads) rides the same fan-out as sub-agent
		// telemetry: jsonl for diagnosis, agent:event for the live work panel.
		// Initialized to a no-op and rebound once runLogger exists (created later).
		let reportToolProgress: (event: { type: 'tool_progress'; toolUseId: string; name: string; note: string }) => void = () => {};
		const sshTools =
			sshServers.length > 0 && mode !== 'plan'
				? createSshTools({ servers: sshServers, roots, getSecret: id => getCredential(dataRoot, id, cipher), report: event => reportToolProgress(event) })
				: [];

		// Quota fast-stop (#19): a 403 means EVERY further request this run —
		// parent or any parallel child — hits the same wall. The wrapper aborts
		// the shared signal at the first one, so the whole run collapses now
		// instead of grinding through doomed retries; pauseOnExhaustion.quotaHit
		// tells the loop this abort means PAUSE — it settles as a resumable
		// 'paused' terminal carrying the frozen transcript, not a user-stop.
		let quotaError: Error | undefined;
		const withQuotaFastStop = (raw: ReturnType<typeof createModelClient>): ReturnType<typeof createModelClient> => ({
			async *stream(request) {
				try {
					yield* raw.stream(request);
				} catch (error) {
					if (quotaError === undefined && isQuotaExhaustedError(error)) {
						quotaError = error instanceof Error ? error : new Error(String(error));
						controller.abort();
					}
					throw error;
				}
			},
		});
		// The main (thinking) client serves the parent loop.
		const modelClient = withQuotaFastStop(createModelClient(config));
		// Small-fast tier (#21 W1): delegated sub-agents run on the provider's
		// cheap NON-thinking model so exploration doesn't burn the main model.
		// Same quota fast-stop; falls back to the main client when the provider
		// has no designated small-fast tier.
		const smallFastConfig = resolveSmallFastConfig(config);
		const spawnModelClient = smallFastConfig ? withQuotaFastStop(createModelClient(smallFastConfig)) : modelClient;

		// render_data: the agent pushes tabular results into the data panel; the
		// csv lands beside the transcript so the chip replays after restarts.
		const renderDataTool = createRenderDataTool({
			storeCsv: (title, csv) => storeSessionTableCsv(dataRoot, { sessionId: payload.sessionId, ...(payload.projectId ? { projectId: payload.projectId } : {}) }, title, csv),
		});
		const baseTools: readonly IAgentTool[] = [...fileTools, ...dataSourceTools, ...executeDataSourceTools, ...sshTools, renderDataTool];
		// spawn_agent (in-process read-only sub-agent, see spawnAgentTool.ts) is
		// added below, after the run logger exists to receive its telemetry —
		// it is read-only, so every permission mode admits it.
		const hasSpawnAgent = roots.length > 0;

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
				// "Always allow": session grants ∪ the project's persisted grants —
				// a covered call runs unattended, with no prompt. Checked here (not in
				// the gate) so permission.ts keeps its read-only/plan/full semantics.
				const sessionAllowlist = sessionAllowlists.get(payload.sessionId);
				const allowlist = sessionAllowlist ? new Set([...sessionAllowlist, ...projectAllowlist]) : projectAllowlist;
				if (allowlist.size > 0 && matchesAllowlist(tool.name, input, allowlist)) {
					resolve(true);
					return;
				}
				// Only offer the third button for tools that are safe to always-allow
				// (deriveGrant returns undefined for run_on_server et al.).
				const grant = deriveGrant(tool.name, input);
				pendingApprovals.set(context.toolUseId, {
					sessionId: payload.sessionId,
					...(payload.projectId ? { projectId: payload.projectId } : {}),
					...(grant ? { grant } : {}),
					resolve,
				});
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
					...(grant ? { alwaysAllow: grant.display } : {}),
					// The permanent option exists only for persistable grants (bash:)
					// inside a project — never for sandbox escapes or file edits.
					...(grant && payload.projectId !== undefined && grant.patterns.every(isPersistablePattern) ? { alwaysAllowProject: true } : {}),
				});
			});

		const runLogger = createRunLogger({
			runId: `${payload.sessionId}-${Date.now()}`,
			sessionId: payload.sessionId,
			model: config.model,
			mode,
			hasWorkspace: cwd !== undefined,
			toolCount: baseTools.length + (hasSpawnAgent ? 1 : 0),
			...(cwd ? { cwd } : {}),
			...(payload.projectId ? { projectId: payload.projectId } : {}),
			...(instructions ? { instructions: { file: instructions.file, chars: instructions.text.length, truncated: instructions.truncated } } : {}),
			...(config.contextLength !== undefined ? { contextWindow: config.contextLength } : {}),
		});
		// Sub-agent progress fans out to BOTH sinks: the jsonl log (diagnosis) and
		// the renderer (live work-panel narration) — the parent loop is blocked on
		// the tool while a child runs, so these can't ride the normal yield path.
		reportToolProgress = event => {
			runLogger.record(event);
			if (!sender.isDestroyed()) {
				sender.send('agent:event', { sessionId: payload.sessionId, event });
			}
		};
		const spawnTools = hasSpawnAgent
			? [
					createSpawnAgentTool({
						roots,
						modelClient: spawnModelClient,
						...(languageServers ? { languageServers } : {}),
						record: event => {
							runLogger.record(event);
							if (!sender.isDestroyed()) {
								sender.send('agent:event', { sessionId: payload.sessionId, event });
							}
						},
					}),
				]
			: [];
		const tools: readonly IAgentTool[] = [...baseTools, ...spawnTools];

		try {
			// The capability sentences must match the tools actually registered THIS
			// run — a stale "read-only SELECT" claim made the model refuse writes
			// even though execute_data_source was in its tool list, and with no
			// render_ui mention it presented a migration preview as markdown tables
			// (observed in the 2026-07-16 smoke-test logs).
			const hasRenderUi = fileTools.some(tool => tool.name === 'render_ui');
			const dbNote =
				querySources.length > 0
					? `\nThis project has ${querySources.length} configured database data source(s). Use list_data_sources to see them and query_data_source (read-only SELECT) to inspect data.` +
						(executeDataSourceTools.length > 0
							? ' Writes go through execute_data_source — one statement per call, each individually approved by the user; sources marked READ-ONLY are refused unconditionally.'
							: '') +
						(hasRenderUi
							? ' When the user asks for a data-migration or field-mapping workbench, build it with render_ui (component=surface_patch) using the field_mapping / Table primitives — NEVER as markdown tables in prose; the surface lets the user pair fields and correct cells directly.'
							: '')
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
			// User-configured hooks (design §10 M3): GLOBAL config only for now
			// (~/.mellivora/hooks.json — always trusted). Project hooks and their
			// approval prompt arrive with the settings UI; loadUserHooks already
			// gates them, so wiring a projectDir later is additive.
			const { hooks: userHooks } = await loadUserHooks({ globalDir: dataRoot });

			const loop = runAgentLoop(messages, {
				system,
				systemBreakdown,
				tools,
				modelClient,
				permissionGate: createGateForMode(mode, requestApproval),
				signal: controller.signal,
				...(userHooks.length > 0 ? { userHooks } : {}),
				// Top-level run: quota/rate exhaustion freezes resumable (#19 缺陷 2).
				pauseOnExhaustion: { quotaHit: () => quotaError?.message },
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

			// A paused terminal (#19 缺陷 2) gets the relevant window's reset
			// time attached when the usage endpoint answers — quota (403) waits
			// on the WEEKLY reset, rate_limit (429) on the nearest rolling
			// window. Best-effort: a failed lookup just means no countdown.
			let terminal = step.value;
			if (terminal.reason === 'paused' && terminal.paused && supportsCodingQuota({ baseURL: config.baseURL }) && config.apiKey) {
				const quota = await fetchCodingQuota(config.baseURL, config.apiKey);
				const resetTime =
					terminal.paused.cause === 'quota' ? quota?.usage.resetTime : (quota?.windows.find(window => window.resetTime !== undefined)?.resetTime ?? quota?.usage.resetTime);
				if (resetTime !== undefined) {
					terminal = { ...terminal, paused: { ...terminal.paused, resetTime } };
				}
			}

			// The terminal rides the same channel so it can never overtake a
			// trailing event the way the handler's return value can.
			if (!sender.isDestroyed()) {
				sender.send('agent:event', { sessionId: payload.sessionId, done: terminal });
			}

			return terminal;
		} catch (error) {
			runLogger.error('run', error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			abortControllers.delete(payload.sessionId);
			settleApprovals(payload.sessionId);
			agentLog.flush();
			// Tear down any language servers this run started (best-effort; a manager
			// that never spawned one resolves immediately).
			await languageServers?.dispose();
		}
	});

	// One-shot title generation — a plain model call, not an agent run: no tools,
	// thinking off, tiny budget. Failures reject; the renderer keeps its placeholder.
	ipcMain.handle('agent:title', async (_event, payload: IAgentTitlePayload): Promise<string | undefined> => {
		const config = await resolveModelConfig(dataRoot, payload.modelId ?? '');
		if (!config) {
			return undefined;
		}

		// Title generation is auxiliary — run it on the small-fast tier when the
		// provider has one (#21 W1), the main model otherwise.
		const titleConfig = resolveSmallFastConfig(config) ?? config;
		const client = createModelClient({ ...titleConfig, params: { maxTokens: TITLE_MAX_TOKENS } });
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
			// "Always" only takes effect for a grant we actually offered — a stray
			// always=true on a non-always-allowable tool (e.g. run_on_server) has no
			// grant and is silently ignored, so prod SSH can never be allowlisted.
			if (payload.approved === true && payload.always === true && pending.grant) {
				const allowlist = sessionAllowlists.get(pending.sessionId) ?? new Set<string>();
				for (const pattern of pending.grant.patterns) {
					allowlist.add(pattern);
				}
				sessionAllowlists.set(pending.sessionId, allowlist);
				// 'project' additionally persists — approvalStore re-filters to bash:
				// grants, so a stray scope on a non-persistable grant is a no-op.
				if (payload.scope === 'project' && pending.projectId) {
					void addProjectAllowPatterns(dataRoot, pending.projectId, pending.grant.patterns).catch(() => {});
				}
			}
			pending.resolve(payload.approved === true);
		}
	});

	ipcMain.handle('agent:stop', (_event, sessionId: string) => {
		abortControllers.get(sessionId)?.abort();
	});
}
