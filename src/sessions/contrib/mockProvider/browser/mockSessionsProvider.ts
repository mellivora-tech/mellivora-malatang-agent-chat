/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { observableValue, type ObservableValue } from '../../../base/common/observable.js';
import type { ISession, IChat, IChatMessage, ISessionChangesSummary, ISessionWorkspace } from '../../../services/sessions/common/session.js';
import { ChatInteractivity, SessionStatus } from '../../../services/sessions/common/session.js';
import type { ISessionChangeEvent, ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import type { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

interface IMutableChat extends IChat {
	readonly title: ObservableValue<string>;
	readonly messages: ObservableValue<readonly IChatMessage[]>;
	readonly status: ObservableValue<SessionStatus>;
	readonly interactivity: ObservableValue<ChatInteractivity>;
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
	readonly chats: ObservableValue<readonly IMutableChat[]>;
	readonly activeChat: ObservableValue<IMutableChat>;
}

function createChat(
	id: string,
	title: string,
	status: SessionStatus,
	interactivity: ChatInteractivity,
	messages: readonly IChatMessage[]
): IMutableChat {
	return {
		id,
		title: observableValue(title),
		messages: observableValue(messages),
		status: observableValue(status),
		interactivity: observableValue(interactivity)
	};
}

function createSession(options: {
	sessionId: string;
	icon: string;
	status: SessionStatus;
	title: string;
	description?: string;
	workspace: ISessionWorkspace;
	chats: readonly IMutableChat[];
	activeChat?: IMutableChat;
	changesSummary?: ISessionChangesSummary;
	isArchived?: boolean;
	isRead?: boolean;
}): IMutableSession {
	const now = new Date('2026-07-03T09:00:00.000Z');
	const activeChat = options.activeChat ?? options.chats[0]!;

	return {
		sessionId: options.sessionId,
		providerId: 'mock-sessions',
		sessionType: 'mock-agent',
		icon: options.icon,
		createdAt: now,
		workspace: observableValue<ISessionWorkspace | undefined>(options.workspace),
		title: observableValue(options.title),
		updatedAt: observableValue(now),
		status: observableValue(options.status),
		description: observableValue(options.description),
		changesSummary: observableValue(options.changesSummary),
		isArchived: observableValue(options.isArchived ?? false),
		isRead: observableValue(options.isRead ?? true),
		chats: observableValue(options.chats),
		activeChat: observableValue(activeChat)
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
			icon: 'codicon-copilot',
			status: SessionStatus.InProgress,
			title: 'Refine onboarding flow',
			description: 'Agent is iterating on the desktop shell mock.',
			workspace: {
				label: 'mellivora-malatang-agent-chat',
				description: '~/workspace/code/learning-projects',
				branchName: 'codex/agents-window-rebuild'
			},
			chats: [
				createChat(
					'chat-main',
					'Main',
					SessionStatus.InProgress,
					ChatInteractivity.Full,
					[
						{ id: 'main-user-1', role: 'user', text: 'Rebuild the agents window shell.' },
						{ id: 'main-assistant-1', role: 'assistant', text: 'I have the layout in place and I am wiring the mock session domain now.' },
						{ id: 'main-tool-1', role: 'tool', text: 'typecheck', detail: 'Workbench services, mock provider, and chat UI are wired.' }
					]
				),
				createChat(
					'chat-review',
					'Review',
					SessionStatus.InProgress,
					ChatInteractivity.ReadOnly,
					[
						{ id: 'review-user-1', role: 'user', text: 'Check the service chain shape.' },
						{ id: 'review-assistant-1', role: 'assistant', text: 'Provider registration and visibility state look consistent so far.' },
						{ id: 'review-tool-1', role: 'tool', text: 'git status', detail: 'Working tree limited to task-owned files.' }
					]
				)
			],
			changesSummary: {
				files: 5,
				additions: 218,
				deletions: 46
			}
		}),
		createSession({
			sessionId: 'session-completed',
			icon: 'codicon-diff-multiple',
			status: SessionStatus.Completed,
			title: 'Ship settings sidebar cleanup',
			description: 'Completed with a tidy diff and passing checks.',
			workspace: {
				label: 'desktop-settings',
				description: '~/workspace/code/internal',
				branchName: 'codex/settings-cleanup'
			},
			chats: [
				createChat(
					'chat-completed',
					'Summary',
					SessionStatus.Completed,
					ChatInteractivity.ReadOnly,
					[
						{ id: 'completed-user-1', role: 'user', text: 'Wrap up the settings cleanup.' },
						{ id: 'completed-assistant-1', role: 'assistant', text: 'Done. The final state is stable and the diff is ready.' },
						{ id: 'completed-tool-1', role: 'tool', text: 'npm test', detail: 'All tests passed.' }
					]
				)
			],
			changesSummary: {
				files: 8,
				additions: 142,
				deletions: 37
			}
		}),
		createSession({
			sessionId: 'session-needs-input',
			icon: 'codicon-folder',
			status: SessionStatus.NeedsInput,
			title: 'Pick workspace target',
			description: 'Waiting on a workspace selection before continuing.',
			workspace: {
				label: 'new-monorepo',
				description: '~/workspace/sandboxes',
				branchName: 'codex/workspace-picker'
			},
			chats: [
				createChat(
					'chat-needs-input',
					'Workspace',
					SessionStatus.NeedsInput,
					ChatInteractivity.Full,
					[
						{ id: 'input-user-1', role: 'user', text: 'Continue once the repo target is clear.' },
						{ id: 'input-assistant-1', role: 'assistant', text: 'I can keep going as soon as you choose which workspace to attach.' },
						{ id: 'input-tool-1', role: 'tool', text: 'workspace scan', detail: 'Found three matching folders.' }
					]
				)
			]
		}),
		createSession({
			sessionId: 'session-archived',
			icon: 'codicon-git-branch',
			status: SessionStatus.Completed,
			title: 'Archive PR notes',
			description: 'Kept for reference after merge.',
			workspace: {
				label: 'release-train',
				description: '~/workspace/code/releases',
				branchName: 'release/july'
			},
			chats: [
				createChat(
					'chat-archived',
					'Archive',
					SessionStatus.Completed,
					ChatInteractivity.ReadOnly,
					[
						{ id: 'archived-user-1', role: 'user', text: 'Preserve the rollout notes.' },
						{ id: 'archived-assistant-1', role: 'assistant', text: 'Archived with the merge summary and follow-up links.' },
						{ id: 'archived-tool-1', role: 'tool', text: 'git merge', detail: 'Merged into main.' }
					]
				)
			],
			isArchived: true
		})
	];

	readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

	getSessions(): readonly ISession[] {
		return this.sessions;
	}

	async sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession> {
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const chat = session.chats.get().find(candidate => candidate.id === chatId);
		if (!chat) {
			throw new Error(`Unknown chat: ${chatId}`);
		}

		const timestamp = new Date();
		chat.messages.set([
			...chat.messages.get(),
			{ id: `${chatId}-user-${timestamp.getTime()}`, role: 'user', text: query },
			{ id: `${chatId}-assistant-${timestamp.getTime()}`, role: 'assistant', text: `Mock response for: ${query}` }
		]);
		chat.status.set(SessionStatus.InProgress);
		session.activeChat.set(chat);
		session.status.set(SessionStatus.InProgress);
		session.updatedAt.set(timestamp);
		session.isRead.set(false);
		this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });

		return session;
	}
}

export function registerMockSessionsProvider(providersService: ISessionsProvidersService): MockSessionsProvider {
	const provider = new MockSessionsProvider();
	providersService.registerProvider(provider);
	return provider;
}
