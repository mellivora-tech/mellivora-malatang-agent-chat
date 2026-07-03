/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import { ConversationContextBar } from './conversationContextBar.js';

export class ConversationContext extends Disposable {
	readonly element: HTMLElement;

	private readonly bar = this._register(new ConversationContextBar('conversation-context-bar'));
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
		const header = document.createElement('header');
		header.className = 'conversation-context';

		const left = append(header, document.createElement('div'));
		left.className = 'conversation-context-left';

		const workspace = this.session?.workspace.get();

		const title = append(left, document.createElement('span'));
		title.className = 'conversation-context-title';
		title.textContent = this.session?.title.get() ?? 'New Session';

		left.appendChild(createPill('conversation-context-workspace', 'codicon-folder', workspace?.label ?? 'No workspace'));
		left.appendChild(createPill('conversation-context-branch', 'codicon-git-branch', workspace?.branchName ?? 'main'));

		const more = append(left, document.createElement('button')) as HTMLButtonElement;
		more.className = 'conversation-context-more';
		more.type = 'button';
		more.title = 'More actions';
		more.setAttribute('aria-label', 'More actions');

		const moreIcon = append(more, document.createElement('span'));
		moreIcon.className = 'codicon codicon-ellipsis';
		moreIcon.setAttribute('aria-hidden', 'true');

		this.bar.setContent(header);
	}
}

function createPill(className: string, iconClass: string, labelText: string): HTMLElement {
	const pill = document.createElement('button');
	pill.className = `conversation-context-pill ${className}`;
	pill.type = 'button';

	const icon = append(pill, document.createElement('span'));
	icon.className = `codicon ${iconClass}`;
	icon.setAttribute('aria-hidden', 'true');

	const label = append(pill, document.createElement('span'));
	label.textContent = labelText;

	const chevron = append(pill, document.createElement('span'));
	chevron.className = 'codicon codicon-chevron-down';
	chevron.setAttribute('aria-hidden', 'true');

	return pill;
}
