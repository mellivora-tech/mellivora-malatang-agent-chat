/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { observableValue, type ObservableValue } from '../../../base/common/observable.js';
import { localize } from '../../../common/i18n/i18n.js';
import type { IAgentBridge, IAgentMessage, PermissionMode, IAgentPause } from '../../../services/agent/common/agent.js';
import type { IGitBridge, IGitDiffFile } from '../../../services/git/common/git.js';
import type { IArtifactsBridge } from '../../../services/artifacts/common/artifacts.js';
import { buildChangeSetEntry } from '../../../services/artifacts/common/changeSet.js';
import type { IModelsService } from '../../../services/models/browser/modelsService.js';
import type {
	IPlanComment,
	ISession,
	ISessionAttachment,
	ISessionChangesSummary,
	ISessionContextUsage,
	ISessionMessage,
	ISessionPausedRun,
	ISessionPendingApproval,
	ISessionReconnect,
	ISessionDataBrowse,
	ISessionWorkStep,
	ISessionWorkspace,
} from '../../../services/sessions/common/session.js';
import { DOCUMENT_SPLIT_MARKER_PREFIX, RENDERED_TABLE_MARKER, SUBAGENT_END_ARG_PREFIX, SessionInteractivity, SessionStatus, estimateSessionTokens } from '../../../services/sessions/common/session.js';
import { materializePlan, nextPlanVersion, parsePlanInput, planToMarkdown, type IProposePlanInput } from '../../../services/sessions/common/planArtifact.js';
import { materializeUi, parseUiInput, uiToMarkdown, type IRenderUiInput } from '../../../services/sessions/common/uiArtifact.js';
import { permissionMode } from '../../../services/agent/browser/permissionModeService.js';
import type { ISessionCompactionAnchorData, ISessionPausedRunData, ISessionsBridge, ISessionRef, ISessionSnapshot, ISessionStateEntry } from '../../../services/sessions/common/sessionsBridge.js';
import type { IPendingImage, ISendMessageOptions, ISessionChangeEvent, ISessionsProvider, IStartSessionOptions } from '../../../services/sessions/common/sessionsProvider.js';
import type { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

export interface IFileSessionsProviderOptions {
	readonly responseDelayMs?: number;
}

interface IPendingReply {
	readonly timer: ReturnType<typeof setTimeout>;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

const DEFAULT_RESPONSE_DELAY_MS = 3000;
// Auto-resume fires this long AFTER the reported reset time — the provider's
// clock and the reset edge need a little daylight (#19 缺陷 2).
const RESUME_BUFFER_MS = 30_000;

type BridgeGlobals = typeof globalThis & { readonly agentWindow?: { readonly git?: IGitBridge; readonly artifacts?: IArtifactsBridge } };

interface IMutableSession extends ISession {
	readonly workspace: ObservableValue<ISessionWorkspace | undefined>;
	readonly title: ObservableValue<string>;
	readonly updatedAt: ObservableValue<Date>;
	readonly status: ObservableValue<SessionStatus>;
	readonly description: ObservableValue<string | undefined>;
	readonly changesSummary: ObservableValue<ISessionChangesSummary | undefined>;
	readonly isArchived: ObservableValue<boolean>;
	readonly isRead: ObservableValue<boolean>;
	readonly isPinned: ObservableValue<boolean>;
	readonly messages: ObservableValue<readonly ISessionMessage[]>;
	readonly planComments: ObservableValue<readonly IPlanComment[]>;
	readonly interactivity: ObservableValue<SessionInteractivity>;
	readonly pendingApproval: ObservableValue<ISessionPendingApproval | undefined>;
	readonly reconnect: ObservableValue<ISessionReconnect | undefined>;
	readonly permissionMode: ObservableValue<PermissionMode>;
	readonly contextUsage: ObservableValue<ISessionContextUsage | undefined>;
	readonly pausedRun: ObservableValue<ISessionPausedRun | undefined>;
	/** Cross-run compaction anchor — internal harness state, never rendered, hence no observable. */
	compactionAnchor?: ISessionCompactionAnchorData;
	/** The frozen transcript of a paused run (#19 缺陷 2) — resent verbatim on resume. Internal like the anchor; pausedRun is its UI projection. */
	pausedTranscript?: readonly IAgentMessage[];
}

function createSession(options: {
	sessionId: string;
	projectId?: string;
	createdAt: Date;
	updatedAt: Date;
	icon: string;
	status: SessionStatus;
	title: string;
	description?: string;
	workspace?: ISessionWorkspace;
	messages: readonly ISessionMessage[];
	interactivity: SessionInteractivity;
	changesSummary?: ISessionChangesSummary;
	isArchived?: boolean;
	isRead?: boolean;
	isPinned?: boolean;
	permissionMode?: PermissionMode;
	compactionAnchor?: ISessionCompactionAnchorData;
	contextUsage?: ISessionContextUsage;
	pausedRun?: ISessionPausedRun;
	pausedTranscript?: readonly IAgentMessage[];
	planComments?: readonly IPlanComment[];
}): IMutableSession {
	return {
		sessionId: options.sessionId,
		providerId: 'file-sessions',
		sessionType: 'agent-chat',
		icon: options.icon,
		createdAt: options.createdAt,
		projectId: options.projectId,
		workspace: observableValue<ISessionWorkspace | undefined>(options.workspace),
		title: observableValue(options.title),
		updatedAt: observableValue(options.updatedAt),
		status: observableValue(options.status),
		description: observableValue(options.description),
		changesSummary: observableValue(options.changesSummary),
		isArchived: observableValue(options.isArchived ?? false),
		isRead: observableValue(options.isRead ?? true),
		isPinned: observableValue(options.isPinned ?? false),
		messages: observableValue(options.messages),
		planComments: observableValue<readonly IPlanComment[]>(options.planComments ?? []),
		interactivity: observableValue(options.interactivity),
		pendingApproval: observableValue<ISessionPendingApproval | undefined>(undefined),
		reconnect: observableValue<ISessionReconnect | undefined>(undefined),
		permissionMode: observableValue<PermissionMode>(options.permissionMode ?? 'ask'),
		contextUsage: observableValue<ISessionContextUsage | undefined>(options.contextUsage),
		pausedRun: observableValue<ISessionPausedRun | undefined>(options.pausedRun),
		...(options.compactionAnchor ? { compactionAnchor: options.compactionAnchor } : {}),
		...(options.pausedTranscript ? { pausedTranscript: options.pausedTranscript } : {}),
	};
}

/** Renderer-side twin of the harness's asPermissionMode: unknown values fail closed to 'ask'. */
function coercePermissionMode(value: unknown): PermissionMode {
	return value === 'full' || value === 'plan' || value === 'auto-edit' || value === 'ask' ? value : 'ask';
}

export class FileSessionsProvider implements ISessionsProvider {
	readonly id = 'file-sessions';
	readonly label = 'Sessions';
	readonly icon = 'codicon-copilot';
	readonly order = 0;

	private readonly onDidChangeSessionsEmitter = new Emitter<ISessionChangeEvent>();
	readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

	private readonly sessions: IMutableSession[] = [];
	/** Auto-resume timers for frozen runs, keyed by sessionId (#19 缺陷 2). */
	private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly refs = new Map<string, ISessionRef>();
	private readonly pendingReplies = new Map<string, IPendingReply>();
	/** Raw base64 of stored images, keyed `sessionId:path` — populated on store and on first read-back. */
	private readonly mediaCache = new Map<string, string>();
	private readonly responseDelayMs: number;
	private writeQueue: Promise<void> = Promise.resolve();
	private initialized = false;
	/** In-flight runs' finalizers — drained on window unload so an app quit persists "[应用退出]" summaries instead of erasing the runs (a killed run once vanished without a trace, 2026-07-14). */
	private readonly inflightFinalizers = new Set<() => void>();

	constructor(
		private readonly bridge: ISessionsBridge,
		options: IFileSessionsProviderOptions = {},
		private readonly agent?: IAgentBridge,
		private readonly modelsService?: IModelsService,
	) {
		this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
		if (typeof window !== 'undefined') {
			// Best-effort: the appends are async IPC, but the main process outlives
			// the window long enough to drain them in practice. Without this, a
			// quit mid-run leaves the transcript as if the run never happened.
			window.addEventListener('beforeunload', () => {
				for (const flush of [...this.inflightFinalizers]) {
					flush();
				}
			});
		}
	}

	private readonly git: IGitBridge | undefined = (globalThis as BridgeGlobals).agentWindow?.git;
	private readonly artifactsBridge: IArtifactsBridge | undefined = (globalThis as BridgeGlobals).agentWindow?.artifacts;
	/** Last change-set artifact id snapshotted per session — the append-side noise gate (#13 P2). */
	private readonly lastChangeSetIds = new Map<string, string>();

	/**
	 * Pull the project's real working-tree diff onto the session and persist it.
	 * At run end (`captureChangeSet`) a non-empty diff is also snapshotted into
	 * the artifacts index as a change-set (#13 P2) — the content-hash id both
	 * dedups identical snapshots and lets a changed diff land as a new row.
	 */
	private async refreshChangesSummary(session: IMutableSession, captureChangeSet = false): Promise<void> {
		if (!this.git || !session.projectId) {
			return;
		}
		const stat = await this.git.diffStat(session.projectId);
		// The badge counts keep their pre-P2 口径: files = unique changed paths.
		const summary = stat === undefined ? undefined : { files: stat.files.length, additions: stat.additions, deletions: stat.deletions, changedFiles: stat.files };
		session.changesSummary.set(summary);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		if (captureChangeSet && stat !== undefined) {
			void this.captureChangeSet(session, stat.files);
		}
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(session.sessionId), { type: 'state', timestamp: new Date().toISOString(), ...(summary ? { changesSummary: summary } : {}) });
		});
	}

	/** Record the run-end diff as a change-set artifact (#13 P2). Best-effort: the index is a mirror, never worth failing a run over. */
	private async captureChangeSet(session: IMutableSession, files: readonly IGitDiffFile[]): Promise<void> {
		if (this.artifactsBridge?.record === undefined) {
			return;
		}
		const entry = buildChangeSetEntry({
			sessionId: session.sessionId,
			...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
			files,
			createdAt: new Date().toISOString(),
		});
		// undefined = empty diff (nothing to snapshot); an unchanged id = the
		// same content this session already snapshotted — skip both, so repeated
		// finalizes never stack duplicate index lines.
		if (entry === undefined || this.lastChangeSetIds.get(session.sessionId) === entry.id) {
			return;
		}
		this.lastChangeSetIds.set(session.sessionId, entry.id);
		try {
			await this.artifactsBridge.record(entry);
		} catch (error) {
			console.warn(`Recording the change-set artifact failed for ${session.sessionId}:`, error);
		}
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}
		this.initialized = true;

		const snapshots = await this.bridge.list();
		const added: IMutableSession[] = [];
		for (const snapshot of snapshots) {
			const session = this.hydrateSession(snapshot);
			this.sessions.push(session);
			this.refs.set(session.sessionId, toRef(snapshot));
			added.push(session);
		}

		if (added.length > 0) {
			this.onDidChangeSessionsEmitter.fire({ added, removed: [], changed: [] });
		}
		// Rehydrated freezes re-arm their auto-resume timers (a reset already
		// past arms nothing — the banner's manual button takes over).
		for (const session of added) {
			if (session.pausedRun.get() !== undefined) {
				this.armAutoResume(session);
			}
		}
	}

	getSessions(): readonly ISession[] {
		return this.sessions;
	}

	async startSession(query: string, options?: IStartSessionOptions): Promise<ISession> {
		const sessionId = generateId();
		const ref: ISessionRef = { sessionId, ...(options?.projectId ? { projectId: options.projectId } : {}) };
		const now = new Date();
		const initialMode = permissionMode.get();
		const imageAttachments = await this.storeImages(ref, options?.images);
		const attachments = normalizeAttachments([...(options?.attachments ?? []), ...imageAttachments]);
		const userMessage: ISessionMessage = { id: `${sessionId}-user-${generateId()}`, role: 'user', text: query, timestamp: now, ...(attachments ? { attachments } : {}) };

		await this.enqueueWrite(async () => {
			await this.bridge.create({
				type: 'session',
				version: 1,
				sessionId,
				sessionType: 'agent-chat',
				icon: 'codicon-new-session',
				createdAt: now.toISOString(),
				interactivity: 'full',
				...(options?.projectId ? { projectId: options.projectId } : {}),
				...(options?.workspace ? { workspace: options.workspace } : {}),
			});
			await this.bridge.append(ref, { type: 'message', id: userMessage.id, role: 'user', text: query, timestamp: now.toISOString(), ...(attachments ? { attachments } : {}) });
			await this.bridge.append(ref, {
				type: 'state',
				timestamp: now.toISOString(),
				status: SessionStatus.InProgress,
				title: query,
				description: 'Agent is working on the first prompt.',
				isRead: false,
				permissionMode: initialMode,
			});
		});

		const session = createSession({
			sessionId,
			...(options?.projectId ? { projectId: options.projectId } : {}),
			createdAt: now,
			updatedAt: now,
			icon: 'codicon-new-session',
			status: SessionStatus.InProgress,
			title: query,
			description: 'Agent is working on the first prompt.',
			...(options?.workspace ? { workspace: options.workspace } : {}),
			messages: [userMessage],
			interactivity: SessionInteractivity.Full,
			isRead: false,
			permissionMode: initialMode,
		});

		this.sessions.unshift(session);
		this.refs.set(sessionId, ref);
		this.onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		void this.refreshChangesSummary(session);
		this.generateReply(session);
		void this.generateTitle(session, query);
		return session;
	}

	/**
	 * Swap the first-message placeholder title for a model-generated one,
	 * concurrently with the first reply. Best-effort: any failure leaves the
	 * placeholder, and a title that is no longer the placeholder (rename, fork)
	 * is never overwritten.
	 */
	private async generateTitle(session: IMutableSession, query: string): Promise<void> {
		if (!this.agent?.generateTitle) {
			return;
		}
		try {
			const modelId = this.modelsService?.selectedModel.get()?.id;
			const title = await this.agent.generateTitle(query, modelId);
			if (!title || title === query || session.title.get() !== query || !this.sessions.includes(session)) {
				return;
			}
			session.title.set(title);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			await this.enqueueWrite(() => this.bridge.append(this.getRef(session.sessionId), { type: 'state', timestamp: new Date().toISOString(), title }));
		} catch (error) {
			console.warn(`Title generation failed for ${session.sessionId}:`, error);
		}
	}

	async sendMessage(sessionId: string, query: string, options?: ISendMessageOptions): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		const ref = this.getRef(sessionId);
		const now = new Date();
		const imageAttachments = await this.storeImages(ref, options?.images);
		const attachments = normalizeAttachments([...(options?.attachments ?? []), ...imageAttachments]);
		const message: ISessionMessage = { id: `${sessionId}-user-${generateId()}`, role: 'user', text: query, timestamp: now, ...(attachments ? { attachments } : {}) };

		await this.enqueueWrite(async () => {
			await this.bridge.append(ref, { type: 'message', id: message.id, role: 'user', text: query, timestamp: now.toISOString(), ...(attachments ? { attachments } : {}) });
			await this.bridge.append(ref, { type: 'state', timestamp: now.toISOString(), status: SessionStatus.InProgress, isRead: false });
		});

		session.messages.set([...session.messages.get(), message]);
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(now);
		session.isRead.set(false);
		// A new message while a run sits frozen abandons the freeze — the user
		// chose a different continuation over resuming (#19 缺陷 2). The frozen
		// tool results are gone with it; the digest already marked the run
		// interrupted, so the next model treats prior findings as provisional.
		this.clearPausedRun(session, true);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.generateReply(session);
		return session;
	}

	/**
	 * Resume a quota/rate-frozen run (#19 缺陷 2): resend the frozen transcript
	 * VERBATIM — the model continues from mid-run with every already-collected
	 * tool result in view; nothing is re-explored. If the wall is still there,
	 * the run simply freezes again (same transcript, refreshed reset time).
	 */
	async resumeSession(sessionId: string): Promise<void> {
		const session = this.getMutableSession(sessionId);
		const frozen = session.pausedTranscript;
		if (!frozen || frozen.length === 0 || session.status.get() === SessionStatus.InProgress) {
			return;
		}
		this.clearPausedRun(session, true);
		const now = new Date();
		await this.enqueueWrite(() => this.bridge.append(this.getRef(sessionId), { type: 'state', timestamp: now.toISOString(), status: SessionStatus.InProgress }));
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(now);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.runAgentReply(session, frozen);
	}

	/** Drop the frozen run (observable + transcript + timer); `persist` appends the null tombstone so the clear survives restarts. */
	private clearPausedRun(session: IMutableSession, persist: boolean): void {
		const timer = this.resumeTimers.get(session.sessionId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.resumeTimers.delete(session.sessionId);
		}
		if (session.pausedRun.get() === undefined && session.pausedTranscript === undefined) {
			return;
		}
		session.pausedRun.set(undefined);
		delete session.pausedTranscript;
		if (persist) {
			this.enqueueWrite(() => this.bridge.append(this.getRef(session.sessionId), { type: 'state', timestamp: new Date().toISOString(), pausedRun: null })).catch(error =>
				console.error(`Failed to clear paused run for ${session.sessionId}:`, error),
			);
		}
	}

	/**
	 * Auto-resume (#19 缺陷 2): with the reset time known, the pause ends
	 * itself — the timer fires shortly after the window refreshes and resends
	 * the frozen transcript. A pause with no reset time (usage endpoint had no
	 * answer) waits for the manual button only, as does one whose reset was
	 * already past on rehydration (firing a surprise run on app start is worse
	 * than showing the banner).
	 */
	private armAutoResume(session: IMutableSession): void {
		const existing = this.resumeTimers.get(session.sessionId);
		if (existing !== undefined) {
			clearTimeout(existing);
			this.resumeTimers.delete(session.sessionId);
		}
		const resetTime = session.pausedRun.get()?.resetTime;
		if (resetTime === undefined) {
			return;
		}
		const delayMs = new Date(resetTime).getTime() - Date.now() + RESUME_BUFFER_MS;
		if (Number.isNaN(delayMs) || delayMs <= 0) {
			return;
		}
		const timer = setTimeout(() => {
			this.resumeTimers.delete(session.sessionId);
			if (session.pausedRun.get() !== undefined && session.status.get() !== SessionStatus.InProgress) {
				void this.resumeSession(session.sessionId);
			}
		}, delayMs);
		this.resumeTimers.set(session.sessionId, timer);
	}

	async stopSession(sessionId: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		this.cancelPendingReply(sessionId);
		void this.agent?.stop(sessionId);
		if (session.status.get() === SessionStatus.InProgress) {
			const now = new Date();
			await this.enqueueWrite(() => this.bridge.append(this.getRef(sessionId), { type: 'state', timestamp: now.toISOString(), status: SessionStatus.NeedsInput }));
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(now);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		}

		return session;
	}

	async renameSession(sessionId: string, title: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		const trimmed = title.trim();
		if (trimmed === '' || trimmed === session.title.get()) {
			return session;
		}
		session.title.set(trimmed);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		// The fold takes the LAST title-bearing state entry, so appending is the
		// whole persistence story — and generateTitle's placeholder guard means a
		// concurrent AI title can never overwrite a manual rename.
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(sessionId), { type: 'state', timestamp: new Date().toISOString(), title: trimmed });
		});
		return session;
	}

	async setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		await this.persistStatePatch(sessionId, { isPinned });
		session.isPinned.set(isPinned);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		return session;
	}

	async setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		await this.persistStatePatch(sessionId, { isArchived });
		session.isArchived.set(isArchived);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		return session;
	}

	async setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		session.permissionMode.set(mode);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(sessionId), { type: 'state', timestamp: new Date().toISOString(), permissionMode: mode });
		});
		return session;
	}

	async setMessageFeedback(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		session.messages.set(
			session.messages.get().map(message => {
				if (message.id !== messageId) {
					return message;
				}
				const { feedback: _previous, ...rest } = message;
				return feedback === undefined ? rest : { ...rest, feedback };
			}),
		);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(sessionId), { type: 'feedback', messageId, feedback: feedback ?? null, timestamp: new Date().toISOString() });
		});
		return session;
	}

	async setPlanState(sessionId: string, messageId: string, state: 'draft' | 'approved' | 'superseded'): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		session.messages.set(
			session.messages.get().map(message => (message.id === messageId && message.plan !== undefined ? { ...message, plan: { ...message.plan, state } } : message)),
		);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(sessionId), { type: 'planState', messageId, planState: state, timestamp: new Date().toISOString() });
		});
		return session;
	}

	async setPlanComment(sessionId: string, comment: IPlanComment): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		const comments = session.planComments.get();
		const index = comments.findIndex(candidate => candidate.id === comment.id);
		session.planComments.set(index === -1 ? [...comments, comment] : [...comments.slice(0, index), comment, ...comments.slice(index + 1)]);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(sessionId), {
				type: 'planComment',
				comment: { ...comment, createdAt: comment.createdAt.toISOString() },
				timestamp: new Date().toISOString(),
			});
		});
		return session;
	}

	async forkSession(sessionId: string, messageId: string): Promise<ISession> {
		const source = this.getMutableSession(sessionId);
		const history = source.messages.get();
		const cutoff = history.findIndex(message => message.id === messageId);
		const messages = (cutoff === -1 ? history : history.slice(0, cutoff + 1)).map(message => ({ ...message }));

		const forkId = generateId();
		const ref: ISessionRef = { sessionId: forkId, ...(source.projectId ? { projectId: source.projectId } : {}) };
		const now = new Date();
		const title = `Fork of ${source.title.get()}`;
		const workspace = source.workspace.get();

		await this.enqueueWrite(async () => {
			await this.bridge.create({
				type: 'session',
				version: 1,
				sessionId: forkId,
				sessionType: 'agent-chat',
				icon: 'codicon-new-session',
				createdAt: now.toISOString(),
				interactivity: 'full',
				...(source.projectId ? { projectId: source.projectId } : {}),
				...(workspace ? { workspace } : {}),
			});
			for (const message of messages) {
				await this.bridge.append(ref, {
					type: 'message',
					id: message.id,
					role: message.role,
					text: message.text,
					timestamp: now.toISOString(),
					...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
					...(message.detail !== undefined ? { detail: message.detail } : {}),
					...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
					...(message.outcome !== undefined ? { outcome: message.outcome } : {}),
					...(message.steps !== undefined ? { steps: message.steps } : {}),
					...(message.plan !== undefined ? { plan: message.plan } : {}),
					...(message.ui !== undefined ? { ui: message.ui } : {}),
				});
			}
			await this.bridge.append(ref, {
				type: 'state',
				timestamp: now.toISOString(),
				status: SessionStatus.NeedsInput,
				title,
				permissionMode: source.permissionMode.get(),
				isRead: true,
			});
		});

		const fork = createSession({
			sessionId: forkId,
			...(source.projectId ? { projectId: source.projectId } : {}),
			createdAt: now,
			updatedAt: now,
			icon: 'codicon-new-session',
			status: SessionStatus.NeedsInput,
			title,
			...(workspace ? { workspace } : {}),
			messages,
			interactivity: SessionInteractivity.Full,
			permissionMode: source.permissionMode.get(),
		});
		this.sessions.unshift(fork);
		this.refs.set(forkId, ref);
		this.onDidChangeSessionsEmitter.fire({ added: [fork], removed: [], changed: [] });
		return fork;
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this.getMutableSession(sessionId);
		this.cancelPendingReply(sessionId);
		this.clearPausedRun(session, false);
		await this.enqueueWrite(() => this.bridge.delete(this.getRef(sessionId)));
		const index = this.sessions.indexOf(session);
		if (index !== -1) {
			this.sessions.splice(index, 1);
		}
		this.refs.delete(sessionId);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [session], changed: [] });
	}

	async whenIdle(): Promise<void> {
		while (this.pendingReplies.size > 0) {
			await Promise.all([...this.pendingReplies.values()].map(pending => pending.promise));
		}
		await this.writeQueue;
	}

	private hydrateSession(snapshot: ISessionSnapshot): IMutableSession {
		return createSession({
			sessionId: snapshot.sessionId,
			createdAt: new Date(snapshot.createdAt),
			updatedAt: new Date(snapshot.updatedAt),
			icon: snapshot.icon,
			// A persisted InProgress cannot resume its reply timer across a
			// restart, so it settles to NeedsInput.
			status: coerceStatus(snapshot.status),
			title: snapshot.title,
			permissionMode: coercePermissionMode(snapshot.permissionMode),
			messages: snapshot.messages.map(message => ({
				id: message.id,
				role: message.role,
				text: message.text,
				...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
				...(message.detail !== undefined ? { detail: message.detail } : {}),
				...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
				...(message.outcome !== undefined ? { outcome: message.outcome } : {}),
				...(message.steps !== undefined ? { steps: message.steps } : {}),
				...(message.plan !== undefined ? { plan: message.plan } : {}),
				...(message.ui !== undefined ? { ui: message.ui } : {}),
				...(message.feedback !== undefined ? { feedback: message.feedback } : {}),
				...(message.timestamp !== undefined ? { timestamp: new Date(message.timestamp) } : {}),
			})),
			...(snapshot.planComments !== undefined ? { planComments: snapshot.planComments.map(comment => ({ ...comment, createdAt: new Date(comment.createdAt) })) } : {}),
			interactivity: coerceInteractivity(snapshot.interactivity),
			isArchived: snapshot.isArchived,
			isRead: snapshot.isRead,
			isPinned: snapshot.isPinned,
			...(snapshot.projectId !== undefined ? { projectId: snapshot.projectId } : {}),
			...(snapshot.description !== undefined ? { description: snapshot.description } : {}),
			...(snapshot.workspace !== undefined ? { workspace: snapshot.workspace } : {}),
			...(snapshot.changesSummary !== undefined ? { changesSummary: snapshot.changesSummary } : {}),
			...(snapshot.compactionAnchor !== undefined ? { compactionAnchor: snapshot.compactionAnchor } : {}),
			// A frozen run survives restarts: the UI projection and the raw
			// transcript rehydrate separately (#19 缺陷 2).
			...(snapshot.pausedRun !== undefined
				? {
						pausedRun: {
							cause: snapshot.pausedRun.cause,
							message: snapshot.pausedRun.message,
							...(snapshot.pausedRun.resetTime !== undefined ? { resetTime: snapshot.pausedRun.resetTime } : {}),
							pausedAt: new Date(snapshot.pausedRun.pausedAt),
						},
						pausedTranscript: snapshot.pausedRun.transcript as readonly IAgentMessage[],
					}
				: {}),
			// A persisted reading is a real bill from a previous run — restored
			// as 'restored' so the UI labels it "(last run)" until this process
			// produces a fresh one.
			...(snapshot.contextUsage !== undefined
				? {
						contextUsage: {
							inputTokens: snapshot.contextUsage.inputTokens,
							totalSource: 'restored' as const,
							...(snapshot.contextUsage.breakdown ? { breakdown: snapshot.contextUsage.breakdown } : {}),
						},
					}
				: {}),
		});
	}

	private getMutableSession(sessionId: string): IMutableSession {
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		return session;
	}

	private getRef(sessionId: string): ISessionRef {
		return this.refs.get(sessionId) ?? { sessionId };
	}

	// Pin/archive intentionally do not bump updatedAt so rows keep their
	// position; the fold recomputes updatedAt from entry timestamps on the
	// next load, which is acceptable drift.
	private persistStatePatch(sessionId: string, patch: { isPinned?: boolean; isArchived?: boolean }): Promise<void> {
		return this.enqueueWrite(() => this.bridge.append(this.getRef(sessionId), { type: 'state', timestamp: new Date().toISOString(), ...patch }));
	}

	private enqueueWrite(write: () => Promise<void>): Promise<void> {
		const next = this.writeQueue.then(write);
		this.writeQueue = next.catch(() => undefined);
		return next;
	}

	/** Persist composer images to session media; a failed store drops that image (the message still sends). */
	private async storeImages(ref: ISessionRef, images: readonly IPendingImage[] | undefined): Promise<ISessionAttachment[]> {
		if (!images || images.length === 0 || !this.bridge.storeMedia) {
			return [];
		}
		const attachments: ISessionAttachment[] = [];
		for (const image of images) {
			try {
				const path = await this.bridge.storeMedia(ref, image.data, image.mediaType);
				attachments.push({ kind: 'image', path, mediaType: image.mediaType });
				this.mediaCache.set(`${ref.sessionId}:${path}`, image.data);
			} catch (error) {
				console.warn(`Storing an attached image failed for ${ref.sessionId}:`, error);
			}
		}
		return attachments;
	}

	private async readMediaBase64(sessionId: string, path: string): Promise<string | undefined> {
		const key = `${sessionId}:${path}`;
		const cached = this.mediaCache.get(key);
		if (cached) {
			return cached;
		}
		const data = await this.bridge.readMedia?.(this.getRef(sessionId), path);
		if (data) {
			this.mediaCache.set(key, data);
		}
		return data;
	}

	/** Data URL for a stored image attachment — the conversation view's thumbnails. */
	async resolveMedia(sessionId: string, path: string): Promise<string | undefined> {
		const data = await this.readMediaBase64(sessionId, path);
		return data ? `data:${mediaTypeFromPath(path)};base64,${data}` : undefined;
	}

	/** Markdown of a split answer's document attachment — the reference card's expand (#13 长答案分流). Undefined when the file is gone or the bridge is old. */
	async resolveDocumentText(sessionId: string, path: string): Promise<string | undefined> {
		try {
			return await this.bridge.readMediaText?.(this.getRef(sessionId), path);
		} catch {
			return undefined;
		}
	}

	/**
	 * The model request needs image bytes, which live on disk — resolve every
	 * image attachment in the history (cache-first) before building the
	 * transcript. An unreadable image degrades to text-only rather than failing
	 * the run.
	 */
	private async buildTranscript(session: IMutableSession): Promise<IAgentMessage[]> {
		const messages = session.messages.get();
		const images = new Map<string, { mediaType: string; data: string }>();
		const sessionContexts = new Map<string, string>();
		for (const message of messages) {
			for (const attachment of message.attachments ?? []) {
				if (attachment.kind === 'image' && !images.has(attachment.path)) {
					const data = await this.readMediaBase64(session.sessionId, attachment.path);
					if (data) {
						images.set(attachment.path, { mediaType: attachment.mediaType ?? mediaTypeFromPath(attachment.path), data });
					}
				} else if (attachment.kind === 'session' && !sessionContexts.has(attachment.path)) {
					// Resolved live from the in-memory session list: the referenced
					// conversation may have grown since it was attached — recent turns win.
					const referenced = this.sessions.find(candidate => candidate.sessionId === attachment.path);
					if (referenced && referenced.sessionId !== session.sessionId) {
						sessionContexts.set(attachment.path, formatSessionContext(referenced.title.get(), referenced.messages.get()));
					}
				}
			}
		}
		return toTranscript(messages, images, sessionContexts);
	}

	private generateReply(session: IMutableSession): void {
		const hasModel = this.modelsService?.registry.get().providers.some(provider => provider.models.some(model => model.enabled)) ?? false;
		if (this.agent && hasModel) {
			void this.runAgentReply(session);
			return;
		}

		// No agent bridge or no enabled model — say so honestly instead of faking a reply.
		this.scheduleNoModelReply(session);
	}

	private runAgentReply(session: IMutableSession, resumeTranscript?: readonly IAgentMessage[]): void {
		const agent = this.agent;
		if (!agent) {
			return;
		}

		const sessionId = session.sessionId;
		// The composer's picker; the runtime still falls back to the first
		// enabled model when nothing is selected.
		const modelId = this.modelsService?.selectedModel.get()?.id;
		const assistantId = `${sessionId}-assistant-${generateId()}`;
		const workId = `${sessionId}-work-${generateId()}`;
		let text = '';
		let created = false;
		let finalized = false;
		// A quota/rate-frozen terminal (#19 缺陷 2): captured from the done event,
		// persisted by finalize, and surfaced as banner + humanized copy.
		let pendingPause: IAgentPause | undefined;

		// The work block tracks how the run spends its time: thinking stretches
		// between events, and one step per tool call. Timestamps are taken on the
		// renderer side as events arrive.
		const workStart = Date.now();
		const steps: ISessionWorkStep[] = [];
		let stepStart = workStart;
		// Every in-flight call, keyed by toolUseId — the runner emits a concurrent
		// batch's tool_use events up front (#15 P1), so several calls are open at
		// once and each carries its own clock, facts, and browse payload. Closed
		// steps land in `steps` in COMPLETION order (the chronological truth);
		// the API-side result ordering is the runner's concern, not ours.
		interface IOpenCall {
			label: string;
			name: string;
			arg?: string;
			browse?: ISessionDataBrowse;
			startedAt: number;
		}
		const openCalls = new Map<string, IOpenCall>();
		// The run's latest propose_plan / write_walkthrough inputs — last call of
		// each wins; materialized into role:'plan' messages at finalize
		// (ids/version assigned there, never by the model).
		let pendingPlanInput: IProposePlanInput | undefined;
		let pendingWalkthroughInput: IProposePlanInput | undefined;
		// render_ui inputs — an ARRAY: multiple cards per run are legal, and only
		// successful parses are pushed (a failed parse already told the model via
		// the tool error; pushing nothing avoids double-materializing a retry).
		const pendingUiInputs: IRenderUiInput[] = [];
		// The run's work digest (files read/changed), emitted once at run end;
		// materialized into a hidden role:'digest' message at finalize and carried
		// on the next run's transcript to pay down the re-exploration tax.
		let pendingDigest: string | undefined;
		// Reasoning text streamed since the last step boundary; becomes the
		// closing thinking step's expandable detail. While streaming it also
		// feeds the live synthetic thinking step, painted on a trailing throttle.
		let thinkingBuffer = '';
		let lastThinkingPaint = 0;
		let thinkingPaintTimer: number | undefined;
		const THINKING_PAINT_MS = 150;
		// A redacted thinking block arrived this stretch — real reasoning with no
		// visible text. It earns an honest time-only "思考了 Ns" row; a stretch
		// with NEITHER deltas nor a redacted block is just latency (k3 skips
		// thinking on quick tool-continuation turns) and gets no row at all.
		let thinkingRedacted = false;
		// Visible text streamed within the CURRENT turn. If the turn goes on to
		// call tools, this was narration ("我来梳理一下…"), not the answer — it
		// relocates into the work block so it neither squats in the answer
		// bubble for the whole run nor gets concatenated with the real reply.
		// Only a terminal turn's text (no tools after it) stays as the answer.
		let turnText = '';
		// Cross-run anchor capture: the transcript as sent (for the integrity
		// measure) and the newest ok compaction of this run.
		let sentTranscript: readonly IAgentMessage[] = [];
		let pendingAnchor: ISessionCompactionAnchorData | undefined;
		// Per-child narration state, keyed by agentId (== the spawn call's
		// toolUseId) — parallel children interleave their events, so each keeps
		// its own pending action, clock, and the spawn label to restore at end.
		// Action facts carry the CHILD's real tool name (+ via/agent) so a
		// child's read sweep folds into rollups and never merges across agents.
		interface ISubagentSlot {
			spawnLabel: string | undefined;
			action?: string;
			facts?: { tool: string; arg?: string; via: 'subagent'; agent: string };
			actionStart: number;
		}
		const subagentSlots = new Map<string, ISubagentSlot>();

		const closeStep = (
			kind: ISessionWorkStep['kind'],
			label: string,
			detail?: string,
			facts?: { tool?: string; arg?: string; outcome?: 'ok' | 'error'; via?: 'subagent'; agent?: string },
			extra?: { startedAt?: number; durationMs?: number; browse?: ISessionDataBrowse },
		): void => {
			// Tool steps carry their own clock (parallel calls overlap); a batch
			// result's measured runtime wins outright — ordered emission means
			// arrival time ≠ runtime. Thinking/narration still measure from the
			// shared step boundary.
			const durationMs = extra?.durationMs ?? Date.now() - (extra?.startedAt ?? stepStart);
			const stepDetail = kind === 'thinking' ? (thinkingBuffer.trim() === '' ? undefined : truncateStepDetail(thinkingBuffer, false)) : detail;
			const redacted = kind === 'thinking' && thinkingRedacted;
			if (kind === 'thinking') {
				thinkingBuffer = '';
				thinkingRedacted = false;
			}
			// A thinking row exists only for REAL reasoning: streamed text, or a
			// redacted block (encrypted but genuine). Contentless stretches are
			// request latency — mislabeling TTFT as "思考了 11s" was a lie the
			// live stream made obvious (2026-07-18 review).
			if (kind !== 'thinking' || stepDetail !== undefined || redacted) {
				steps.push({
					kind,
					label,
					durationMs,
					...(stepDetail === undefined ? {} : { detail: stepDetail }),
					...(extra?.browse === undefined ? {} : { browse: extra.browse }),
					...(facts?.tool === undefined ? {} : { tool: facts.tool }),
					...(facts?.arg === undefined ? {} : { arg: facts.arg }),
					...(facts?.outcome === undefined ? {} : { outcome: facts.outcome }),
					...(facts?.via === undefined ? {} : { via: facts.via }),
					...(facts?.agent === undefined ? {} : { agent: facts.agent }),
				});
			}
			stepStart = Date.now();
		};

		// A segment with no buffered reasoning after visible text has begun is
		// answer-writing (or verifier) time, not thought — don't let it masquerade
		// as a "Thought for Xs" step. The clock still resets so the elapsed time
		// can't leak into the next step. (`text === ''` keeps honest time-only
		// Thought steps for models that reason without streaming it.)
		const closeThinkingOrSkip = (): void => {
			if (text === '' || thinkingBuffer.trim() !== '') {
				closeStep('thinking', 'Thought');
			} else {
				stepStart = Date.now();
			}
		};

		const updateWork = (durationMs?: number, outcome?: 'ok' | 'error'): void => {
			// Every RUNNING call rides the live view as a synthetic open step —
			// steps only holds closed ones, which left long tool calls (a 5-minute
			// SFTP upload, a parallel sub-agent) invisible until they finished.
			// tool_progress / subagent events refresh each entry's label. Facts
			// ride along so a running read joins the live rollup, not breaks it.
			const liveSteps: ISessionWorkStep[] = [...steps];
			// 思考直播 (#14 P1): the CURRENT thinking stretch rides the live view
			// as a synthetic running step whose detail is the streaming tail —
			// closeStep collapses it into the usual "思考了 Ns" summary row.
			if (thinkingBuffer.trim() !== '') {
				liveSteps.push({
					kind: 'thinking',
					label: 'Thinking',
					durationMs: Date.now() - stepStart,
					running: true,
					detail: thinkingBuffer.length > 600 ? thinkingBuffer.slice(-600) : thinkingBuffer,
				});
			}
			for (const [callId, call] of openCalls) {
				liveSteps.push({
					kind: 'tool',
					label: call.label,
					durationMs: Date.now() - call.startedAt,
					running: true,
					tool: call.name,
					...(call.arg === undefined ? {} : { arg: call.arg }),
					// A running spawn's synthetic step routes into its child's group
					// so the live view shows the current action inside the section.
					...(call.name === 'spawn_agent' ? { agent: callId } : {}),
				});
			}
			const workMessage: ISessionMessage = { id: workId, role: 'work', text: '', steps: liveSteps, ...(durationMs === undefined ? {} : { durationMs }), ...(outcome === undefined ? {} : { outcome }) };
			const messages = session.messages.get();
			session.messages.set(messages.some(message => message.id === workId) ? messages.map(message => (message.id === workId ? workMessage : message)) : [...messages, workMessage]);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		};
		updateWork();

		const updateAssistant = (): void => {
			const messages = session.messages.get();
			if (!created) {
				created = true;
				session.messages.set([...messages, { id: assistantId, role: 'assistant', text, timestamp: new Date() }]);
			} else {
				session.messages.set(messages.map(message => (message.id === assistantId ? { ...message, text } : message)));
			}
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		};

		// A turn that streamed text and THEN called tools was narrating, not
		// answering — move that text out of the answer bubble into a work step.
		// Runs at the turn's first tool_use; the loop's event order (deltas,
		// then tool_use blocks at stream end) makes that the earliest moment
		// the disposition is knowable, so the text still streams live until
		// then and simply relocates the instant the turn declares itself.
		const relocateTurnNarration = (): void => {
			if (turnText === '') {
				return;
			}
			const narration = turnText.trim();
			text = text.slice(0, text.length - turnText.length);
			turnText = '';
			if (narration !== '') {
				steps.push({
					kind: 'narration',
					label: narration.length > 200 ? `${narration.slice(0, 200)}…` : narration,
					durationMs: 0,
					...(narration.length > 200 ? { detail: narration } : {}),
				});
			}
			if (created && text === '') {
				// The bubble held nothing but narration — remove it entirely
				// (same replace-not-append discipline as the reply verifier).
				created = false;
				session.messages.set(session.messages.get().filter(message => message.id !== assistantId));
				this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			} else if (created) {
				updateAssistant();
			}
		};

		// Torn down when the run settles, whatever ends it (done event, error,
		// window unload).
		const runCleanups: (() => void)[] = [];
		runCleanups.push(() => {
			if (thinkingPaintTimer !== undefined) {
				clearTimeout(thinkingPaintTimer);
				thinkingPaintTimer = undefined;
			}
		});

		// What a killed run leaves in the transcript: the last thing the model was
		// thinking/doing, distilled from the work steps. A bare "Stopped." erased
		// a whole deploy investigation from the next run's memory — the model then
		// honestly denied ever reporting the failure the user had watched live.
		const abortSummary = (cause: string): string => {
			const lastThought = [...steps].reverse().find(step => (step.kind === 'narration' || step.kind === 'thinking') && (step.detail ?? step.label).trim() !== '');
			const lastTool = [...steps].reverse().find(step => step.kind === 'tool');
			const parts: string[] = [];
			if (lastThought) {
				const thought = (lastThought.detail ?? lastThought.label).trim();
				parts.push(localize('run.abortLastThought', thought.length > 300 ? `${thought.slice(0, 300)}…` : thought));
			}
			if (lastTool) {
				parts.push(localize('run.abortLastTool', lastTool.label));
			}
			return parts.length === 0 ? localize('run.abortNote', cause) : `${localize('run.abortNoteDetailed', cause)}\n${parts.join('\n')}`;
		};

		const finalize = (reason?: string): void => {
			if (finalized) {
				return;
			}
			finalized = true;
			for (const cleanup of runCleanups) {
				cleanup();
			}
			dispose();
			disposeApprovals();
			session.pendingApproval.set(undefined);
			session.reconnect.set(undefined);
			if (openCalls.size > 0 || subagentSlots.size > 0) {
				// A run ending with calls still open (abort, error) — each closes
				// without a result, so its outcome is honestly an error. Pending
				// child actions close first (they belong inside their spawn).
				for (const [agentId, slot] of subagentSlots) {
					if (slot.action !== undefined) {
						closeStep('tool', slot.action, undefined, { ...(slot.facts ?? { tool: 'subagent', via: 'subagent', agent: agentId }), outcome: 'error' }, { startedAt: slot.actionStart });
					}
				}
				subagentSlots.clear();
				for (const call of openCalls.values()) {
					closeStep('tool', call.label, undefined, { tool: call.name, ...(call.arg === undefined ? {} : { arg: call.arg }), outcome: 'error' }, { startedAt: call.startedAt });
				}
				openCalls.clear();
			} else {
				closeThinkingOrSkip();
			}
			const workDuration = Date.now() - workStart;
			// 'completed' is the only clean ending — aborts, limits, refusals and
			// harness errors (reason undefined) all leave the block un-collapsed
			// with its evidence in view (#14 Q1: failed runs don't tuck away).
			const runOutcome: 'ok' | 'error' = reason === 'completed' ? 'ok' : 'error';
			updateWork(workDuration, runOutcome);

			// A run that ends without any text (e.g. the step limit) must not leave a
			// blank assistant bubble — say what happened, or persist no reply at all.
			if (!created && text === '') {
				if (reason === 'max_turns') {
					text = 'I reached the step limit before finishing — ask me to continue, or narrow the task.';
				} else if (reason === 'max_output_tokens') {
					// The whole output budget went to (hidden) reasoning before any
					// visible text — without this note the run would end in silence.
					text = 'I hit the output token limit before producing a reply — ask me to continue.';
				} else if (reason === 'aborted') {
					text = abortSummary(localize('run.causeUser'));
				} else if (reason === 'app_quit') {
					text = abortSummary(localize('run.causeQuit'));
				}
			}
			// The pause copy always lands — appended to a partial reply, or as
			// the whole bubble. humanizeAgentRunError reads the [quota-reset]
			// marker and renders the concrete recovery time.
			if (reason === 'paused' && pendingPause) {
				const raw = pendingPause.resetTime !== undefined ? `${pendingPause.message}\n[quota-reset: ${pendingPause.resetTime}]` : pendingPause.message;
				const human = humanizeAgentRunError(raw);
				text = created && text.trim() !== '' ? `${text}\n\n${human}` : human;
			}
			const hasReply = text !== '';
			if (hasReply) {
				updateAssistant();
			}
			// 长答案分流 (#13, 原 #14 P2 / Q4 决议): a CLEAN completion's long answer
			// keeps only whole-paragraph summary in the bubble — the full text lands
			// as a document artifact beside the transcript, referenced by a generic
			// attachment card (no new role, no dedicated card). Abort / pause /
			// error runs never split: their partial text IS the evidence.
			let documentSplit: { readonly summary: string; readonly full: string; readonly title: string } | undefined;
			if (reason === 'completed' && hasReply && this.bridge.storeDocument !== undefined) {
				const split = splitLongAnswer(text);
				if (split !== undefined) {
					const sessionTitle = session.title.get().trim();
					documentSplit = { ...split, title: sessionTitle !== '' ? sessionTitle : firstLine(split.full) };
				}
			}

			if (pendingAnchor) {
				session.compactionAnchor = pendingAnchor;
			}
			const anchorToPersist = pendingAnchor;
			// Freeze (#19 缺陷 2): UI projection on the session, raw transcript
			// held provider-side, both persisted so the pause survives restarts.
			let pausedRunToPersist: ISessionPausedRunData | undefined;
			if (reason === 'paused' && pendingPause) {
				pausedRunToPersist = {
					cause: pendingPause.cause,
					message: pendingPause.message,
					...(pendingPause.resetTime !== undefined ? { resetTime: pendingPause.resetTime } : {}),
					pausedAt: new Date().toISOString(),
					transcript: pendingPause.frozenTranscript,
				};
				session.pausedRun.set({
					cause: pendingPause.cause,
					message: pendingPause.message,
					...(pendingPause.resetTime !== undefined ? { resetTime: pendingPause.resetTime } : {}),
					pausedAt: new Date(),
				});
				session.pausedTranscript = pendingPause.frozenTranscript;
				this.armAutoResume(session);
			}
			// The meter's last reading survives restarts (rehydrated as "last
			// run"). Estimates are never persisted — restoring a guess as if it
			// were a bill would defeat the labeling.
			const usageAtEnd = session.contextUsage.get();
			const usageToPersist =
				usageAtEnd && usageAtEnd.totalSource !== 'estimate'
					? { inputTokens: usageAtEnd.inputTokens, ...(usageAtEnd.breakdown ? { breakdown: usageAtEnd.breakdown } : {}) }
					: undefined;
			const now = new Date();

			// propose_plan / write_walkthrough calls materialize into role:'plan'
			// messages here — deterministic ids/version, markdown fallback on
			// `text` (older builds and the next run's transcript both read it).
			// They slot between the work block and the answer bubble, in the live
			// view and on disk alike. Only a new PLAN retires earlier plans —
			// walkthroughs are settled reports, outside the version chain.
			let planMessage: ISessionMessage | undefined;
			let walkthroughMessage: ISessionMessage | undefined;
			let supersededIds: readonly string[] = [];
			if (pendingPlanInput !== undefined) {
				const planId = `${sessionId}-plan-${generateId()}`;
				const plan = materializePlan(pendingPlanInput, planId, nextPlanVersion(session.messages.get()));
				planMessage = { id: planId, role: 'plan', text: planToMarkdown(plan), plan, timestamp: now };
				// A new version retires every earlier plan still in play — live
				// view first, matching planState entries below.
				supersededIds = session.messages
					.get()
					.filter(message => message.plan !== undefined && (message.plan.kind ?? 'plan') === 'plan' && message.plan.state !== 'superseded')
					.map(message => message.id);
			}
			if (pendingWalkthroughInput !== undefined) {
				const walkthroughId = `${sessionId}-walkthrough-${generateId()}`;
				const walkthrough = materializePlan(pendingWalkthroughInput, walkthroughId, nextPlanVersion(session.messages.get(), 'walkthrough'), 'walkthrough');
				walkthroughMessage = { id: walkthroughId, role: 'plan', text: planToMarkdown(walkthrough), plan: walkthrough, timestamp: now };
			}
			// render_ui cards: no supersede semantics, one message per captured call.
			const uiMessages: ISessionMessage[] = pendingUiInputs.map(input => {
				const uiId = `${sessionId}-ui-${generateId()}`;
				return { id: uiId, role: 'ui', text: uiToMarkdown(input), ui: materializeUi(input, uiId), timestamp: now };
			});
			const artifactMessages = [planMessage, walkthroughMessage, ...uiMessages].filter((message): message is ISessionMessage => message !== undefined);
			if (artifactMessages.length > 0) {
				const messages = session.messages
					.get()
					.map(message => (supersededIds.includes(message.id) && message.plan !== undefined ? { ...message, plan: { ...message.plan, state: 'superseded' as const } } : message));
				const assistantIndex = messages.findIndex(message => message.id === assistantId);
				session.messages.set(
					assistantIndex === -1 ? [...messages, ...artifactMessages] : [...messages.slice(0, assistantIndex), ...artifactMessages, ...messages.slice(assistantIndex)],
				);
			}

			// The work digest lands last (after the answer) as a hidden message, so
			// the next run's transcript carries it at the tail — see toTranscript,
			// which forwards only the most recent digest.
			let digestText = pendingDigest;
			if (reason === 'aborted' || reason === 'app_quit' || reason === 'paused') {
				// An interrupted run marks the digest so the NEXT model treats the
				// carried state as provisional. The abort summary (assistant text)
				// aligns the user-visible memory; this line aligns the model's.
				const previous = digestText ?? [...session.messages.get()].reverse().find(message => message.role === 'digest')?.text;
				const note = 'Note: the previous run was INTERRUPTED mid-task — its work is incomplete and any conclusions from it are provisional; re-verify before relying on them.';
				if (previous === undefined) {
					digestText = `<work-digest>\n${note}\n</work-digest>`;
				} else if (!previous.includes('INTERRUPTED mid-task')) {
					digestText = previous.replace('</work-digest>', `${note}\n</work-digest>`);
				} else {
					digestText = previous;
				}
			}
			let digestMessage: ISessionMessage | undefined;
			if (digestText !== undefined) {
				digestMessage = { id: `${sessionId}-digest-${generateId()}`, role: 'digest', text: digestText, timestamp: now };
				session.messages.set([...session.messages.get(), digestMessage]);
			}

			this.enqueueWrite(async () => {
				const ref = this.getRef(sessionId);
				await this.bridge.append(ref, { type: 'message', id: workId, role: 'work', text: '', durationMs: workDuration, outcome: runOutcome, steps, timestamp: now.toISOString() });
				for (const supersededId of supersededIds) {
					await this.bridge.append(ref, { type: 'planState', messageId: supersededId, planState: 'superseded', timestamp: now.toISOString() });
				}
				for (const artifactMessage of artifactMessages) {
					if (artifactMessage.plan || artifactMessage.ui) {
						await this.bridge.append(ref, {
							type: 'message',
							id: artifactMessage.id,
							role: artifactMessage.role,
							text: artifactMessage.text,
							...(artifactMessage.plan ? { plan: artifactMessage.plan } : {}),
							...(artifactMessage.ui ? { ui: artifactMessage.ui } : {}),
							timestamp: now.toISOString(),
						});
					}
				}
				if (hasReply) {
					let assistantText = text;
					let assistantAttachments: readonly ISessionAttachment[] | undefined;
					if (documentSplit !== undefined) {
						// The swap happens only AFTER the store succeeded — a failed
						// store keeps the full text in the bubble instead of losing it.
						// The persisted tail carries the human note (localized once, at
						// write time) plus the machine marker the next run's transcript
						// needs (message.text IS what toTranscript sends).
						try {
							const stored = await this.bridge.storeDocument!(ref, documentSplit.title, documentSplit.full);
							assistantText = `${documentSplit.summary}\n\n${localize('conv.docSplitNote')}\n[${DOCUMENT_SPLIT_MARKER_PREFIX}: ${documentSplit.title}]`;
							assistantAttachments = [{ kind: 'document', path: stored.path, label: documentSplit.title }];
						} catch (splitError) {
							console.error(`Storing the split document failed for ${sessionId}:`, splitError);
						}
					}
					await this.bridge.append(ref, {
						type: 'message',
						id: assistantId,
						role: 'assistant',
						text: assistantText,
						...(assistantAttachments !== undefined ? { attachments: assistantAttachments } : {}),
						timestamp: now.toISOString(),
					});
					if (assistantAttachments !== undefined) {
						// Fold the live bubble to what was persisted (streaming showed
						// the full text until here — same live-then-fold discipline as
						// the work block's collapse).
						const attachments = assistantAttachments;
						session.messages.set(session.messages.get().map(message => (message.id === assistantId ? { ...message, text: assistantText, attachments } : message)));
						this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
					}
				}
				if (digestMessage) {
					await this.bridge.append(ref, { type: 'message', id: digestMessage.id, role: 'digest', text: digestMessage.text, timestamp: now.toISOString() });
				}
				await this.bridge.append(ref, {
					type: 'state',
					timestamp: now.toISOString(),
					status: SessionStatus.NeedsInput,
					isRead: false,
					...(anchorToPersist ? { compactionAnchor: anchorToPersist } : {}),
					...(usageToPersist ? { contextUsage: usageToPersist } : {}),
					...(pausedRunToPersist ? { pausedRun: pausedRunToPersist } : {}),
				});
			}).catch(persistError => console.error(`Failed to persist assistant reply for ${sessionId}:`, persistError));

			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(now);
			session.isRead.set(false);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			// The run may have edited files — reflect the real diff now, and
			// snapshot it as a change-set artifact when it is non-empty (#13 P2).
			void this.refreshChangesSummary(session, true);
		};

		const dispose = agent.onEvent(payload => {
			if (payload.sessionId !== sessionId) {
				return;
			}
			const event = payload.event;
			if (event?.type === 'stream_retry') {
				// The attempt restarts from scratch — drop its partial reasoning.
				thinkingBuffer = '';
				thinkingRedacted = false;
				session.reconnect.set({ attempt: event.attempt, maxAttempts: event.maxAttempts });
				return;
			}
			if (event?.type === 'thinking_delta') {
				thinkingBuffer += event.text;
				// Deltas arrive at token frequency — paint the live view on a
				// trailing throttle, never per delta (the 2800-message lesson).
				const now = Date.now();
				if (now - lastThinkingPaint >= THINKING_PAINT_MS) {
					lastThinkingPaint = now;
					updateWork();
				} else if (thinkingPaintTimer === undefined) {
					thinkingPaintTimer = window.setTimeout(
						() => {
							thinkingPaintTimer = undefined;
							lastThinkingPaint = Date.now();
							if (!finalized) {
								updateWork();
							}
						},
						THINKING_PAINT_MS - (now - lastThinkingPaint),
					);
				}
				return;
			}
			if (event?.type === 'thinking_redacted') {
				thinkingRedacted = true;
				return;
			}
			if (session.reconnect.get() !== undefined) {
				// Any other event means the stream recovered.
				session.reconnect.set(undefined);
			}
			if (event?.type === 'turn_start') {
				// Stale turn text must never leak into a later turn's narration —
				// e.g. the reply verifier's rejected answer (its bubble is cleared,
				// but turnText would still hold the text) relocating as a step.
				turnText = '';
			} else if (event?.type === 'assistant_delta') {
				// First text after thinking closes the stretch; text after a tool
				// result belongs to the next thinking stretch, so only close once.
				if (text === '' && openCalls.size === 0) {
					closeStep('thinking', 'Thought');
					updateWork();
				}
				turnText += event.text;
				text += event.text;
				updateAssistant();
			} else if (event?.type === 'tool_use') {
				// A concurrent batch emits all its tool_use events before any
				// result — only the FIRST open call closes the thinking stretch.
				if (openCalls.size === 0) {
					closeThinkingOrSkip();
				}
				relocateTurnNarration();
				if (event.name === 'propose_plan') {
					// Malformed input stays on the previous capture — the tool result
					// already told the model what was wrong.
					pendingPlanInput = parsePlanInput(event.input) ?? pendingPlanInput;
				} else if (event.name === 'write_walkthrough') {
					pendingWalkthroughInput = parsePlanInput(event.input) ?? pendingWalkthroughInput;
				} else if (event.name === 'render_ui') {
					const parsedUi = parseUiInput(event.input);
					if (parsedUi !== undefined) {
						pendingUiInputs.push(parsedUi);
					}
				}
				const arg = workToolArg(event.input);
				const browse = parseBrowsePayload(event.name, event.input);
				openCalls.set(event.toolUseId, {
					label: describeWorkTool(event.name, event.input),
					name: event.name,
					...(arg === undefined ? {} : { arg }),
					...(browse === undefined ? {} : { browse }),
					startedAt: Date.now(),
				});
				updateWork();
			} else if (event?.type === 'tool_result') {
				const call = openCalls.get(event.toolUseId);
				if (call !== undefined) {
					let content = event.content;
					// render_data: lift the chip payload from the marker tail, and
					// keep the marker out of the visible step detail.
					if (call.name === 'render_data' && !event.isError) {
						const rendered = RENDERED_TABLE_MARKER.exec(content);
						if (rendered?.[1]) {
							const path = rendered[1];
							call.browse = { kind: 'file', path, name: path.split('/').pop() ?? path };
							content = content.replace(RENDERED_TABLE_MARKER, '');
						}
					}
					closeStep(
						'tool',
						call.label,
						truncateStepDetail(content, event.isError),
						{
							tool: call.name,
							...(call.arg === undefined ? {} : { arg: call.arg }),
							outcome: event.isError ? 'error' : 'ok',
							// The spawn's own result row belongs to its child's group
							// (agentId == the spawn's toolUseId) — it carries the real
							// per-child duration the section header displays.
							...(call.name === 'spawn_agent' ? { agent: event.toolUseId } : {}),
						},
						{ startedAt: call.startedAt, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }), ...(call.browse === undefined ? {} : { browse: call.browse }) },
					);
					openCalls.delete(event.toolUseId);
					updateWork();
				}
			} else if (event?.type === 'tool_progress') {
				// Live label for the running call (e.g. "上传 … 47% · 4.1 MB/s").
				// The eventual tool_result closes the step as usual, so the final
				// label is the last progress line — which reads as the summary.
				const progressCall = openCalls.get(event.toolUseId);
				if (progressCall !== undefined) {
					progressCall.label = event.note;
					updateWork();
				}
			} else if (event?.type === 'subagent_start') {
				// A child loop is running inside its spawn_agent call (agentId ==
				// the spawn's toolUseId). The child's narration takes over THAT
				// call's live label until subagent_end restores it, so the spawn's
				// own tool_result still closes a matching step. Parallel children
				// each own a slot — events route by agentId and never cross.
				const spawnCall = openCalls.get(event.agentId);
				subagentSlots.set(event.agentId, { spawnLabel: spawnCall?.label, actionStart: Date.now() });
				closeStep('tool', localize('run.subagentSpawn', firstLine(event.task)), undefined, { tool: 'spawn_agent', arg: firstLine(event.task), agent: event.agentId }, { startedAt: Date.now() });
				if (spawnCall !== undefined) {
					spawnCall.label = localize('run.subagentStarting');
				}
				updateWork();
			} else if (event?.type === 'subagent_tool') {
				const slot = subagentSlots.get(event.agentId) ?? { spawnLabel: undefined, actionStart: Date.now() };
				subagentSlots.set(event.agentId, slot);
				if (slot.action !== undefined) {
					closeStep('tool', slot.action, undefined, slot.facts ?? { tool: 'subagent', via: 'subagent', agent: event.agentId }, { startedAt: slot.actionStart });
				}
				slot.action = `⑃ ${event.summary}`;
				// summary is "name arg" by construction; recover the arg for the chip.
				const childArg = event.summary.startsWith(`${event.name} `) ? firstLine(event.summary.slice(event.name.length + 1)) : undefined;
				slot.facts = { tool: event.name, ...(childArg === undefined || childArg === '' ? {} : { arg: childArg }), via: 'subagent', agent: event.agentId };
				slot.actionStart = Date.now();
				const actionCall = openCalls.get(event.agentId);
				if (actionCall !== undefined) {
					actionCall.label = slot.action;
				}
				updateWork();
			} else if (event?.type === 'subagent_progress') {
				// The child model is streaming with no tool events (#19 缺陷 1) — a
				// long final report used to freeze the running row on the last tool
				// line for minutes. Live label only: no step is closed, and facts
				// stay on the last real tool action.
				const progressAction = openCalls.get(event.agentId);
				if (progressAction !== undefined) {
					const amount = event.chars >= 1000 ? localize('run.charsK', (event.chars / 1000).toFixed(1)) : localize('run.chars', event.chars);
					progressAction.label = localize('run.subagentProgress', event.phase === 'thinking' ? localize('run.phaseThinking') : localize('run.phaseWriting'), amount);
					updateWork();
				}
			} else if (event?.type === 'subagent_end') {
				const slot = subagentSlots.get(event.agentId);
				if (slot?.action !== undefined) {
					closeStep('tool', slot.action, undefined, slot.facts ?? { tool: 'subagent', via: 'subagent', agent: event.agentId }, { startedAt: slot.actionStart });
				}
				closeStep(
					'tool',
					localize('run.subagentEndLabel', event.reason),
					`${event.turns} turns · ${event.toolCalls} tool calls · ${Math.round(event.tokens / 1000)}k tokens`,
					// arg carries the reason so the structured verb row ("子代理")
					// keeps the outcome visible — the label is legacy-only now.
					{ tool: 'subagent', arg: `${SUBAGENT_END_ARG_PREFIX} · ${event.reason}`, outcome: 'ok', agent: event.agentId },
					{ startedAt: Date.now() },
				);
				const endCall = openCalls.get(event.agentId);
				if (endCall !== undefined) {
					endCall.label = slot?.spawnLabel ?? endCall.label;
				}
				subagentSlots.delete(event.agentId);
				updateWork();
			} else if (event?.type === 'usage') {
				// The provider's real prompt size for the request just completed —
				// the conversation view prefers this over its char-count estimate.
				// Cache hits are part of the prompt (Anthropic wire semantics keeps
				// them out of input_tokens), so the meter sums all three. The last
				// breakdown (from the SAME turn's context_breakdown, which always
				// precedes usage — it describes the request, usage its response)
				// rides along so the total updates without blanking the panel.
				const previousUsage = session.contextUsage.get();
				session.contextUsage.set({
					inputTokens: event.inputTokens + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0),
					totalSource: 'real',
					...(previousUsage?.breakdown ? { breakdown: previousUsage.breakdown } : {}),
				});
			} else if (event?.type === 'context_breakdown') {
				// Emitted before the request goes out, every turn — the panel can
				// show the mechanisms working live even before the model replies.
				// The best known total carries forward: a real one from this
				// process, or a restored one from the last run's persisted state.
				// With neither (a genuinely fresh session), fall back to the SAME
				// char/4 estimate the ring itself would show, rather than inventing
				// a fake "real" 0 that would flash the meter to 0% until usage
				// lands a moment later.
				const previousUsage = session.contextUsage.get();
				const carryTotal = previousUsage !== undefined && previousUsage.totalSource !== 'estimate';
				session.contextUsage.set({
					inputTokens: carryTotal ? previousUsage.inputTokens : estimateSessionTokens(session.messages.get()),
					totalSource: carryTotal ? previousUsage.totalSource : 'estimate',
					breakdown: {
						systemChars: event.systemChars,
						instructionsChars: event.instructionsChars,
						skillsChars: event.skillsChars,
						toolsChars: event.toolsChars,
						messagesChars: event.messagesChars,
						compactedChars: event.compactedChars,
						prunedChars: event.prunedChars,
					},
				});
			} else if (event?.type === 'work_digest') {
				// Captured now, persisted at finalize as a hidden role:'digest'
				// message — the last one wins on the next run's transcript.
				pendingDigest = event.text;
			} else if (event?.type === 'compaction') {
				// An ok compaction becomes the session's cross-run anchor: the same
				// head is summarized once per session instead of once per run. The
				// prefix measure must mirror the harness's measurePrefixChars — it is
				// the integrity gate that invalidates the anchor if history changes.
				if (
					event.outcome === 'ok' &&
					event.summary !== undefined &&
					typeof event.coveredInitial === 'number' &&
					event.coveredInitial >= 1 &&
					event.coveredInitial <= sentTranscript.length
				) {
					let prefixChars = 0;
					for (let i = 0; i < event.coveredInitial; i++) {
						prefixChars += JSON.stringify(sentTranscript[i]!.content).length;
					}
					pendingAnchor = { summary: event.summary, covered: event.coveredInitial, prefixChars };
				}
			} else if (event?.type === 'reply_verifier') {
				if (event.verdict === 'fail') {
					// The rejected reply is REPLACED by the retry, not appended to —
					// otherwise the off-target answer and its correction would render
					// as one concatenated blob.
					text = '';
					if (created) {
						created = false;
						session.messages.set(session.messages.get().filter(message => message.id !== assistantId));
						this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
					}
				}
			} else if (payload.done) {
				if (payload.done.reason === 'paused' && payload.done.paused) {
					pendingPause = payload.done.paused;
				}
				finalize(payload.done.reason);
			}
		});

		// A gate approval pauses the run: surface it on the session (the
		// conversation view renders Allow / Deny) and flag NeedsInput.
		const disposeApprovals = agent.onApprovalRequest(payload => {
			if (payload.sessionId !== sessionId) {
				return;
			}
			const approval: ISessionPendingApproval = {
				requestId: payload.requestId,
				toolName: payload.toolName,
				detail: payload.detail,
				...(payload.alwaysAllow ? { alwaysAllow: payload.alwaysAllow } : {}),
				...(payload.alwaysAllowProject ? { alwaysAllowProject: true } : {}),
				respond: (approved, always, scope) => {
					if (session.pendingApproval.get()?.requestId !== payload.requestId) {
						return;
					}
					session.pendingApproval.set(undefined);
					session.status.set(SessionStatus.InProgress);
					this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
					void agent.respondApproval(payload.requestId, approved, always, scope);
				},
			};
			session.pendingApproval.set(approval);
			session.status.set(SessionStatus.NeedsInput);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		});

		// Window unload folds this run into a persisted "[应用退出]" summary.
		const quitFlush = (): void => finalize('app_quit');
		this.inflightFinalizers.add(quitFlush);
		runCleanups.push(() => this.inflightFinalizers.delete(quitFlush));

		// Resume (#19 缺陷 2) sends the frozen transcript VERBATIM — rebuilding
		// from session messages would lose the unconsumed tool results that are
		// the whole point of the freeze.
		void (resumeTranscript !== undefined ? Promise.resolve([...resumeTranscript]) : this.buildTranscript(session))
			.then(transcript => {
				sentTranscript = transcript;
				return agent.run(sessionId, transcript, modelId, session.projectId, session.permissionMode.get(), collectSkillIds(session.messages.get()), session.compactionAnchor);
			})
			.catch(error => {
				// A partially-streamed reply keeps its text with the error appended —
				// silently keeping the truncated text used to hide quota failures
				// entirely when the model had already said anything (#19).
				const message = humanizeAgentRunError(error instanceof Error ? error.message : String(error));
				text = created && text.trim() !== '' ? `${text}\n\n${message}` : message;
				updateAssistant();
				finalize();
			});
	}

	/** When there is no model to answer, reply with an honest prompt to configure one. */
	private scheduleNoModelReply(session: IMutableSession): void {
		this.cancelPendingReply(session.sessionId);
		let resolve!: () => void;
		const promise = new Promise<void>(r => {
			resolve = r;
		});
		const timer = setTimeout(() => {
			this.pendingReplies.delete(session.sessionId);
			const now = new Date();
			const message: ISessionMessage = {
				id: `${session.sessionId}-assistant-${generateId()}`,
				role: 'assistant',
				text: 'No model is configured yet, so I can’t answer. Add a model in Settings › Models, then send your message again.',
				timestamp: now,
			};
			// Timer-driven writes cannot surface to a caller; log and keep the
			// in-memory session consistent so the UI never wedges.
			this.enqueueWrite(async () => {
				const ref = this.getRef(session.sessionId);
				await this.bridge.append(ref, { type: 'message', id: message.id, role: 'assistant', text: message.text, timestamp: now.toISOString() });
				await this.bridge.append(ref, { type: 'state', timestamp: now.toISOString(), status: SessionStatus.NeedsInput, isRead: false } satisfies ISessionStateEntry);
			}).catch(error => console.error(`Failed to persist assistant reply for ${session.sessionId}:`, error));
			session.messages.set([...session.messages.get(), message]);
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(now);
			session.isRead.set(false);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			resolve();
		}, this.responseDelayMs);
		this.pendingReplies.set(session.sessionId, { timer, promise, resolve });
	}

	private cancelPendingReply(sessionId: string): void {
		const pending = this.pendingReplies.get(sessionId);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timer);
		this.pendingReplies.delete(sessionId);
		pending.resolve();
	}
}

