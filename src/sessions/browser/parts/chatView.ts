/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession, IChat, IChatMessage } from '../../services/sessions/common/session.js';
import { ChatInteractivity } from '../../services/sessions/common/session.js';

export interface IChatRequestSender {
	sendRequest(sessionId: string, chatId: string, query: string): Promise<unknown>;
}

export class ChatView extends Disposable {
	readonly element: HTMLElement;

	private readonly transcript: HTMLElement;
	private readonly composer: HTMLFormElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly sessionDisposables = this._register(new DisposableStore());
	private readonly chatDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;
	private chat: IChat | undefined;
	private isSending = false;

	constructor(private readonly requestSender?: IChatRequestSender) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'chat-view';

		this.transcript = append(this.element, document.createElement('div'));
		this.transcript.className = 'chat-view-transcript';

		this.composer = append(this.element, document.createElement('form'));
		this.composer.className = 'chat-view-composer';

		const inputWrap = append(this.composer, document.createElement('div'));
		inputWrap.className = 'chat-view-input-wrap';

		this.input = append(inputWrap, document.createElement('textarea')) as HTMLTextAreaElement;
		this.input.className = 'chat-view-input';
		this.input.rows = 1;
		this.input.placeholder = 'Ask Codex';
		this.input.spellcheck = true;

		this.sendButton = append(inputWrap, document.createElement('button')) as HTMLButtonElement;
		this.sendButton.className = 'chat-view-send-button';
		this.sendButton.type = 'submit';
		this.sendButton.title = 'Send';
		this.sendButton.setAttribute('aria-label', 'Send');

		const sendIcon = append(this.sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-arrow-up';
		sendIcon.setAttribute('aria-hidden', 'true');

		this._registerEventListeners();
		this.render();
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.bindChat(session?.activeChat.get());
			return;
		}

		this.session = session;
		this.sessionDisposables.clear();

		if (session) {
			this.sessionDisposables.add(session.activeChat.subscribe(chat => this.bindChat(chat)));
		}

		this.bindChat(session?.activeChat.get());
	}

	focus(): void {
		if (!this.input.disabled) {
			this.input.focus();
			return;
		}

		this.element.focus();
	}

	private _registerEventListeners(): void {
		this.composer.addEventListener('submit', event => {
			event.preventDefault();
			void this.send();
		});

		this.input.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}

			event.preventDefault();
			void this.send();
		});

		this.input.addEventListener('input', () => this.updateComposerState());
	}

	private bindChat(chat: IChat | undefined): void {
		if (this.chat === chat) {
			this.render();
			return;
		}

		this.chat = chat;
		this.chatDisposables.clear();

		if (chat) {
			this.chatDisposables.add(chat.messages.subscribe(() => this.render()));
			this.chatDisposables.add(chat.interactivity.subscribe(() => this.render()));
			this.chatDisposables.add(chat.status.subscribe(() => this.render()));
		}

		this.render();
	}

	private render(): void {
		this.element.classList.toggle('empty', !this.session || !this.chat);
		clearNode(this.transcript);

		const messages = this.chat?.messages.get() ?? [];
		if (messages.length === 0) {
			const empty = append(this.transcript, document.createElement('div'));
			empty.className = 'chat-view-empty';
			empty.textContent = this.session ? 'No messages yet' : 'No session selected';
		} else {
			for (const message of messages) {
				this.transcript.appendChild(createMessageRow(message));
			}
		}

		this.updateComposerState();
	}

	private updateComposerState(): void {
		const interactivity = this.chat?.interactivity.get();
		const canType = Boolean(this.session && this.chat && interactivity === ChatInteractivity.Full && !this.isSending);
		const hasText = this.input.value.trim().length > 0;

		this.composer.hidden = interactivity === ChatInteractivity.Hidden;
		this.input.disabled = !canType;
		this.sendButton.disabled = !canType || !hasText;
		this.input.placeholder = interactivity === ChatInteractivity.ReadOnly ? 'Chat is read-only' : 'Ask Codex';
	}

	private async send(): Promise<void> {
		const query = this.input.value.trim();
		const session = this.session;
		const chat = this.chat;
		if (!query || !session || !chat || this.isSending || chat.interactivity.get() !== ChatInteractivity.Full) {
			return;
		}

		this.input.value = '';
		this.isSending = true;
		this.updateComposerState();

		try {
			await this.requestSender?.sendRequest(session.sessionId, chat.id, query);
		} finally {
			this.isSending = false;
			this.updateComposerState();
		}
	}
}

function createMessageRow(message: IChatMessage): HTMLElement {
	const row = document.createElement('article');
	row.className = `chat-view-message ${message.role}`;

	const avatar = append(row, document.createElement('div'));
	avatar.className = 'chat-view-message-avatar';
	const icon = append(avatar, document.createElement('span'));
	icon.className = `codicon ${messageIcon(message.role)}`;
	icon.setAttribute('aria-hidden', 'true');

	const body = append(row, document.createElement('div'));
	body.className = 'chat-view-message-body';

	const label = append(body, document.createElement('div'));
	label.className = 'chat-view-message-label';
	label.textContent = messageLabel(message.role);

	const text = append(body, document.createElement('div'));
	text.className = 'chat-view-message-text';
	text.textContent = message.text;

	if (message.detail) {
		const detail = append(body, document.createElement('div'));
		detail.className = 'chat-view-tool-detail';
		detail.textContent = message.detail;
	}

	return row;
}

function messageIcon(role: IChatMessage['role']): string {
	switch (role) {
		case 'user':
			return 'codicon-account';
		case 'assistant':
			return 'codicon-copilot';
		case 'tool':
			return 'codicon-tools';
	}
}

function messageLabel(role: IChatMessage['role']): string {
	switch (role) {
		case 'user':
			return 'You';
		case 'assistant':
			return 'Codex';
		case 'tool':
			return 'Tool';
	}
}
