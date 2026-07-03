/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ChatInteractivity, SessionStatus, type IActiveSession, type IChat, type ISession, type ISessionChangesSummary, type ISessionWorkspace } from '../../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface ISessionsListOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

type SessionLike = ISession | IActiveSession;

interface ISessionListRow {
	readonly id: string;
	readonly icon: string;
	readonly status: SessionStatus;
	readonly title: string;
	readonly workspace?: ISessionWorkspace;
	readonly changesSummary?: ISessionChangesSummary;
	readonly updatedAt: Date;
	readonly description?: string;
	readonly isActive?: boolean;
	readonly isUnread?: boolean;
	readonly onClick?: () => void;
}

export class SessionsList extends Disposable {
	private readonly rowSubscriptions = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		private readonly options: ISessionsListOptions = {}
	) {
		super();
		this.bind();
		this.render();
	}

	private bind(): void {
		const visibleSessions = this.options.sessionsService?.visibleSessions ?? this.options.sessionsPartService?.visibleSessions;
		const activeSession = this.options.sessionsService?.activeSession ?? this.options.sessionsPartService?.activeSession;

		if (visibleSessions) {
			this._register(visibleSessions.subscribe(() => this.render()));
		}

		if (activeSession) {
			this._register(activeSession.subscribe(() => this.render()));
		}
	}

	private render(): void {
		this.rowSubscriptions.clear();
		this.container.textContent = '';

		const root = document.createElement('div');
		root.className = 'sessions-sidebar';
		this.container.appendChild(root);

		this.renderHeader(root);

		const content = document.createElement('div');
		content.className = 'sessions-sidebar-content';
		root.appendChild(content);

		const sessions = this.getSessions();
		if (sessions.length === 0) {
			this.renderFallback(content);
		} else {
			this.renderSessionSections(content, sessions);
			this.bindRows(sessions);
		}

		this.renderFooter(root);
	}

	private renderHeader(container: HTMLElement): void {
		const header = document.createElement('div');
		header.className = 'sessions-sidebar-header';

		const title = document.createElement('span');
		title.textContent = 'Agent Chat';
		header.appendChild(title);

		const button = document.createElement('button');
		button.className = 'sessions-sidebar-icon-button';
		button.type = 'button';
		button.title = 'New Session';
		button.setAttribute('aria-label', 'New Session');
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-add';
		icon.setAttribute('aria-hidden', 'true');
		button.appendChild(icon);
		header.appendChild(button);

		container.appendChild(header);
	}

	private renderSessionSections(container: HTMLElement, sessions: readonly SessionLike[]): void {
		const activeSession = this.getActiveSession();
		const activeWorkspace = activeSession?.workspace.get()?.label;
		const activeId = activeSession?.sessionId;
		const visibleIds = new Set(this.getVisibleSessions().map(session => session.sessionId));

		const openSessions = sessions.filter(session => !session.isArchived.get() && session.status.get() !== SessionStatus.Completed);
		const pinnedSessions = sessions.filter(session => visibleIds.has(session.sessionId));
		const activeChats = activeSession?.chats.get() ?? [];
		const workspaceSessions = activeWorkspace
			? sessions.filter(session => session.workspace.get()?.label === activeWorkspace)
			: sessions.filter(session => session.workspace.get()?.label === 'mellivora-malatang-agent-chat');
		const doneSessions = sessions.filter(session => session.isArchived.get() || session.status.get() === SessionStatus.Completed);

		this.renderSection(container, 'Sessions', openSessions.map(session => this.toSessionRow(session, activeId)));
		this.renderSection(container, 'Pinned', pinnedSessions.map(session => this.toSessionRow(session, activeId)));
		this.renderSection(container, 'Chats', activeChats.map(chat => this.toChatRow(chat, activeSession)));
		this.renderSection(container, 'agent-chat', workspaceSessions.map(session => this.toSessionRow(session, activeId, activeWorkspace)));
		this.renderSection(container, 'Done', doneSessions.map(session => this.toSessionRow(session, activeId)));
	}

	private renderFallback(container: HTMLElement): void {
		const now = new Date();
		const workspace: ISessionWorkspace = {
			label: 'mellivora-malatang-agent-chat',
			branchName: 'codex/agents-window-rebuild'
		};

		const rows: readonly ISessionListRow[] = [
			{
				id: 'fallback-active',
				icon: 'codicon-copilot',
				status: SessionStatus.InProgress,
				title: 'Refine onboarding flow',
				workspace,
				updatedAt: now,
				description: 'Mock provider will appear here',
				changesSummary: { files: 4, additions: 96, deletions: 18 },
				isActive: true
			}
		];

		this.renderSection(container, 'Sessions', rows);
		this.renderSection(container, 'Pinned', rows);
		this.renderSection(container, 'Chats', [
			{
				id: 'fallback-chat',
				icon: 'codicon-comment-discussion',
				status: SessionStatus.InProgress,
				title: 'Main',
				workspace,
				updatedAt: now,
				description: 'Full access chat',
				isActive: true
			}
		]);
		this.renderSection(container, 'agent-chat', rows.map(row => omitWorkspace(row)));
		this.renderSection(container, 'Done', [
			{
				id: 'fallback-done',
				icon: 'codicon-check',
				status: SessionStatus.Completed,
				title: 'Ship settings sidebar cleanup',
				updatedAt: now,
				description: 'Completed',
				changesSummary: { files: 8, additions: 142, deletions: 37 }
			}
		]);
	}

	private renderSection(container: HTMLElement, title: string, rows: readonly ISessionListRow[]): void {
		const section = document.createElement('section');
		section.className = 'sessions-list-section';

		const header = document.createElement('div');
		header.className = 'sessions-list-section-header';
		header.textContent = title;
		section.appendChild(header);

		const list = document.createElement('div');
		list.className = 'sessions-list-section-rows';
		section.appendChild(list);

		if (rows.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sessions-list-empty';
			empty.textContent = 'No sessions';
			list.appendChild(empty);
		} else {
			for (const row of rows) {
				list.appendChild(this.renderRow(row));
			}
		}

		container.appendChild(section);
	}

	private renderRow(row: ISessionListRow): HTMLElement {
		const element = document.createElement('button');
		element.className = 'sessions-list-row';
		element.type = 'button';
		element.dataset.sessionRowId = row.id;
		if (row.isActive) {
			element.classList.add('active');
		}
		if (row.isUnread) {
			element.classList.add('unread');
		}
		if (row.onClick) {
			element.addEventListener('click', row.onClick);
		}

		const status = document.createElement('span');
		status.className = `sessions-list-status codicon ${getStatusIcon(row.status)}`;
		status.title = getStatusLabel(row.status);
		status.setAttribute('aria-hidden', 'true');
		element.appendChild(status);

		const body = document.createElement('span');
		body.className = 'sessions-list-row-body';

		const top = document.createElement('span');
		top.className = 'sessions-list-row-top';

		const title = document.createElement('span');
		title.className = 'sessions-list-row-title';
		title.textContent = row.title;
		top.appendChild(title);

		if (row.workspace) {
			const workspace = document.createElement('span');
			workspace.className = 'sessions-list-workspace-badge';
			workspace.textContent = row.workspace.label;
			top.appendChild(workspace);
		}

		if (row.changesSummary) {
			top.appendChild(createDiff(row.changesSummary));
		}

		body.appendChild(top);

		const bottom = document.createElement('span');
		bottom.className = 'sessions-list-row-bottom';
		bottom.textContent = `${formatTimestamp(row.updatedAt)} - ${row.description ?? getStatusLabel(row.status)}`;
		body.appendChild(bottom);

		element.appendChild(body);
		return element;
	}

	private renderFooter(container: HTMLElement): void {
		const footer = document.createElement('div');
		footer.className = 'sessions-sidebar-footer';

		const placeholder = document.createElement('div');
		placeholder.className = 'sessions-sidebar-footer-placeholder';
		placeholder.textContent = 'Ready for mock sessions';
		footer.appendChild(placeholder);

		const account = document.createElement('button');
		account.className = 'sessions-sidebar-account';
		account.type = 'button';
		account.title = 'Account';
		account.setAttribute('aria-label', 'Account');
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-account';
		icon.setAttribute('aria-hidden', 'true');
		account.appendChild(icon);
		const label = document.createElement('span');
		label.textContent = 'sgx';
		account.appendChild(label);
		footer.appendChild(account);

		container.appendChild(footer);
	}

	private toSessionRow(session: SessionLike, activeSessionId: string | undefined, redundantWorkspace?: string): ISessionListRow {
		const workspace = session.workspace.get();
		const changesSummary = session.changesSummary.get();
		const description = session.description.get();
		return {
			id: session.sessionId,
			icon: session.icon,
			status: session.status.get(),
			title: session.title.get(),
			...(workspace && workspace.label !== redundantWorkspace ? { workspace } : {}),
			...(changesSummary ? { changesSummary } : {}),
			updatedAt: session.updatedAt.get(),
			...(description ? { description } : {}),
			isActive: session.sessionId === activeSessionId,
			isUnread: !session.isRead.get(),
			onClick: () => {
				this.options.sessionsService?.openSession(session.sessionId);
			}
		};
	}

	private toChatRow(chat: IChat, session: SessionLike | undefined): ISessionListRow {
		const workspace = session?.workspace.get();
		const changesSummary = session?.changesSummary.get();
		const interactivity = chat.interactivity.get() === ChatInteractivity.ReadOnly ? 'Read-only chat' : 'Full access chat';
		return {
			id: chat.id,
			icon: 'codicon-comment-discussion',
			status: chat.status.get(),
			title: chat.title.get(),
			...(workspace ? { workspace } : {}),
			...(changesSummary ? { changesSummary } : {}),
			updatedAt: session?.updatedAt.get() ?? new Date(),
			description: interactivity,
			...(session?.activeChat.get().id === chat.id ? { isActive: true } : {}),
			...(session ? {
				onClick: () => {
					this.options.sessionsService?.openSession(session.sessionId);
				}
			} : {})
		};
	}

	private bindRows(sessions: readonly SessionLike[]): void {
		const seenSessions = new Set<string>();
		for (const session of sessions) {
			if (seenSessions.has(session.sessionId)) {
				continue;
			}
			seenSessions.add(session.sessionId);
			for (const observable of [
				session.workspace,
				session.title,
				session.updatedAt,
				session.status,
				session.description,
				session.changesSummary,
				session.isArchived,
				session.isRead,
				session.chats,
				session.activeChat
			]) {
				this.rowSubscriptions.add(observable.subscribe(() => this.render()));
			}
		}

		const activeSession = this.getActiveSession();
		if (activeSession) {
			for (const chat of activeSession.chats.get()) {
				for (const observable of [chat.title, chat.status, chat.interactivity]) {
					this.rowSubscriptions.add(observable.subscribe(() => this.render()));
				}
			}
		}
	}

	private getSessions(): readonly SessionLike[] {
		const serviceSessions = this.options.sessionsService?.getSessions();
		if (serviceSessions) {
			return serviceSessions;
		}

		return this.getVisibleSessions();
	}

	private getVisibleSessions(): readonly IActiveSession[] {
		const visible = this.options.sessionsService?.visibleSessions.get() ?? this.options.sessionsPartService?.visibleSessions.get() ?? [];
		return visible.filter((session): session is IActiveSession => session !== undefined);
	}

	private getActiveSession(): IActiveSession | undefined {
		return this.options.sessionsService?.activeSession.get() ?? this.options.sessionsPartService?.activeSession.get();
	}
}