function toRef(snapshot: ISessionSnapshot): ISessionRef {
	return { sessionId: snapshot.sessionId, ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}) };
}

// Map the UI transcript to harness messages. Text-only for now; the 'tool'
// display role is dropped until client-side tools are wired.
const MAX_STEP_DETAIL_CHARS = 2000;

/** Tool output stored on the step for the expandable view; errors keep a marker. */
function truncateStepDetail(content: string, isError: boolean): string {
	const trimmed = content.length > MAX_STEP_DETAIL_CHARS ? `${content.slice(0, MAX_STEP_DETAIL_CHARS)}\n… (truncated)` : content;
	return isError ? `[error]\n${trimmed}` : trimmed;
}

/** query_data_source input → the step's browse payload; undefined for every other tool. */
function parseBrowsePayload(name: string, input: unknown): ISessionDataBrowse | undefined {
	if (name !== 'query_data_source' || typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	return typeof record['source'] === 'string' && typeof record['sql'] === 'string' && record['sql'].trim() !== '' ? { source: record['source'], sql: record['sql'] } : undefined;
}

/** The most telling argument of a tool call, first-line bounded — the structured `arg` fact on work steps (#14 Q3). */
/**
 * Turn a raw model-transport failure into copy a person can act on (#19). The
 * 2026-07-18 quota exhaustion surfaced verbatim as "Agent error: Anthropic
 * request failed: 403 {json}". Recognized statuses get a plain-language line
 * (the provider's own message rides along when the body parses); anything
 * unrecognized keeps the raw text — still the best evidence there is.
 */
export function humanizeAgentRunError(raw: string): string {
	// Main enriches a quota stop with the plan's real reset time when the
	// usage endpoint answered (agentIpc appends the marker; best-effort).
	const resetMatch = /\n\[quota-reset: ([^\]]+)\]/.exec(raw);
	const resetNote = formatQuotaResetNote(resetMatch?.[1]);
	const cleaned = resetMatch ? raw.replace(resetMatch[0], '') : raw;
	const match = /request failed: (\d{3})([\s\S]*)$/.exec(cleaned);
	if (!match) {
		return `Agent error: ${cleaned}`;
	}
	const status = Number(match[1]);
	let providerMessage: string | undefined;
	try {
		const body = JSON.parse(match[2]!.trim()) as { error?: { message?: unknown }; message?: unknown };
		const candidate = typeof body.error?.message === 'string' ? body.error.message : typeof body.message === 'string' ? body.message : undefined;
		providerMessage = candidate !== undefined && candidate.trim() !== '' ? (candidate.length > 200 ? `${candidate.slice(0, 200)}…` : candidate) : undefined;
	} catch {
		providerMessage = undefined;
	}
	const detail = providerMessage === undefined ? '' : `\n\n> ${providerMessage}`;
	if (status === 401) {
		return localize('run.err401', detail);
	}
	if (status === 403) {
		const recovery = resetNote ?? localize('run.err403Recovery');
		return localize('run.err403', recovery, detail);
	}
	if (status === 429) {
		return localize('run.err429', detail);
	}
	if (status >= 500) {
		return localize('run.err5xx', status, detail);
	}
	return `Agent error: ${cleaned}`;
}

