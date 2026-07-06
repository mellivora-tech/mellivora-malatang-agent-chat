/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { observableValue, type ObservableValue } from '../../../base/common/observable.js';
import type { ISession, ISessionChangesSummary, ISessionMessage, ISessionWorkspace } from '../../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../../services/sessions/common/session.js';
import type { ISessionChangeEvent, ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import type { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

export interface IMockSessionsProviderOptions {
	readonly responseDelayMs?: number;
}

interface IPendingReply {
	readonly timer: ReturnType<typeof setTimeout>;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

const DEFAULT_RESPONSE_DELAY_MS = 3000;

function minutesAgo(minutes: number): Date {
	return new Date(Date.now() - minutes * 60_000);
}

interface IMutableSession extends ISession {
	readonly workspace: ObservableValue<ISessionWorkspace | undefined>;
	readonly title: ObservableValue<string>;
	readonly updatedAt: ObservableValue<Date>;
	readonly status: ObservableValue<SessionStatus>;
	readonly description: ObservableValue<string | undefined>;
	readonly changesSummary: ObservableValue<ISessionChangesSummary | undefined>;
	readonly isArchived: ObservableValue<boolean>;
	readonly isRead: ObservableValue<boolean>;
	readonly messages: ObservableValue<readonly ISessionMessage[]>;
	readonly interactivity: ObservableValue<SessionInteractivity>;
}

function createSession(options: {
	sessionId: string;
	timestamp: Date;
	icon: string;
	status: SessionStatus;
	title: string;
	description?: string;
	workspace: ISessionWorkspace;
	messages: readonly ISessionMessage[];
	interactivity: SessionInteractivity;
	changesSummary?: ISessionChangesSummary;
	isArchived?: boolean;
	isRead?: boolean;
}): IMutableSession {
	return {
		sessionId: options.sessionId,
		providerId: 'mock-sessions',
		sessionType: 'mock-agent',
		icon: options.icon,
		createdAt: options.timestamp,
		workspace: observableValue<ISessionWorkspace | undefined>(options.workspace),
		title: observableValue(options.title),
		updatedAt: observableValue(options.timestamp),
		status: observableValue(options.status),
		description: observableValue(options.description),
		changesSummary: observableValue(options.changesSummary),
		isArchived: observableValue(options.isArchived ?? false),
		isRead: observableValue(options.isRead ?? true),
		messages: observableValue(options.messages),
		interactivity: observableValue(options.interactivity)
	};
}

export class MockSessionsProvider implements ISessionsProvider {
	readonly id = 'mock-sessions';
	readonly label = 'Mock Sessions';
	readonly icon = 'codicon-copilot';
	readonly order = 0;

	private readonly onDidChangeSessionsEmitter = new Emitter<ISessionChangeEvent>();
	private readonly sessions: IMutableSession[] = [
		createSession({
			sessionId: 'session-in-progress',
			timestamp: minutesAgo(2),
			icon: 'codicon-copilot',
			status: SessionStatus.InProgress,
			title: 'Refine onboarding flow',
			description: 'Agent is iterating on the desktop shell mock.',
			workspace: {
				label: 'mellivora-malatang-agent-chat',
				description: '~/workspace/code/learning-projects',
				branchName: 'codex/agents-window-rebuild'
			},
			messages: [
				{ id: 'main-user-1', role: 'user', text: 'Rebuild the agents window shell.' },
				{ id: 'main-assistant-1', role: 'assistant', text: 'I have the layout in place and I am wiring the mock session domain now.' },
				{ id: 'main-tool-1', role: 'tool', text: 'typecheck', detail: 'Workbench services, mock provider, and conversation UI are wired.' }
			],
			interactivity: SessionInteractivity.Full,
			changesSummary: {
				files: 5,
				additions: 218,
				deletions: 46
			}
		}),
		createSession({
			sessionId: 'session-completed',
			timestamp: minutesAgo(120),
			icon: 'codicon-diff-multiple',
			status: SessionStatus.Completed,
			title: 'Ship settings sidebar cleanup',
			description: 'Completed with a tidy diff and passing checks.',
			workspace: {
				label: 'desktop-settings',
				description: '~/workspace/code/internal',
				branchName: 'codex/settings-cleanup'
			},
			messages: [
				{ id: 'completed-user-1', role: 'user', text: 'Wrap up the settings cleanup.' },
				{ id: 'completed-assistant-1', role: 'assistant', text: 'Done. The final state is stable and the diff is ready.' },
				{ id: 'completed-tool-1', role: 'tool', text: 'npm test', detail: 'All tests passed.' }
			],
			interactivity: SessionInteractivity.ReadOnly,
			changesSummary: {
				files: 8,
				additions: 142,
				deletions: 37
			}
		}),
		createSession({
			sessionId: 'session-needs-input',
			timestamp: minutesAgo(45),
			icon: 'codicon-folder',
			status: SessionStatus.NeedsInput,
			title: 'Pick workspace target',
			description: 'Waiting on a workspace selection before continuing.',
			workspace: {
				label: 'new-monorepo',
				description: '~/workspace/sandboxes',
				branchName: 'codex/workspace-picker'
			},
			messages: [
				{ id: 'input-user-1', role: 'user', text: 'Continue once the repo target is clear.' },
				{ id: 'input-assistant-1', role: 'assistant', text: 'I can keep going as soon as you choose which workspace to attach.' },
				{ id: 'input-tool-1', role: 'tool', text: 'workspace scan', detail: 'Found three matching folders.' }
			],
			interactivity: SessionInteractivity.Full
		}),
		createSession({
			sessionId: 'session-archived',
			timestamp: minutesAgo(3 * 24 * 60),
			icon: 'codicon-git-branch',
			status: SessionStatus.Completed,
			title: 'Archive PR notes',
			description: 'Kept for reference after merge.',
			workspace: {
				label: 'release-train',
				description: '~/workspace/code/releases',
				branchName: 'release/july'
			},
			messages: [
				{ id: 'archived-user-1', role: 'user', text: 'Preserve the rollout notes.' },
				{ id: 'archived-assistant-1', role: 'assistant', text: 'Archived with the merge summary and follow-up links.' },
				{ id: 'archived-tool-1', role: 'tool', text: 'git merge', detail: 'Merged into main.' }
			],
			interactivity: SessionInteractivity.ReadOnly,
			isArchived: true
		})
	];

	private readonly responseDelayMs: number;
	private sequence = 0;
	private readonly pendingReplies = new Map<string, IPendingReply>();

	constructor(options: IMockSessionsProviderOptions = {}) {
		this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
	}

	readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

	getSessions(): readonly ISession[] {
		return this.sessions;
	}

	async startSession(query: string): Promise<ISession> {
		const timestamp = new Date();
		const idBase = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
		this.sequence += 1;
		const session = createSession({
			sessionId: `session-started-${idBase}-${this.sequence}`,
			timestamp,
			icon: 'codicon-new-session',
			status: SessionStatus.InProgress,
			title: query,
			description: 'Agent is working on the first prompt.',
			workspace: {
				label: 'mellivora-malatang',
				description: '~/workspace/code/learning-projects',
				branchName: 'codex/agents-window-rebuild'
			},
			messages: [{ id: `started-user-${this.sequence}`, role: 'user', text: query }],
			interactivity: SessionInteractivity.Full,
			changesSummary: {
				files: 5,
				additions: 3431,
				deletions: 815
			},
			isRead: false
		});

		this.sessions.unshift(session);
		this.onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		this.scheduleAssistantReply(session, query);
		return session;
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		this.sequence += 1;
		session.messages.set([
			...session.messages.get(),
			{ id: `${sessionId}-user-${this.sequence}`, role: 'user', text: query }
		]);
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(new Date());
		session.isRead.set(false);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		this.scheduleAssistantReply(session, query);
		return session;
	}

	async stopSession(sessionId: string): Promise<ISession> {
		const session = this.getMutableSession(sessionId);
		this.cancelPendingReply(sessionId);
		if (session.status.get() === SessionStatus.InProgress) {
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(new Date());
			this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
		}

		return session;
	}

	async whenIdle(): Promise<void> {
		while (this.pendingReplies.size > 0) {
			await Promise.all([...this.pendingReplies.values()].map(pending => pending.promise));
		}
	}

	private getMutableSession(sessionId: string): IMutableSession {
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		return session;
	}

	private scheduleAssistantReply(session: IMutableSession, query: string): void {
		this.cancelPendingReply(session.sessionId);
		let resolve!: () => void;
		const promise = new Promise<void>(r => {
			resolve = r;
		});
		const timer = setTimeout(() => {
			this.pendingReplies.delete(session.sessionId);
			this.sequence += 1;
			session.messages.set([
				...session.messages.get(),
				{ id: `${session.sessionId}-assistant-${this.sequence}`, role: 'assistant', text: `Mock response for: ${query}` }
			]);
			session.status.set(SessionStatus.NeedsInput);
			session.updatedAt.set(new Date());
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

export function registerMockSessionsProvider(
	providersService: ISessionsProvidersService,
	options: IMockSessionsProviderOptions = {}
): MockSessionsProvider {
	const provider = new MockSessionsProvider(options);
	providersService.registerProvider(provider);
	return provider;
}