function createDiff(summary: ISessionChangesSummary): HTMLElement {
	const diff = document.createElement('span');
	diff.className = 'sessions-list-diff';
	diff.title = `${summary.files} changed files`;

	const additions = document.createElement('span');
	additions.className = 'sessions-diff-additions';
	additions.textContent = `+${summary.additions}`;
	diff.appendChild(additions);

	const deletions = document.createElement('span');
	deletions.className = 'sessions-diff-deletions';
	deletions.textContent = `-${summary.deletions}`;
	diff.appendChild(deletions);

	return diff;
}

function omitWorkspace(row: ISessionListRow): ISessionListRow {
	return {
		id: row.id,
		icon: row.icon,
		status: row.status,
		title: row.title,
		...(row.changesSummary ? { changesSummary: row.changesSummary } : {}),
		updatedAt: row.updatedAt,
		...(row.description ? { description: row.description } : {}),
		...(row.isActive ? { isActive: true } : {}),
		...(row.isUnread ? { isUnread: true } : {}),
		...(row.onClick ? { onClick: row.onClick } : {})
	};
}

function getStatusIcon(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled:
			return 'codicon-circle-large-outline';
		case SessionStatus.InProgress:
			return 'codicon-sync';
		case SessionStatus.NeedsInput:
			return 'codicon-question';
		case SessionStatus.Completed:
			return 'codicon-check';
		case SessionStatus.Error:
			return 'codicon-error';
	}
}

function getStatusLabel(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled:
			return 'Untitled';
		case SessionStatus.InProgress:
			return 'In progress';
		case SessionStatus.NeedsInput:
			return 'Needs input';
		case SessionStatus.Completed:
			return 'Completed';
		case SessionStatus.Error:
			return 'Error';
	}
}

function formatTimestamp(date: Date): string {
	const diff = Date.now() - date.getTime();
	const minutes = Math.max(0, Math.floor(diff / 60000));
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}

	return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