/** `2026-07-23T02:55Z` → `额度将于 07-23 10:55 恢复（约 2 天 3 小时后）` — local time plus a rough countdown; undefined for garbage or past times (fall back to the vague copy rather than claim "恢复于 0 分钟前"). */
function formatQuotaResetNote(iso: string | undefined): string | undefined {
	if (!iso) {
		return undefined;
	}
	const reset = new Date(iso);
	const deltaMs = reset.getTime() - Date.now();
	if (Number.isNaN(reset.getTime()) || deltaMs <= 0) {
		return undefined;
	}
	const pad = (value: number): string => String(value).padStart(2, '0');
	const stamp = `${pad(reset.getMonth() + 1)}-${pad(reset.getDate())} ${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
	const totalMinutes = Math.round(deltaMs / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const countdown = days > 0 ? localize('run.countdownDayHour', days, hours) : hours > 0 ? localize('run.countdownHourMin', hours, minutes) : localize('run.countdownMin', minutes);
	return localize('run.quotaResetNote', stamp, countdown);
}

export function workToolArg(input: unknown): string | undefined {
	const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	const arg = [record['command'], record['path'], record['pattern'], record['task'], record['component'], record['sql'], record['source']].find(
		value => typeof value === 'string' && value !== ''
	);
	return typeof arg === 'string' ? firstLine(arg) : undefined;
}

/** Short human label for a tool step: the tool plus its most telling argument. Kept as the legacy-render fallback. */
function describeWorkTool(name: string, input: unknown): string {
	const arg = workToolArg(input);
	return arg !== undefined ? `${name} ${arg}` : name;
}

/** First line only, bounded — multi-line tasks/commands must not blow up a one-line step label. */
function firstLine(value: string): string {
	const line = value.split('\n', 1)[0] ?? '';
	return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

// --- 长答案分流 (#13, 原 #14 P2) ---------------------------------------------

/** Answers longer than this (chars) split on a clean completion: summary in the bubble, full text as a document artifact. */
export const DOCUMENT_SPLIT_THRESHOLD = 2000;
// The bubble keeps whole paragraphs from the top within this budget — a
// mid-sentence cut reads broken in a chat stream.
const DOCUMENT_SUMMARY_MAX_CHARS = 600;

/**
 * The split decision as a pure function: undefined below the threshold
 * (nothing to split); otherwise the summary is consecutive WHOLE paragraphs
 * from the first one, total ≤ {@link DOCUMENT_SUMMARY_MAX_CHARS}. A first
 * paragraph that alone blows the budget (one giant unbroken block) is
 * hard-cut with an ellipsis — an empty summary would be worse.
 */
export function splitLongAnswer(text: string): { readonly summary: string; readonly full: string } | undefined {
	if (text.length <= DOCUMENT_SPLIT_THRESHOLD) {
		return undefined;
	}
	let summary = '';
	for (const paragraph of text.split(/\n{2,}/)) {
		if (paragraph.trim() === '') {
			continue;
		}
		const candidate = summary === '' ? paragraph : `${summary}\n\n${paragraph}`;
		if (candidate.length > DOCUMENT_SUMMARY_MAX_CHARS) {
			break;
		}
		summary = candidate;
	}
	if (summary === '') {
		summary = `${text.slice(0, DOCUMENT_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
	}
	return { summary, full: text };
}

/** Drop malformed entries and duplicates; undefined when nothing survives, so callers can omit the field entirely. */
function normalizeAttachments(attachments: readonly ISessionAttachment[] | undefined): readonly ISessionAttachment[] | undefined {
	if (!attachments || attachments.length === 0) {
		return undefined;
	}
	const seen = new Set<string>();
	const normalized: ISessionAttachment[] = [];
	for (const attachment of attachments) {
		if (
			(attachment.kind !== 'file' && attachment.kind !== 'folder' && attachment.kind !== 'image' && attachment.kind !== 'skill' && attachment.kind !== 'session') ||
			typeof attachment.path !== 'string' ||
			attachment.path === ''
		) {
			continue;
		}
		const key = `${attachment.kind}:${attachment.path}`;
		if (!seen.has(key)) {
			seen.add(key);
			normalized.push({
				kind: attachment.kind,
				path: attachment.path,
				...(attachment.mediaType !== undefined ? { mediaType: attachment.mediaType } : {}),
				...(attachment.label !== undefined ? { label: attachment.label } : {}),
			});
		}
	}
	return normalized.length > 0 ? normalized : undefined;
}

/** The attachment hint that rides a user turn: point the agent at the mentioned paths without inlining their content. */
function formatAttachmentsBlock(attachments: readonly ISessionAttachment[]): string {
	const lines = attachments.map(attachment => (attachment.kind === 'folder' ? `${attachment.path}/ (folder)` : attachment.path));
	return `<user-attached-paths>\nThe user attached these workspace-relative paths. Read the relevant ones with your tools before answering.\n${lines.join('\n')}\n</user-attached-paths>`;
}

/**
 * Skill ids $-attached anywhere in the conversation, in first-mention order.
 * A skill is sticky: once attached it applies to every later run of the
 * session (its body rides the system prompt, which is rebuilt per run).
 */
export function collectSkillIds(messages: readonly ISessionMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		for (const attachment of message.attachments ?? []) {
			if (attachment.kind === 'skill' && !ids.includes(attachment.path)) {
				ids.push(attachment.path);
			}
		}
	}
	return ids;
}

