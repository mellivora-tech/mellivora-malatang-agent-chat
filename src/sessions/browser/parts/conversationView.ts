/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession, ISessionMessage } from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../services/sessions/common/session.js';
import { ConversationContext } from './conversationContext.js';

export interface ISessionMessageSender {
	sendMessage(sessionId: string, query: string): Promise<unknown>;
	stopSession(sessionId: string): Promise<unknown>;
}

export class ConversationView extends Disposable {
	readonly element: HTMLElement;

	private readonly transcript: HTMLElement;
	private readonly composer: HTMLFormElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly reconnectStatus: HTMLElement;
	private readonly sendError: HTMLElement;
	private readonly header = this._register(new ConversationContext());
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;
	private isSending = false;
	private isStopping = false;

	constructor(private readonly messageSender?: ISessionMessageSender) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'conversation-view';

		this.transcript = append(this.element, document.createElement('div'));
		this.transcript.className = 'conversation-transcript';

		this.composer = append(this.element, document.createElement('form'));
		this.composer.className = 'conversation-composer';
		this.composer.appendChild(this.header.element);
		this.header.element.hidden = true;

		const inputWrap = append(this.composer, document.createElement('div'));
		inputWrap.className = 'conversation-input-wrap';

		this.input = append(inputWrap, document.createElement('textarea')) as HTMLTextAreaElement;
		this.input.className = 'conversation-input';
		this.input.rows = 1;
		this.input.placeholder = 'Ask Codex';
		this.input.spellcheck = true;

		const toolbar = append(inputWrap, document.createElement('div'));
		toolbar.className = 'conversation-composer-toolbar';

		const leftControls = append(toolbar, document.createElement('div'));
		leftControls.className = 'conversation-toolbar-left';

		const access = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		access.className = 'conversation-access';
		access.type = 'button';
		access.title = 'Approvals';
		appendCodicon(access, 'codicon-shield');
		const accessLabel = append(access, document.createElement('span'));
		accessLabel.textContent = 'Full access';
		appendCodicon(access, 'codicon-chevron-down');

		this.reconnectStatus = append(leftControls, document.createElement('div'));
		this.reconnectStatus.className = 'conversation-reconnect-status';
		this.reconnectStatus.setAttribute('aria-live', 'polite');
		appendCodicon(this.reconnectStatus, 'codicon-loading');
		const reconnectLabel = append(this.reconnectStatus, document.createElement('span'));
		reconnectLabel.textContent = 'Reconnecting... 1/10';

		const rightControls = append(toolbar, document.createElement('div'));
		rightControls.className = 'conversation-toolbar-right';

		const model = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		model.className = 'conversation-model';
		model.type = 'button';
		model.title = 'Pick model';
		appendCodicon(model, 'codicon-circle-large-outline');
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = 'GLM-5.2';
		appendCodicon(model, 'codicon-chevron-down');

		const agent = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		agent.className = 'conversation-agent';
		agent.type = 'button';
		agent.title = 'Pick agent';
		appendCodicon(agent, 'codicon-github-alt');
		const agentLabel = append(agent, document.createElement('span'));
		agentLabel.textContent = 'Max';
		appendCodicon(agent, 'codicon-chevron-down');

		this.stopButton = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		this.stopButton.className = 'conversation-stop-button';
		this.stopButton.type = 'button';
		this.stopButton.title = 'Stop';
		this.stopButton.setAttribute('aria-label', 'Stop');
		appendCodicon(this.stopButton, 'codicon-debug-stop');

		this.sendButton = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		this.sendButton.className = 'conversation-send-button';
		this.sendButton.type = 'submit';
		this.sendButton.title = 'Send';
		this.sendButton.setAttribute('aria-label', 'Send');
		appendCodicon(this.sendButton, 'codicon-arrow-up');

		this.sendError = append(this.composer, document.createElement('div'));
		this.sendError.className = 'conversation-send-error';
		this.sendError.setAttribute('role', 'alert');
		this.sendError.hidden = true;

