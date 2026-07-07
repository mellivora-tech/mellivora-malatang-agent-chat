/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { observableValue, type ObservableValue } from '../../../base/common/observable.js';
import type { IAgentBridge, IAgentMessage } from '../../../services/agent/common/agent.js';
import type { IModelsService } from '../../../services/models/browser/modelsService.js';
import type { ISession, ISessionChangesSummary, ISessionMessage, ISessionWorkspace } from '../../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../../services/sessions/common/session.js';
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
const STARTED_CHANGES_SUMMARY: ISessionChangesSummary = { files: 5, additions: 3431, deletions: 815 };

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
	};
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
	private sequence = 0;

	constructor(
		private readonly bridge: ISessionsBridge,
		options: IFileSessionsProviderOptions = {},
		private readonly agent?: IAgentBridge,
		private readonly modelsService?: IModelsService,
	) {
		this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
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
		const sessionId = generateSessionId();
		const ref: ISessionRef = { sessionId, ...(options?.projectId ? { projectId: options.projectId } : {}) };
		const now = new Date();
		this.sequence += 1;
		const userMessage: ISessionMessage = { id: `${sessionId}-user-${this.sequence}`, role: 'user', text: query };

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
				changesSummary: STARTED_CHANGES_SUMMARY,
				isRead: false,
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
			changesSummary: STARTED_CHANGES_SUMMARY,
			isRead: false,
		});

		this.sessions.unshift(session);
		this.refs.set(sessionId, ref);
		this.onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		this.generateReply(session, query);
		return session;
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		const ref = this.getRef(sessionId);
		const now = new Date();
		this.sequence += 1;
		const message: ISessionMessage = { id: `${sessionId}-user-${this.sequence}`, role: 'user', text: query };

		await this.enqueueWrite(async () => {
			await this.bridge.append(ref, { type: 'message', id: message.id, role: 'user', text: query, timestamp: now.toISOString() });
			await this.bridge.append(ref, { type: 'state', timestamp: now.toISOString(), status: SessionStatus.InProgress, isRead: false });
		});

		session.messages.set([...session.messages.get(), message]);
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(now);
		session.isRead.set(false);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.generateReply(session, query);
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
			messages: snapshot.messages.map(message => ({ id: message.id, role: message.role, text: message.text, ...(message.detail !== undefined ? { detail: message.detail } : {}) })),
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

	private generateReply(session: IMutableSession, query: string): void {
		if (this.agent && (this.modelsService?.registry.get().models.length ?? 0) > 0) {
			void this.runAgentReply(session);
			return;
		}

		this.scheduleMockReply(session, query);
	}

	private runAgentReply(session: IMutableSession): void {
		const agent = this.agent;
		if (!agent) {
			return;
		}

		const sessionId = session.sessionId;
		const modelId = this.modelsService?.registry.get().defaultModelId;
		this.sequence += 1;
		const assistantId = `${sessionId}-assistant-${this.sequence}`;
		const transcript = toTranscript(session.messages.get());
		let text = '';
		let created = false;
		let finalized = false;

		const updateAssistant = (): void => {
			const messages = session.messages.get();
			if (!created) {
				created = true;
				session.messages.set([...messages, { id: assistantId, role: 'assistant', text }]);
			} else {
				session.messages.set(messages.map(message => (message.id === assistantId ? { ...message, text } : message)));
			}
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		};

		const finalize = (): void => {
			if (finalized) {
				return;
			}
			finalized = true;
			dispose();
			if (!created) {
				updateAssistant();
			}

			const now = new Date();
			this.enqueueWrite(async () => {
				const ref = this.getRef(sessionId);
				await this.bridge.append(ref, { type: 'message', id: assistantId, role: 'assistant', text, timestamp: now.toISOString() });
				await this.bridge.append(ref, { type: 'state', timestamp: now.toISOString(), status: SessionStatus.NeedsInput, isRead: false });
			}).catch(persistError => console.error(`Failed to persist assistant reply for ${sessionId}:`, persistError));

			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(now);
			session.isRead.set(false);
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		};

		const dispose = agent.onEvent(payload => {
			if (payload.sessionId !== sessionId) {
				return;
			}
			if (payload.event?.type === 'assistant_delta') {
				text += payload.event.text;
				updateAssistant();
			} else if (payload.done) {
				finalize();
			}
		});

		void agent.run(sessionId, transcript, modelId).catch(error => {
			text = created ? text : `Agent error: ${error instanceof Error ? error.message : String(error)}`;
			updateAssistant();
			finalize();
		});
	}

	private scheduleMockReply(session: IMutableSession, query: string): void {
		this.cancelPendingReply(session.sessionId);
		let resolve!: () => void;
		const promise = new Promise<void>(r => {
			resolve = r;
		});
		const timer = setTimeout(() => {
			this.pendingReplies.delete(session.sessionId);
			this.sequence += 1;
			const now = new Date();
			const message: ISessionMessage = { id: `${session.sessionId}-assistant-${this.sequence}`, role: 'assistant', text: `Mock response for: ${query}` };
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
function toTranscript(messages: readonly ISessionMessage[]): IAgentMessage[] {
	const transcript: IAgentMessage[] = [];
	for (const message of messages) {
		if (message.role === 'user') {
			transcript.push({ role: 'user', content: [{ type: 'text', text: message.text }] });
		} else if (message.role === 'assistant') {
			transcript.push({ role: 'assistant', content: [{ type: 'text', text: message.text }] });
		}
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

function generateSessionId(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