// #-referenced sessions are compressed, not replayed: recent turns only, hard char cap.
const SESSION_CONTEXT_MAX_TURNS = 6;
const SESSION_CONTEXT_MAX_CHARS = 4000;
const SESSION_CONTEXT_TURN_CHARS = 1000;

/**
 * A referenced conversation rendered as a compact context block: the title
 * plus the last few user/assistant turns, each truncated, the whole block
 * capped. Poor-man's cross-session memory — enough to ground "like we did in
 * #that-session" without replaying its full transcript.
 */
export function formatSessionContext(title: string, messages: readonly ISessionMessage[]): string {
	const turns = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.text.trim() !== '').slice(-SESSION_CONTEXT_MAX_TURNS);
	const lines: string[] = [];
	let used = 0;
	for (const turn of turns) {
		const text = turn.text.length > SESSION_CONTEXT_TURN_CHARS ? `${turn.text.slice(0, SESSION_CONTEXT_TURN_CHARS)}…` : turn.text;
		const line = `${turn.role}: ${text}`;
		if (used + line.length > SESSION_CONTEXT_MAX_CHARS) {
			break;
		}
		used += line.length;
		lines.push(line);
	}
	return `<referenced-session title="${title.replace(/"/g, "'")}">\nThe user referenced another conversation. Its recent turns, for context:\n${lines.join('\n')}\n</referenced-session>`;
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
};

