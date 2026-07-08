/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IActiveSession, ISessionMessage, ISessionPendingApproval, ISessionWorkStep } from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../services/sessions/common/session.js';
import { ConversationContext } from './conversationContext.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';

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
	private readonly sendError: HTMLElement;
	private readonly contextRing: HTMLElement;
	private readonly header = this._register(new ConversationContext());
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;
	private isSending = false;
	private isStopping = false;
	// Work blocks: user toggles override the default (open while live, closed when done).
	private readonly workExpandOverride = new Map<string, boolean>();
	// Individually expanded tool steps ("messageId:index").
	private readonly stepExpand = new Set<string>();
	private scrollToBottomOnRender = false;
	// Live elapsed time is measured from when the block first appeared in this view.
	private readonly workFirstSeen = new Map<string, number>();
	private workTicker: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly messageSender?: ISessionMessageSender,
		private readonly modelsService?: IModelsService,
	) {
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
		const accessIcon = appendCodicon(access, 'codicon-shield');
		const accessLabel = append(access, document.createElement('span'));
		appendCodicon(access, 'codicon-chevron-down');
		// Menu hosted on the view root — the composer clips overflow.
		this._register(installPermissionPicker({ host: this.element, trigger: access, label: accessLabel, icon: accessIcon }));

		const rightControls = append(toolbar, document.createElement('div'));
		rightControls.className = 'conversation-toolbar-right';

		// A standalone read-only indicator — deliberately not part of the
		// model button, which is an interactive picker.
		this.contextRing = append(rightControls, createContextRing());

		const model = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		model.className = 'conversation-model';
		model.type = 'button';
		model.title = 'Pick model';
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = 'No model';
		appendCodicon(model, 'codicon-chevron-down');
		const effort = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		effort.className = 'conversation-effort';
		effort.type = 'button';
		effort.hidden = true;
		const effortLabel = append(effort, document.createElement('span'));
		appendCodicon(effort, 'codicon-chevron-down');

		if (this.modelsService) {
			// Host the menus on the view root — the composer clips overflow.
			this._register(installModelPicker({ host: this.element, trigger: model, label: modelLabel, modelsService: this.modelsService }));
			this._register(installEffortPicker({ host: this.element, trigger: effort, label: effortLabel, modelsService: this.modelsService }));
			// A model switch changes the context window the ring measures against.
			this._register(this.modelsService.selectedModel.subscribe(() => this.updateContextRing()));
		}

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
		// A freshly opened conversation starts at its latest message.
		this.scrollToBottomOnRender = true;

		if (session) {
			this.sessionDisposables.add(session.messages.subscribe(() => this.render()));
			this.sessionDisposables.add(session.interactivity.subscribe(() => this.render()));
			this.sessionDisposables.add(session.status.subscribe(() => this.render()));
			this.sessionDisposables.add(session.pendingApproval.subscribe(() => this.render()));
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

		// Rebuilding the transcript resets scrollTop. Follow the output while the
		// reader is at (or near) the bottom; preserve their position otherwise.
		const stickToBottom = this.scrollToBottomOnRender || this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 48;
		const previousScrollTop = this.transcript.scrollTop;
		this.scrollToBottomOnRender = false;

		clearNode(this.transcript);

		const messages = this.session?.messages.get() ?? [];
		if (messages.length === 0) {
			const empty = append(this.transcript, document.createElement('div'));
			empty.className = 'conversation-empty';
			empty.textContent = this.session ? 'No messages yet' : 'No session selected';
		} else {
			for (const message of messages) {
				this.transcript.appendChild(message.role === 'work' ? this.createWorkBlock(message) : createMessageRow(message));
			}
		}

		const hasLiveWork = messages.some(message => message.role === 'work' && message.durationMs === undefined);
		const approval = this.session?.pendingApproval.get();
		if (approval) {
			this.transcript.appendChild(createApprovalCard(approval));
		} else if (this.session?.status.get() === SessionStatus.InProgress && !hasLiveWork) {
			// Mock/legacy runs without a work block keep the plain progress rows.
			this.transcript.appendChild(this.createWorkingRow());
			this.transcript.appendChild(this.createThinkingRow());
		}

		// An approval question always comes into view; otherwise honor stickiness.
		if (approval || stickToBottom) {
			this.transcript.scrollTop = this.transcript.scrollHeight;
		} else {
			this.transcript.scrollTop = previousScrollTop;
		}

		this.updateWorkTicker(hasLiveWork);
		this.updateComposerState();
		this.updateContextRing();
	}

	/**
	 * "Worked for 16m 56s ⌄" — one collapsible block per agent run, holding the
	 * thinking stretches and tool calls with their durations. Open while the run
	 * is live (header ticks every second), collapsed once it settles.
	 */
	private createWorkBlock(message: ISessionMessage): HTMLElement {
		const live = message.durationMs === undefined;
		if (live && !this.workFirstSeen.has(message.id)) {
			this.workFirstSeen.set(message.id, Date.now());
		}
		const expanded = this.workExpandOverride.get(message.id) ?? live;

		const block = document.createElement('section');
		block.className = 'conversation-work';
		block.classList.toggle('live', live);

		const header = append(block, document.createElement('button')) as HTMLButtonElement;
		header.className = 'conversation-work-header';
		header.type = 'button';
		header.setAttribute('aria-expanded', String(expanded));
		if (live) {
			const spinner = append(header, document.createElement('span'));
			spinner.className = 'codicon codicon-loading codicon-modifier-spin';
			spinner.setAttribute('aria-hidden', 'true');
		}
		const title = append(header, document.createElement('span'));
		title.className = 'conversation-work-title';
		title.textContent = live
			? `Working for ${formatDurationMs(Date.now() - (this.workFirstSeen.get(message.id) ?? Date.now()))}`
			: `Worked for ${formatDurationMs(message.durationMs ?? 0)}`;
		const chevron = append(header, document.createElement('span'));
		chevron.className = `codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`;
		chevron.setAttribute('aria-hidden', 'true');
		header.addEventListener('click', () => {
			this.workExpandOverride.set(message.id, !expanded);
			this.render();
		});

		const stepsList = append(block, document.createElement('div'));
		stepsList.className = 'conversation-work-steps';
		stepsList.hidden = !expanded;
		(message.steps ?? []).forEach((step, index) => {
			stepsList.appendChild(this.createWorkStepRow(`${message.id}:${index}`, step));
		});

		return block;
	}

	/** "⏱ Thought for a few seconds" / "🔧 read_file src/a.ts · 2s" — tool steps expand to their output. */
	private createWorkStepRow(key: string, step: ISessionWorkStep): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = `conversation-work-step ${step.kind}`;

		const row = append(wrapper, document.createElement(step.detail ? 'button' : 'div')) as HTMLElement;
		row.className = 'conversation-work-step-row';
		if (row instanceof HTMLButtonElement) {
			row.type = 'button';
		}

		const icon = append(row, document.createElement('span'));
		icon.className = `codicon ${step.kind === 'thinking' ? 'codicon-history' : 'codicon-tools'}`;
		icon.setAttribute('aria-hidden', 'true');

		const label = append(row, document.createElement('span'));
		label.className = 'conversation-work-step-label';
		if (step.kind === 'thinking') {
			label.textContent = `Thought for ${thinkingDurationText(step.durationMs)}`;
		} else {
			label.textContent = step.label;
			const duration = append(row, document.createElement('span'));
			duration.className = 'conversation-work-step-duration';
			duration.textContent = formatDurationMs(step.durationMs);
		}

		if (step.detail) {
			const open = this.stepExpand.has(key);
			row.setAttribute('aria-expanded', String(open));
			const chevron = append(row, document.createElement('span'));
			chevron.className = `codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} conversation-work-step-chevron`;
			chevron.setAttribute('aria-hidden', 'true');
			row.addEventListener('click', () => {
				if (this.stepExpand.has(key)) {
					this.stepExpand.delete(key);
				} else {
					this.stepExpand.add(key);
				}
				this.render();
			});
			if (open) {
				const detail = append(wrapper, document.createElement('pre'));
				detail.className = 'conversation-work-step-detail';
				detail.textContent = step.detail;
			}
		}

		return wrapper;
	}

	private updateWorkTicker(hasLiveWork: boolean): void {
		if (hasLiveWork && this.workTicker === undefined) {
			// The header shows elapsed seconds; deltas already re-render constantly,
			// the ticker only covers quiet stretches (thinking, long tool calls).
			this.workTicker = setInterval(() => this.render(), 1000);
		} else if (!hasLiveWork && this.workTicker !== undefined) {
			clearInterval(this.workTicker);
			this.workTicker = undefined;
		}
	}

	override dispose(): void {
		if (this.workTicker !== undefined) {
			clearInterval(this.workTicker);
			this.workTicker = undefined;
		}
		super.dispose();
	}

	/**
	 * The ring next to the model picker shows how much of the selected model's
	 * context window this conversation roughly occupies (~4 chars per token).
	 * Exact numbers live in the tooltip.
	 */
	private updateContextRing(): void {
		const fill = this.contextRing.querySelector<SVGCircleElement>('.ring-fill');
		if (!fill) {
			return;
		}

		const messages = this.session?.messages.get() ?? [];
		const chars = messages.reduce((sum, message) => sum + message.text.length, 0);
		const tokens = Math.ceil(chars / 4);
		const contextLength = this.modelsService?.selectedModel.get()?.contextLength;
		const ratio = contextLength ? Math.min(1, tokens / contextLength) : 0;

		fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
		this.contextRing.dataset.level = ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
		this.contextRing.title = contextLength
			? `Context: ~${formatTokens(tokens)} of ${formatTokens(contextLength)} tokens used (${Math.round(ratio * 100)}%)`
			: `Context: ~${formatTokens(tokens)} tokens used (window size unknown)`;
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
		spinner.className = 'codicon codicon-loading codicon-modifier-spin';
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
		// Sending returns the reader to the live end of the conversation.
		this.scrollToBottomOnRender = true;

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

/** The gate paused on a mutating tool: say what it wants and offer Allow / Deny. */
function createApprovalCard(approval: ISessionPendingApproval): HTMLElement {
	const card = document.createElement('div');
	card.className = 'conversation-approval';
	card.setAttribute('role', 'alertdialog');
	card.setAttribute('aria-label', 'Approval required');

	const header = append(card, document.createElement('div'));
	header.className = 'conversation-approval-header';
	appendCodicon(header, 'codicon-shield');
	const title = append(header, document.createElement('span'));
	title.textContent = approval.toolName === 'bash' ? 'Run this command?' : 'Apply this change?';

	const detail = append(card, document.createElement('code'));
	detail.className = 'conversation-approval-detail';
	detail.textContent = approval.detail;

	const actions = append(card, document.createElement('div'));
	actions.className = 'conversation-approval-actions';

	const allow = append(actions, document.createElement('button')) as HTMLButtonElement;
	allow.className = 'conversation-approval-allow';
	allow.type = 'button';
	allow.textContent = 'Allow';
	allow.addEventListener('click', () => approval.respond(true));

	const deny = append(actions, document.createElement('button')) as HTMLButtonElement;
	deny.className = 'conversation-approval-deny';
	deny.type = 'button';
	deny.textContent = 'Deny';
	deny.addEventListener('click', () => approval.respond(false));

	return card;
}

function appendCodicon(parent: HTMLElement, codicon: string): HTMLElement {
	const icon = append(parent, document.createElement('span'));
	icon.className = `codicon ${codicon}`;
	icon.setAttribute('aria-hidden', 'true');
	return icon;
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function createContextRing(): HTMLElement {
	const ring = document.createElement('span');
	ring.className = 'conversation-context-ring';
	ring.dataset.level = 'ok';
	ring.innerHTML =
		'<svg viewBox="0 0 16 16" aria-hidden="true">' +
		`<circle class="ring-track" cx="8" cy="8" r="${RING_RADIUS}"></circle>` +
		`<circle class="ring-fill" cx="8" cy="8" r="${RING_RADIUS}" transform="rotate(-90 8 8)" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"></circle>` +
		'</svg>';
	return ring;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}K`;
	}

	return String(tokens);
}

function createMessageRow(message: ISessionMessage): HTMLElement {
	const row = document.createElement('article');
	row.className = `conversation-message ${message.role}`;
	row.dataset.role = message.role;

	// Assistant messages render as plain text — no avatar, no author label.
	if (message.role !== 'assistant') {
		const avatar = append(row, document.createElement('div'));
		avatar.className = 'conversation-message-avatar';
		const icon = append(avatar, document.createElement('span'));
		icon.className = `codicon ${messageIcon(message.role)}`;
		icon.setAttribute('aria-hidden', 'true');
	}

	const body = append(row, document.createElement('div'));
	body.className = 'conversation-message-body';

	if (message.role !== 'assistant') {
		const label = append(body, document.createElement('div'));
		label.className = 'conversation-message-label';
		label.textContent = messageLabel(message.role);
	}

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
		case 'work':
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
		case 'work':
			return 'Tool';
	}
}

function formatDurationMs(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function thinkingDurationText(ms: number): string {
	return ms < 10_000 ? 'a few seconds' : formatDurationMs(ms);
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
