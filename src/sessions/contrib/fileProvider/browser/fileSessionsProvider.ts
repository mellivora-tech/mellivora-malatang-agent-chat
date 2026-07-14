/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { observableValue, type ObservableValue } from '../../../base/common/observable.js';
import type { IAgentBridge, IAgentMessage, PermissionMode } from '../../../services/agent/common/agent.js';
import type { IGitBridge } from '../../../services/git/common/git.js';
import type { IModelsService } from '../../../services/models/browser/modelsService.js';
import type {
	IPlanComment,
	ISession,
	ISessionAttachment,
	ISessionChangesSummary,
	ISessionContextUsage,
	ISessionMessage,
	ISessionPendingApproval,
	ISessionReconnect,
	ISessionWorkStep,
	ISessionWorkspace,
} from '../../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus, estimateSessionTokens } from '../../../services/sessions/common/session.js';
import { materializePlan, nextPlanVersion, parsePlanInput, planToMarkdown, type IProposePlanInput } from '../../../services/sessions/common/planArtifact.js';
import { permissionMode } from '../../../services/agent/browser/permissionModeService.js';
import type { ISessionCompactionAnchorData, ISessionsBridge, ISessionRef, ISessionSnapshot, ISessionStateEntry } from '../../../services/sessions/common/sessionsBridge.js';
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

