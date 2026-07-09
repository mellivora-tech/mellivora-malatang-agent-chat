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
	ISession,
	ISessionChangesSummary,
	ISessionContextUsage,
	ISessionMessage,
	ISessionPendingApproval,
	ISessionReconnect,
	ISessionWorkStep,
	ISessionWorkspace,
} from '../../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../../services/sessions/common/session.js';
import { permissionMode } from '../../../services/agent/browser/permissionModeService.js';
import type { ISessionsBridge, ISessionRef, ISessionSnapshot, ISessionStateEntry } from '../../../services/sessions/common/sessionsBridge.js';
import type { ISessionChangeEvent, ISessionsProvider, IStartSessionOptions } from '../../../services/sessions/common/sessionsProvider.js';
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
	readonly interactivity: ObservableValue<SessionInteractivity>;
	readonly pendingApproval: ObservableValue<ISessionPendingApproval | undefined>;
	readonly reconnect: ObservableValue<ISessionReconnect | undefined>;
	readonly permissionMode: ObservableValue<PermissionMode>;
	readonly contextUsage: ObservableValue<ISessionContextUsage | undefined>;
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
		interactivity: observableValue(options.interactivity),
		pendingApproval: observableValue<ISessionPendingApproval | undefined>(undefined),
		reconnect: observableValue<ISessionReconnect | undefined>(undefined),
		permissionMode: observableValue<PermissionMode>(options.permissionMode ?? 'ask'),
		contextUsage: observableValue<ISessionContextUsage | undefined>(undefined),
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
	private readonly responseDelayMs: number;
	private writeQueue: Promise<void> = Promise.resolve();
	private initialized = false;

	constructor(
		private readonly bridge: ISessionsBridge,
		options: IFileSessionsProviderOptions = {},
		private readonly agent?: IAgentBridge,
		private readonly modelsService?: IModelsService,
	) {
		this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
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
		const userMessage: ISessionMessage = { id: `${sessionId}-user-${generateId()}`, role: 'user', text: query, timestamp: now };

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
			await this.bridge.append(ref, { type: 'message', id: userMessage.id, role: 'user', text: query, timestamp: now.toISOString() });
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
		return session;
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		const ref = this.getRef(sessionId);
		const now = new Date();
		const message: ISessionMessage = { id: `${sessionId}-user-${generateId()}`, role: 'user', text: query, timestamp: now };

		await this.enqueueWrite(async () => {
			await this.bridge.append(ref, { type: 'message', id: message.id, role: 'user', text: query, timestamp: now.toISOString() });
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
					...(message.detail !== undefined ? { detail: message.detail } : {}),
					...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
					...(message.steps !== undefined ? { steps: message.steps } : {}),
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
				...(message.detail !== undefined ? { detail: message.detail } : {}),
				...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
				...(message.steps !== undefined ? { steps: message.steps } : {}),
				...(message.feedback !== undefined ? { feedback: message.feedback } : {}),
				...(message.timestamp !== undefined ? { timestamp: new Date(message.timestamp) } : {}),
			})),
			interactivity: coerceInteractivity(snapshot.interactivity),
			isArchived: snapshot.isArchived,
			isRead: snapshot.isRead,
			isPinned: snapshot.isPinned,
			...(snapshot.projectId !== undefined ? { projectId: snapshot.projectId } : {}),
			...(snapshot.description !== undefined ? { description: snapshot.description } : {}),
			...(snapshot.workspace !== undefined ? { workspace: snapshot.workspace } : {}),
			...(snapshot.changesSummary !== undefined ? { changesSummary: snapshot.changesSummary } : {}),
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
		const transcript = toTranscript(session.messages.get());
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
		// Reasoning text streamed since the last step boundary; becomes the
		// closing thinking step's expandable detail.
		let thinkingBuffer = '';

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

		const updateWork = (durationMs?: number): void => {
			const workMessage: ISessionMessage = { id: workId, role: 'work', text: '', steps: [...steps], ...(durationMs === undefined ? {} : { durationMs }) };
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

		const finalize = (reason?: string): void => {
			if (finalized) {
				return;
			}
			finalized = true;
			dispose();
			disposeApprovals();
			session.pendingApproval.set(undefined);
			session.reconnect.set(undefined);
			if (openToolLabel !== undefined) {
				closeStep('tool', openToolLabel);
				openToolLabel = undefined;
			} else {
				closeStep('thinking', 'Thought');
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
					text = 'Stopped.';
				}
			}
			const hasReply = text !== '';
			if (hasReply) {
				updateAssistant();
			}

			const now = new Date();
			this.enqueueWrite(async () => {
				const ref = this.getRef(sessionId);
				await this.bridge.append(ref, { type: 'message', id: workId, role: 'work', text: '', durationMs: workDuration, steps, timestamp: now.toISOString() });
				if (hasReply) {
					await this.bridge.append(ref, { type: 'message', id: assistantId, role: 'assistant', text, timestamp: now.toISOString() });
				}
				await this.bridge.append(ref, { type: 'state', timestamp: now.toISOString(), status: SessionStatus.NeedsInput, isRead: false });
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
			if (event?.type === 'assistant_delta') {
				// First text after thinking closes the stretch; text after a tool
				// result belongs to the next thinking stretch, so only close once.
				if (text === '' && openToolLabel === undefined) {
					closeStep('thinking', 'Thought');
					updateWork();
				}
				text += event.text;
				updateAssistant();
			} else if (event?.type === 'tool_use') {
				closeStep('thinking', 'Thought');
				openToolLabel = describeWorkTool(event.name, event.input);
				updateWork();
			} else if (event?.type === 'tool_result') {
				if (openToolLabel !== undefined) {
					closeStep('tool', openToolLabel, truncateStepDetail(event.content, event.isError));
					openToolLabel = undefined;
					updateWork();
				}
			} else if (event?.type === 'usage') {
				// The provider's real prompt size for the request just completed —
				// the conversation view prefers this over its char-count estimate.
				session.contextUsage.set({ inputTokens: event.inputTokens });
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
				respond: approved => {
					if (session.pendingApproval.get()?.requestId !== payload.requestId) {
						return;
					}
					session.pendingApproval.set(undefined);
					session.status.set(SessionStatus.InProgress);
					this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
					void agent.respondApproval(payload.requestId, approved);
				},
			};
			session.pendingApproval.set(approval);
			session.status.set(SessionStatus.NeedsInput);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		});

		void agent.run(sessionId, transcript, modelId, session.projectId, session.permissionMode.get()).catch(error => {
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
	const arg = [record['command'], record['path'], record['pattern']].find(value => typeof value === 'string' && value !== '');
	return typeof arg === 'string' ? `${name} ${arg}` : name;
}

/**
 * Build the message list sent to the model from the session history. Only
 * user/assistant turns cross the wire (work/tool blocks are UI-only), and
 * empty-text turns are dropped — the model APIs reject a request that contains
 * an empty-content message ("assistant message must not be empty", HTTP 400),
 * which a stray blank reply would otherwise poison every later run with.
 */
export function toTranscript(messages: readonly ISessionMessage[]): IAgentMessage[] {
	const transcript: IAgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== 'user' && message.role !== 'assistant') {
			continue;
		}
		if (message.text.trim() === '') {
			continue;
		}
		transcript.push({ role: message.role, content: [{ type: 'text', text: message.text }] });
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