function mediaTypeFromPath(path: string): string {
	return MEDIA_TYPES_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png';
}

/**
 * Build the message list sent to the model from the session history. Only
 * user/assistant turns cross the wire (work/tool blocks are UI-only), and
 * empty-content turns are dropped — the model APIs reject a request that
 * contains an empty-content message ("assistant message must not be empty",
 * HTTP 400), which a stray blank reply would otherwise poison every later run
 * with. Path attachments become a hint block on the user turn (never inlined
 * content); image attachments become image blocks from `images` (path →
 * bytes), placed before the text per the Messages API convention.
 */
export function toTranscript(
	messages: readonly ISessionMessage[],
	images?: ReadonlyMap<string, { readonly mediaType: string; readonly data: string }>,
	sessionContexts?: ReadonlyMap<string, string>,
): IAgentMessage[] {
	const transcript: IAgentMessage[] = [];
	// Only the newest digest is carried — older runs' digests are stale and
	// letting them accumulate would defeat the point (bounded window occupancy).
	const latestDigest = [...messages].reverse().find(message => message.role === 'digest');
	for (const message of messages) {
		// The work digest (files the last run read/changed) crosses as an
		// assistant turn — same mechanism as plan below — so a follow-up run opens
		// knowing what was already explored instead of re-reading it. Only the
		// latest digest survives; earlier ones are skipped.
		if (message.role === 'digest') {
			if (message === latestDigest && message.text.trim() !== '') {
				transcript.push({ role: 'assistant', content: [{ type: 'text', text: message.text }] });
			}
			continue;
		}
		// A plan artifact must reach the model next run — revise ("adjust per my
		// comments") and approve ("execute the plan") both depend on the model
		// seeing its own proposal. The markdown fallback crosses as an assistant
		// turn; dropping it like work/tool would sever the review loop. A ui
		// card's confirm/revise loop depends on the same thing.
		if (message.role === 'plan' || message.role === 'ui') {
			if (message.text.trim() !== '') {
				transcript.push({ role: 'assistant', content: [{ type: 'text', text: message.text }] });
			}
			continue;
		}
		if (message.role !== 'user' && message.role !== 'assistant') {
			continue;
		}
		const attachments = message.role === 'user' ? (normalizeAttachments(message.attachments) ?? []) : [];
		// Skills ride the run's system prompt (see collectSkillIds), not the message.
		const pathAttachments = attachments.filter(attachment => attachment.kind === 'file' || attachment.kind === 'folder');
		const imageBlocks: IAgentMessage['content'][number][] = [];
		const contextBlocks: string[] = [];
		for (const attachment of attachments) {
			if (attachment.kind === 'image') {
				const image = images?.get(attachment.path);
				if (image) {
					imageBlocks.push({ type: 'image', mediaType: image.mediaType, data: image.data });
				}
			} else if (attachment.kind === 'session') {
				// A deleted or unresolvable referenced session degrades silently.
				const context = sessionContexts?.get(attachment.path);
				if (context) {
					contextBlocks.push(context);
				}
			}
		}
		let text = pathAttachments.length > 0 ? `${message.text}\n\n${formatAttachmentsBlock(pathAttachments)}` : message.text;
		if (contextBlocks.length > 0) {
			text = `${text}\n\n${contextBlocks.join('\n\n')}`;
		}
		if (text.trim() === '' && imageBlocks.length === 0) {
			continue;
		}
		transcript.push({ role: message.role, content: [...imageBlocks, ...(text.trim() !== '' ? [{ type: 'text' as const, text }] : [])] });
	}

	return transcript;
}

