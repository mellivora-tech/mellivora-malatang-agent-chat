/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode, size } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession, IChat } from '../../services/sessions/common/session.js';
import { ChatCompositeBar } from './chatCompositeBar.js';
import { ChatView, type IChatRequestSender } from './chatView.js';
import { SessionHeader } from './sessionHeader.js';

export class SessionView extends Disposable {
	readonly element: HTMLElement;

	private readonly centeredContent: HTMLElement;
	private readonly header = this._register(new SessionHeader());
	private readonly chatTabsBar = this._register(new ChatCompositeBar('session-chat-tabs-bar'));
	private readonly content: HTMLElement;
	private readonly chatView: ChatView;
	private readonly sessionDisposables = this._register(new DisposableStore());
	private readonly tabDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;

	constructor(requestSender?: IChatRequestSender) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'session-view';
		this.element.tabIndex = -1;

		this.centeredContent = append(this.element, document.createElement('div'));
		this.centeredContent.className = 'session-view-centered-content';
		this.centeredContent.append(this.header.element, this.chatTabsBar.element);

		this.content = append(this.element, document.createElement('div'));
		this.content.className = 'session-view-content';

		this.chatView = this._register(new ChatView(requestSender));
		this.content.appendChild(this.chatView.element);

		this.openSession(undefined);
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.header.openSession(session);
			this.chatView.openSession(session);
			this.renderTabs();
			return;
		}

		this.session = session;
		this.sessionDisposables.clear();
		this.tabDisposables.clear();

		if (session) {
			this.sessionDisposables.add(session.openChats.subscribe(() => this.renderTabs()));
			this.sessionDisposables.add(session.activeChat.subscribe(() => this.renderTabs()));
			this.sessionDisposables.add(session.shouldShowChatTabs.subscribe(() => this.renderTabs()));
		}

		this.element.classList.toggle('empty', !session);
		this.header.openSession(session);
		this.chatView.openSession(session);
		this.renderTabs();
	}

	setActive(active: boolean): void {
		this.element.classList.toggle('is-active', active);
	}

	focus(): void {
		this.chatView.focus();
	}

	layout(width: number, height: number): void {
		size(this.element, width, height);
	}

	private renderTabs(): void {
		this.tabDisposables.clear();
		clearNode(this.chatTabsBar.element);

		const session = this.session;
		if (!session || !session.shouldShowChatTabs.get()) {
			this.chatTabsBar.element.hidden = true;
			return;
		}

		const chats = session.openChats.get();
		const activeChat = session.activeChat.get();
		for (const chat of chats) {
			this.tabDisposables.add(chat.title.subscribe(() => this.renderTabs()));
		}

		this.chatTabsBar.element.hidden = false;

		const row = document.createElement('div');
		row.className = 'chat-composite-bar-tabs-row';

		const tabs = append(row, document.createElement('div'));
		tabs.className = 'chat-composite-bar-tabs';
		tabs.setAttribute('role', 'tablist');

		chats.forEach((chat, index) => {
			tabs.appendChild(createChatTab(chat, chat.id === activeChat.id, index > 0));
		});

		this.chatTabsBar.setContent(row);
	}
}

function createChatTab(chat: IChat, active: boolean, showClose: boolean): HTMLElement {
	const tab = document.createElement('button');
	tab.className = active ? 'chat-composite-bar-tab active' : 'chat-composite-bar-tab';
	tab.type = 'button';
	tab.setAttribute('role', 'tab');
	tab.setAttribute('aria-selected', active ? 'true' : 'false');

	const title = append(tab, document.createElement('span'));
	title.className = 'chat-composite-bar-tab-label';
	title.textContent = chat.title.get();

	if (showClose) {
		const close = append(tab, document.createElement('span'));
		close.className = 'chat-composite-bar-tab-close codicon codicon-close';
		close.setAttribute('aria-hidden', 'true');
	}

	return tab;
}