type GitGlobals = typeof globalThis & { readonly agentWindow?: { readonly git?: IGitBridge } };

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
	/** Cross-run compaction anchor — internal harness state, never rendered, hence no observable. */
	compactionAnchor?: ISessionCompactionAnchorData;
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
		...(options.compactionAnchor ? { compactionAnchor: options.compactionAnchor } : {}),
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

	private readonly git: IGitBridge | undefined = (globalThis as GitGlobals).agentWindow?.git;

	/** Pull the project's real working-tree diff onto the session and persist it. */
	private async refreshChangesSummary(session: IMutableSession): Promise<void> {
		if (!this.git || !session.projectId) {
			return;
		}
		const summary = await this.git.diffStat(session.projectId);
		session.changesSummary.set(summary);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		await this.enqueueWrite(async () => {
			await this.bridge.append(this.getRef(session.sessionId), { type: 'state', timestamp: new Date().toISOString(), ...(summary ? { changesSummary: summary } : {}) });
		});
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
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.generateReply(session);
		return session;
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
					...(message.steps !== undefined ? { steps: message.steps } : {}),
					...(message.plan !== undefined ? { plan: message.plan } : {}),
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
				...(message.steps !== undefined ? { steps: message.steps } : {}),
				...(message.plan !== undefined ? { plan: message.plan } : {}),
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

	private runAgentReply(session: IMutableSession): void {
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

		// The work block tracks how the run spends its time: thinking stretches
		// between events, and one step per tool call. Timestamps are taken on the
		// renderer side as events arrive.
		const workStart = Date.now();
		const steps: ISessionWorkStep[] = [];
		let stepStart = workStart;
		let openToolLabel: string | undefined;
		// The run's latest propose_plan / write_walkthrough inputs — last call of
		// each wins; materialized into role:'plan' messages at finalize
		// (ids/version assigned there, never by the model).
		let pendingPlanInput: IProposePlanInput | undefined;
		let pendingWalkthroughInput: IProposePlanInput | undefined;
		// The run's work digest (files read/changed), emitted once at run end;
		// materialized into a hidden role:'digest' message at finalize and carried
		// on the next run's transcript to pay down the re-exploration tax.
		let pendingDigest: string | undefined;
		// Reasoning text streamed since the last step boundary; becomes the
		// closing thinking step's expandable detail.
		let thinkingBuffer = '';
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
		// Sub-agent narration state: the spawn step's own label (restored when the
		// child ends) and the child's currently-running action.
		let subagentSpawnLabel: string | undefined;
		let subagentAction: string | undefined;

		const closeStep = (kind: ISessionWorkStep['kind'], label: string, detail?: string): void => {
			const durationMs = Date.now() - stepStart;
			const stepDetail = kind === 'thinking' ? (thinkingBuffer.trim() === '' ? undefined : truncateStepDetail(thinkingBuffer, false)) : detail;
			if (kind === 'thinking') {
				thinkingBuffer = '';
			}
			// Sub-second thinking stretches without content are noise, not steps.
			if (kind !== 'thinking' || durationMs >= 1000 || stepDetail !== undefined) {
				steps.push({ kind, label, durationMs, ...(stepDetail === undefined ? {} : { detail: stepDetail }) });
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

		const updateWork = (durationMs?: number): void => {
			// The RUNNING call rides the live view as a synthetic open step — steps
			// only holds closed ones, which left long tool calls (a 5-minute SFTP
			// upload, a sub-agent) invisible until they finished. tool_progress
			// events refresh openToolLabel, so this row is where progress renders.
			const liveSteps: ISessionWorkStep[] =
				openToolLabel !== undefined ? [...steps, { kind: 'tool', label: openToolLabel, durationMs: Date.now() - stepStart, running: true }] : [...steps];
			const workMessage: ISessionMessage = { id: workId, role: 'work', text: '', steps: liveSteps, ...(durationMs === undefined ? {} : { durationMs }) };
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
		// window unload) — currently just the quit-flush registration.
		const runCleanups: (() => void)[] = [];

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
				parts.push(`中止前的最后判断：${thought.length > 300 ? `${thought.slice(0, 300)}…` : thought}`);
			}
			if (lastTool) {
				parts.push(`中止时正在执行：${lastTool.label}`);
			}
			return parts.length === 0 ? `[本次运行被${cause}，任务未完成]` : `[本次运行被${cause}，任务未完成，以下状态未经最终验证]\n${parts.join('\n')}`;
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
			if (openToolLabel !== undefined) {
				closeStep('tool', openToolLabel);
				openToolLabel = undefined;
			} else {
				closeThinkingOrSkip();
			}
			const workDuration = Date.now() - workStart;
			updateWork(workDuration);

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
					text = abortSummary('用户中止');
				} else if (reason === 'app_quit') {
					text = abortSummary('应用退出');
				}
			}
			const hasReply = text !== '';
			if (hasReply) {
				updateAssistant();
			}

			if (pendingAnchor) {
				session.compactionAnchor = pendingAnchor;
			}
			const anchorToPersist = pendingAnchor;
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
			const artifactMessages = [planMessage, walkthroughMessage].filter((message): message is ISessionMessage => message !== undefined);
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
			if (reason === 'aborted' || reason === 'app_quit') {
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
				await this.bridge.append(ref, { type: 'message', id: workId, role: 'work', text: '', durationMs: workDuration, steps, timestamp: now.toISOString() });
				for (const supersededId of supersededIds) {
					await this.bridge.append(ref, { type: 'planState', messageId: supersededId, planState: 'superseded', timestamp: now.toISOString() });
				}
				for (const artifactMessage of artifactMessages) {
					if (artifactMessage.plan) {
						await this.bridge.append(ref, {
							type: 'message',
							id: artifactMessage.id,
							role: 'plan',
							text: artifactMessage.text,
							plan: artifactMessage.plan,
							timestamp: now.toISOString(),
						});
					}
				}
				if (hasReply) {
					await this.bridge.append(ref, { type: 'message', id: assistantId, role: 'assistant', text, timestamp: now.toISOString() });
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
				});
			}).catch(persistError => console.error(`Failed to persist assistant reply for ${sessionId}:`, persistError));

			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(now);
			session.isRead.set(false);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
			// The run may have edited files — reflect the real diff now.
			void this.refreshChangesSummary(session);
		};

		const dispose = agent.onEvent(payload => {
			if (payload.sessionId !== sessionId) {
				return;
			}
			const event = payload.event;
			if (event?.type === 'stream_retry') {
				// The attempt restarts from scratch — drop its partial reasoning.
				thinkingBuffer = '';
				session.reconnect.set({ attempt: event.attempt, maxAttempts: event.maxAttempts });
				return;
			}
			if (event?.type === 'thinking_delta') {
				thinkingBuffer += event.text;
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
				if (text === '' && openToolLabel === undefined) {
					closeStep('thinking', 'Thought');
					updateWork();
				}
				turnText += event.text;
				text += event.text;
				updateAssistant();
			} else if (event?.type === 'tool_use') {
				closeThinkingOrSkip();
				relocateTurnNarration();
				if (event.name === 'propose_plan') {
					// Malformed input stays on the previous capture — the tool result
					// already told the model what was wrong.
					pendingPlanInput = parsePlanInput(event.input) ?? pendingPlanInput;
				} else if (event.name === 'write_walkthrough') {
					pendingWalkthroughInput = parsePlanInput(event.input) ?? pendingWalkthroughInput;
				}
				openToolLabel = describeWorkTool(event.name, event.input);
				updateWork();
			} else if (event?.type === 'tool_result') {
				if (openToolLabel !== undefined) {
					closeStep('tool', openToolLabel, truncateStepDetail(event.content, event.isError));
					openToolLabel = undefined;
					updateWork();
				}
			} else if (event?.type === 'tool_progress') {
				// Live label for the running call (e.g. "上传 … 47% · 4.1 MB/s").
				// The eventual tool_result closes the step as usual, so the final
				// label is the last progress line — which reads as the summary.
				openToolLabel = event.note;
				updateWork();
			} else if (event?.type === 'subagent_start') {
				// A child loop is running inside the open spawn_agent call. Its
				// narration takes over the open-step slot until subagent_end; the
				// spawn label is restored then, so the spawn's own tool_result still
				// closes a matching step.
				subagentSpawnLabel = openToolLabel;
				closeStep('tool', `子代理 ⑃ ${firstLine(event.task)}`);
				openToolLabel = '子代理启动中…';
				updateWork();
			} else if (event?.type === 'subagent_tool') {
				if (subagentAction !== undefined) {
					closeStep('tool', subagentAction);
				}
				subagentAction = `⑃ ${event.summary}`;
				openToolLabel = subagentAction;
				updateWork();
			} else if (event?.type === 'subagent_end') {
				if (subagentAction !== undefined) {
					closeStep('tool', subagentAction);
					subagentAction = undefined;
				}
				closeStep('tool', `子代理结束 · ${event.reason}`, `${event.turns} turns · ${event.toolCalls} tool calls · ${Math.round(event.tokens / 1000)}k tokens`);
				openToolLabel = subagentSpawnLabel ?? openToolLabel;
				subagentSpawnLabel = undefined;
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
				respond: (approved, always) => {
					if (session.pendingApproval.get()?.requestId !== payload.requestId) {
						return;
					}
					session.pendingApproval.set(undefined);
					session.status.set(SessionStatus.InProgress);
					this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
					void agent.respondApproval(payload.requestId, approved, always);
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

		void this.buildTranscript(session)
			.then(transcript => {
				sentTranscript = transcript;
				return agent.run(sessionId, transcript, modelId, session.projectId, session.permissionMode.get(), collectSkillIds(session.messages.get()), session.compactionAnchor);
			})
			.catch(error => {
				text = created ? text : `Agent error: ${error instanceof Error ? error.message : String(error)}`;
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

/** Short human label for a tool step: the tool plus its most telling argument. */
function describeWorkTool(name: string, input: unknown): string {
	const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	const arg = [record['command'], record['path'], record['pattern'], record['task']].find(value => typeof value === 'string' && value !== '');
	return typeof arg === 'string' ? `${name} ${firstLine(arg)}` : name;
}

/** First line only, bounded — multi-line tasks/commands must not blow up a one-line step label. */
function firstLine(value: string): string {
	const line = value.split('\n', 1)[0] ?? '';
	return line.length > 72 ? `${line.slice(0, 72)}…` : line;
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
		// turn; dropping it like work/tool would sever the review loop.
		if (message.role === 'plan') {
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
