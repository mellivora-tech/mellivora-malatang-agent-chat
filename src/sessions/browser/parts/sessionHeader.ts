/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession, ISessionChangesSummary, ISessionWorkspace } from '../../services/sessions/common/session.js';
import { SessionStatus } from '../../services/sessions/common/session.js';
import { ChatCompositeBar, createCompositeAction } from './chatCompositeBar.js';

export class SessionHeader extends Disposable {
	readonly element: HTMLElement;

	private readonly bar = this._register(new ChatCompositeBar('session-header-bar'));
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;

	constructor() {
		super();
		this.element = this.bar.element;
		this.render();
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.render();
			return;
		}

		this.session = session;
		this.sessionDisposables.clear();

		if (session) {
			this.sessionDisposables.add(session.title.subscribe(() => this.render()));
			this.sessionDisposables.add(session.workspace.subscribe(() => this.render()));
			this.sessionDisposables.add(session.status.subscribe(() => this.render()));
			this.sessionDisposables.add(session.changesSummary.subscribe(() => this.render()));
			this.sessionDisposables.add(session.updatedAt.subscribe(() => this.render()));
		}

		this.render();
	}

	private render(): void {
		const header = document.createElement('div');
		header.className = 'chat-composite-bar-header';

		const iconStack = append(header, document.createElement('div'));
		iconStack.className = 'chat-composite-bar-icon-stack';

		const sessionIcon = append(iconStack, document.createElement('span'));
		sessionIcon.className = `chat-composite-bar-session-icon codicon ${this.session?.icon ?? 'codicon-comment-discussion'}`;
		sessionIcon.setAttribute('aria-hidden', 'true');

		const statusDot = append(iconStack, document.createElement('span'));
		statusDot.className = `chat-composite-bar-status-dot ${statusClassName(this.session?.status.get())}`;
		statusDot.title = statusLabel(this.session?.status.get());

		const main = append(header, document.createElement('div'));
		main.className = 'chat-composite-bar-header-main';

		const titleRow = append(main, document.createElement('div'));
		titleRow.className = 'chat-composite-bar-title-row';

		const title = append(titleRow, document.createElement('div'));
		title.className = 'chat-composite-bar-session-title';
		title.textContent = this.session?.title.get() ?? 'No session selected';

		const actions = append(titleRow, document.createElement('div'));
		actions.className = 'chat-composite-bar-title-actions';
		actions.append(
			createCompositeAction('Run', 'codicon-play'),
			createCompositeAction('Open in VS Code', 'codicon-vscode'),
			createCompositeAction('New Chat', 'codicon-comment-add')
		);

		const meta = append(main, document.createElement('div'));
		meta.className = 'chat-composite-bar-meta-row';
		const workspace = this.session?.workspace.get();
		meta.append(
			createMetaItem('Workspace', workspaceLabel(workspace)),
			createMetaItem('Branch', workspace?.branchName ?? 'No branch'),
			createMetaItem('Changes', changesLabel(this.session?.changesSummary.get())),
			createMetaItem('Status', statusLabel(this.session?.status.get()))
		);

		this.bar.setContent(header);
	}
}

function createMetaItem(label: string, value: string): HTMLElement {
	const item = document.createElement('span');
	item.className = 'chat-composite-bar-meta-item';
	item.title = `${label}: ${value}`;
	item.textContent = value;
	return item;
}

function workspaceLabel(workspace: ISessionWorkspace | undefined): string {
	if (!workspace) {
		return 'No workspace';
	}

	return workspace.description ? `${workspace.label} (${workspace.description})` : workspace.label;
}

function changesLabel(summary: ISessionChangesSummary | undefined): string {
	if (!summary || summary.files === 0) {
		return 'No changes';
	}

	const additions = summary.additions > 0 ? `+${summary.additions}` : '0';
	const deletions = summary.deletions > 0 ? `-${summary.deletions}` : '0';
	return `${summary.files} files ${additions} ${deletions}`;
}

function statusLabel(status: SessionStatus | undefined): string {
	switch (status) {
		case SessionStatus.InProgress:
			return 'In progress';
		case SessionStatus.NeedsInput:
			return 'Needs input';
		case SessionStatus.Completed:
			return 'Completed';
		case SessionStatus.Error:
			return 'Error';
		case SessionStatus.Untitled:
			return 'Untitled';
		default:
			return 'No status';
	}
}

function statusClassName(status: SessionStatus | undefined): string {
	switch (status) {
		case SessionStatus.InProgress:
			return 'in-progress';
		case SessionStatus.NeedsInput:
			return 'needs-input';
		case SessionStatus.Completed:
			return 'completed';
		case SessionStatus.Error:
			return 'error';
		default:
			return 'idle';
	}
}