function coerceStatus(status: number): SessionStatus {
	if (status === SessionStatus.InProgress) {
		return SessionStatus.NeedsInput;
	}

	return status >= SessionStatus.Untitled && status <= SessionStatus.Error ? (status as SessionStatus) : SessionStatus.NeedsInput;
}

function coerceInteractivity(interactivity: ISessionSnapshot['interactivity']): SessionInteractivity {
	switch (interactivity) {
		case 'read-only':
			return SessionInteractivity.ReadOnly;
		case 'hidden':
			return SessionInteractivity.Hidden;
		default:
			return SessionInteractivity.Full;
	}
}

/**
 * A collision-safe id — unlike a per-instance counter, this can't clash with
 * an id already persisted from a prior app run (a counter resets to 0 on
 * every restart while its old, disk-persisted ids live on; a fresh message
 * that happens to land on a reused number silently overwrites the old one).
 */
function generateId(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerFileSessionsProvider(
	providersService: ISessionsProvidersService,
	bridge: ISessionsBridge,
	options: IFileSessionsProviderOptions = {},
	agent?: IAgentBridge,
	modelsService?: IModelsService,
): FileSessionsProvider {
	const provider = new FileSessionsProvider(bridge, options, agent, modelsService);
	providersService.registerProvider(provider);
	return provider;
}