		this._registerEventListeners();
		this.render();
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.render();
			return;
		}

		this.session = session;
		this.sessionDisposables.clear();
		this.header.openSession(session);
		this.setSendError(undefined);

		if (session) {
			this.sessionDisposables.add(session.messages.subscribe(() => this.render()));
			this.sessionDisposables.add(session.interactivity.subscribe(() => this.render()));
			this.sessionDisposables.add(session.status.subscribe(() => this.render()));
		}

		this.render();
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

		this.stopButton.addEventListener('click', () => {
			void this.stop();
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

	private render(): void {
		this.element.classList.toggle('empty', !this.session);
		this.element.dataset.status = this.session ? conversationStatusId(this.session.status.get()) : 'empty';
		this.element.dataset.interactivity = this.session?.interactivity.get() ?? 'none';
		this.header.element.hidden = !this.session;
		clearNode(this.transcript);

		const messages = this.session?.messages.get() ?? [];
		if (messages.length === 0) {
			const empty = append(this.transcript, document.createElement('div'));
			empty.className = 'conversation-empty';
			empty.textContent = this.session ? 'No messages yet' : 'No session selected';
		} else {
			for (const message of messages) {
				this.transcript.appendChild(createMessageRow(message));
			}
		}

		if (this.session?.status.get() === SessionStatus.InProgress) {
			this.transcript.appendChild(this.createWorkingRow());
			this.transcript.appendChild(this.createThinkingRow());
		}

		this.updateComposerState();
	}

	private createWorkingRow(): HTMLElement {
		const row = document.createElement('div');
		row.className = 'conversation-working-row';

		const label = append(row, document.createElement('div'));
		label.className = 'conversation-working-label';
		label.textContent = formatWorkingDuration(this.session?.createdAt);

		return row;
	}

	private createThinkingRow(): HTMLElement {
		const row = document.createElement('div');
		row.className = 'conversation-thinking-row';

		const spinner = append(row, document.createElement('span'));
		spinner.className = 'codicon codicon-loading';
		spinner.setAttribute('aria-hidden', 'true');

		const label = append(row, document.createElement('span'));
		label.textContent = 'Thinking';

		return row;
	}

	private updateComposerState(): void {
		const interactivity = this.session?.interactivity.get();
		const isRunning = this.session?.status.get() === SessionStatus.InProgress;
		const canType = Boolean(this.session && interactivity === SessionInteractivity.Full && !this.isSending);
		const hasText = this.input.value.trim().length > 0;

		this.composer.hidden = interactivity === SessionInteractivity.Hidden;
		this.composer.classList.toggle('running', isRunning);
		this.composer.classList.toggle('idle', !isRunning);
		this.composer.dataset.state = isRunning ? 'running' : 'idle';
		this.input.disabled = !canType;
		this.sendButton.disabled = !canType || !hasText;
		this.sendButton.hidden = isRunning;
		this.stopButton.hidden = !isRunning;
		this.reconnectStatus.hidden = !isRunning;
		this.input.placeholder = isRunning ? 'Keep typing to queue follow-up changes' : interactivity === SessionInteractivity.ReadOnly ? 'Session is read-only' : 'Ask Codex';
	}

	private async send(): Promise<void> {
		const query = this.input.value.trim();
		const session = this.session;
		if (!query || !session || this.isSending || session.interactivity.get() !== SessionInteractivity.Full) {
			return;
		}

		this.isSending = true;
		this.setSendError(undefined);
		this.updateComposerState();

		try {
			await this.messageSender?.sendMessage(session.sessionId, query);
			this.input.value = '';
		} catch {
			this.setSendError('Message failed to send. Your draft was kept — try again.');
		} finally {
			this.isSending = false;
			this.updateComposerState();
		}
	}

	private async stop(): Promise<void> {
		const session = this.session;
		if (!session || this.isStopping) {
			return;
		}

		this.isStopping = true;
		this.stopButton.disabled = true;

		try {
			await this.messageSender?.stopSession(session.sessionId);
		} catch {
			this.setSendError('Could not stop the session.');
		} finally {
			this.isStopping = false;
			this.stopButton.disabled = false;
		}
	}

	private setSendError(message: string | undefined): void {
		this.sendError.textContent = message ?? '';
		this.sendError.hidden = !message;
	}
}

function appendCodicon(parent: HTMLElement, codicon: string): HTMLElement {
	const icon = append(parent, document.createElement('span'));
	icon.className = `codicon ${codicon}`;
	icon.setAttribute('aria-hidden', 'true');
	return icon;
}

function createMessageRow(message: ISessionMessage): HTMLElement {
	const row = document.createElement('article');
	row.className = `conversation-message ${message.role}`;
	row.dataset.role = message.role;

	const avatar = append(row, document.createElement('div'));
	avatar.className = 'conversation-message-avatar';
	const icon = append(avatar, document.createElement('span'));
	icon.className = `codicon ${messageIcon(message.role)}`;
	icon.setAttribute('aria-hidden', 'true');

	const body = append(row, document.createElement('div'));
	body.className = 'conversation-message-body';

	const label = append(body, document.createElement('div'));
	label.className = 'conversation-message-label';
	label.textContent = messageLabel(message.role);

	if (message.role === 'user') {
		const bubble = append(body, document.createElement('div'));
		bubble.className = 'conversation-message-bubble';
		bubble.textContent = message.text;
	} else {
		const text = append(body, document.createElement('div'));
		text.className = 'conversation-message-text';
		text.textContent = message.text;
	}

	if (message.detail) {
		const detail = append(body, document.createElement('div'));
		detail.className = 'conversation-tool-detail';
		detail.textContent = message.detail;
	}

	return row;
}

function formatWorkingDuration(startedAt: Date | undefined): string {
	const elapsedMs = Math.max(0, Date.now() - (startedAt?.getTime() ?? Date.now()));
	const totalSeconds = Math.floor(elapsedMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `Working for ${minutes}m ${seconds}s`;
	}

	return `Working for ${seconds}s`;
}

function messageIcon(role: ISessionMessage['role']): string {
	switch (role) {
		case 'user':
			return 'codicon-account';
		case 'assistant':
			return 'codicon-copilot';
		case 'tool':
			return 'codicon-tools';
	}
}

function messageLabel(role: ISessionMessage['role']): string {
	switch (role) {
		case 'user':
			return 'You';
		case 'assistant':
			return 'Codex';
		case 'tool':
			return 'Tool';
	}
}

function conversationStatusId(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled:
			return 'untitled';
		case SessionStatus.InProgress:
			return 'in-progress';
		case SessionStatus.NeedsInput:
			return 'needs-input';
		case SessionStatus.Completed:
			return 'completed';
		case SessionStatus.Error:
			return 'error';
	}
}
