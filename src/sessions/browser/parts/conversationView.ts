/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { IActiveSession, ISession, ISessionAttachment, ISessionMessage, ISessionPendingApproval, ISessionWorkStep } from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus, estimateSessionTokens } from '../../services/sessions/common/session.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import { installSlashCommands, TEMPLATE_COMMANDS, type IComposerCommand } from './composerCommands.js';
import { installImageAttachments, type IImageController } from './composerImages.js';
import { installFileMentions, installSessionMentions, installSkillMentions, type IMentionController } from './composerMentions.js';
import { ConversationContext } from './conversationContext.js';
import { renderMarkdown } from './markdownRenderer.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';
import { permissionMode } from '../../services/agent/browser/permissionModeService.js';
import type { PermissionMode } from '../../services/agent/common/agent.js';
import { toDisposable } from '../../base/common/lifecycle.js';

export interface ISessionMessageSender {
	sendMessage(sessionId: string, query: string, options?: { readonly attachments?: readonly ISessionAttachment[]; readonly images?: readonly IPendingImage[] }): Promise<unknown>;
	stopSession(sessionId: string): Promise<unknown>;
	setSessionPermissionMode?(sessionId: string, mode: PermissionMode): Promise<unknown>;
	setMessageFeedback?(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<unknown>;
	forkSession?(sessionId: string, messageId: string): Promise<unknown>;
	/** Data URL for a stored image attachment, for thumbnails in the transcript. */
	resolveMedia?(sessionId: string, path: string): Promise<string | undefined>;
	/** All sessions, for the #-mention picker (sessionsService satisfies this structurally). */
	getSessions?(): readonly ISession[];
}

export class ConversationView extends Disposable {
	readonly element: HTMLElement;

	private readonly transcript: HTMLElement;
	private readonly timeline: HTMLElement;
	private timelinePreview: HTMLElement | undefined;
	// Which tick a rail scrub is previewing, and the turn each tick maps to.
	private previewTick: HTMLElement | undefined;
	private readonly tickTurns = new Map<HTMLElement, { user?: ISessionMessage; work?: ISessionMessage; assistant?: ISessionMessage }>();
	private readonly composer: HTMLFormElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly sendError: HTMLElement;
	private readonly reconnectStatus: HTMLElement;
	private readonly reconnectLabel: HTMLElement;
	private readonly contextRing: HTMLElement;
	private readonly header = this._register(new ConversationContext());
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;
	private isSending = false;
	private isStopping = false;
	// A follow-up typed while a run is live is held here and sent when it settles,
	// so a second run never overlaps the first (single slot; a newer one replaces it).
	private queuedFollowUp: string | undefined;
	// Work blocks: user toggles override the default (open while live, closed when done).
	private readonly workExpandOverride = new Map<string, boolean>();
	// Individually expanded tool steps ("messageId:index").
	private readonly stepExpand = new Set<string>();
	private scrollToBottomOnRender = false;
	// Fan-out for the session-aware permission picker (the underlying observable
	// swaps whenever another session becomes active).
	private readonly permissionListeners = new Set<() => void>();
	// Live elapsed time is measured from when the block first appeared in this view.
	private readonly workFirstSeen = new Map<string, number>();
	private workTicker: ReturnType<typeof setInterval> | undefined;
	// Rendered rows keyed by message id, so a streaming delta patches only the
	// row that actually changed instead of tearing down the whole transcript —
	// rebuilding every row on every token would restart hover-revealed UI (e.g.
	// the message action bar's fade-in) on unrelated, unchanged messages too.
	private readonly renderedRows = new Map<string, { element: HTMLElement; message: ISessionMessage }>();

	private readonly mentions: IMentionController;
	private readonly skillMentions: IMentionController;
	private readonly sessionMentions: IMentionController;
	private readonly images: IImageController;

	constructor(
		private readonly messageSender?: ISessionMessageSender,
		private readonly modelsService?: IModelsService,
		private readonly projectsService?: IProjectsService,
		private readonly skillsService?: ISkillsService,
	) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'conversation-view';

		const bodyWrap = append(this.element, document.createElement('div'));
		bodyWrap.className = 'conversation-body';

		this.timeline = append(bodyWrap, document.createElement('div'));
		this.timeline.className = 'conversation-timeline';
		this.timeline.setAttribute('role', 'navigation');
		this.timeline.setAttribute('aria-label', 'Conversation timeline');

		this.transcript = append(bodyWrap, document.createElement('div'));
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
		this.input.placeholder = 'Ask Mellivora';
		this.input.spellcheck = true;

		// Installed before _registerEventListeners so a mention-picking Enter
		// runs ahead of (and suppresses) the Enter-to-send handler.
		this.mentions = this._register(
			installFileMentions({
				host: this.element,
				input: this.input,
				loadPaths: () => {
					const projectId = this.session?.projectId;
					return projectId && this.projectsService ? this.projectsService.listProjectFiles(projectId) : undefined;
				},
			}),
		);
		this.skillMentions = this._register(
			installSkillMentions({
				host: this.element,
				input: this.input,
				getSkills: () => this.skillsService?.skills.get() ?? [],
			}),
		);
		this.sessionMentions = this._register(
			installSessionMentions({
				host: this.element,
				input: this.input,
				getSessions: () => listReferencableSessions(this.messageSender?.getSessions?.() ?? [], this.session?.sessionId),
			}),
		);
		this.images = this._register(installImageAttachments({ input: this.input, dropTarget: this.composer, onDidChange: () => this.updateComposerState() }));

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
		// Menu hosted on the view root — the composer clips overflow. The picker
		// reads and writes the ACTIVE session's mode (global default as fallback).
		this._register(
			installPermissionPicker(
				{ host: this.element, trigger: access, label: accessLabel, icon: accessIcon },
				{
					get: () => this.session?.permissionMode.get() ?? permissionMode.get(),
					set: mode => {
						const session = this.session;
						if (session) {
							void this.messageSender?.setSessionPermissionMode?.(session.sessionId, mode);
						} else {
							permissionMode.set(mode);
						}
					},
					subscribe: listener => {
						this.permissionListeners.add(listener);
						return toDisposable(() => this.permissionListeners.delete(listener));
					},
				},
			),
		);

		// Backed by the harness's stream_retry events — hidden unless a retry is live.
		this.reconnectStatus = append(leftControls, document.createElement('div'));
		this.reconnectStatus.className = 'conversation-reconnect-status';
		this.reconnectStatus.setAttribute('aria-live', 'polite');
		this.reconnectStatus.hidden = true;
		appendCodicon(this.reconnectStatus, 'codicon-loading codicon-modifier-spin');
		this.reconnectLabel = append(this.reconnectStatus, document.createElement('span'));

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

		// Registered after the pickers exist (their triggers back the action
		// commands) but before _registerEventListeners, so a command-picking
		// Enter never also sends. Availability is evaluated at open time.
		this._register(
			installSlashCommands({
				host: this.element,
				input: this.input,
				getCommands: (): IComposerCommand[] => {
					const session = this.session;
					const lastMessage = session?.messages.get().at(-1);
					return [
						{ name: 'model', kind: 'action', description: 'Pick the model', run: () => model.click() },
						{ name: 'permission', kind: 'action', description: 'Pick the approval mode', run: () => access.click() },
						...(session && lastMessage && this.messageSender?.forkSession
							? [{ name: 'fork', kind: 'action' as const, description: 'Fork this conversation from its latest message', run: () => void this.messageSender!.forkSession!(session.sessionId, lastMessage.id) }]
							: []),
						...(session?.status.get() === SessionStatus.InProgress ? [{ name: 'stop', kind: 'action' as const, description: 'Stop the current run', run: () => void this.stop() }] : []),
						...TEMPLATE_COMMANDS,
					];
				},
			}),
		);

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
		// Row identities belong to the session that produced them — a fresh
		// session gets a clean slate rather than reusing stale nodes.
		clearNode(this.transcript);
		this.renderedRows.clear();
		this.header.openSession(session);
		this.setSendError(undefined);
		this.queuedFollowUp = undefined;
		// Mentions and pending images belong to the session they were staged in.
		this.mentions.reset();
		this.skillMentions.reset();
		this.sessionMentions.reset();
		this.images.reset();
		// A freshly opened conversation starts at its latest message.
		this.scrollToBottomOnRender = true;

		if (session) {
			this.sessionDisposables.add(session.messages.subscribe(() => this.render()));
			this.sessionDisposables.add(session.interactivity.subscribe(() => this.render()));
			this.sessionDisposables.add(
				session.status.subscribe(() => {
					this.render();
					this.flushQueuedFollowUp();
				}),
			);
			this.sessionDisposables.add(session.pendingApproval.subscribe(() => this.render()));
			this.sessionDisposables.add(session.reconnect.subscribe(() => this.updateReconnectStatus()));
			this.sessionDisposables.add(session.permissionMode.subscribe(() => this.notifyPermissionListeners()));
			this.sessionDisposables.add(session.contextUsage.subscribe(() => this.updateContextRing()));
		}
		this.updateReconnectStatus();
		this.notifyPermissionListeners();

		this.render();
	}

	focus(): void {
		if (!this.input.disabled) {
			this.input.focus();
			return;
		}

		this.element.focus();
	}

	private buildMessageActions(message: ISessionMessage): IMessageActions | undefined {
		const session = this.session;
		if (!session || (message.role !== 'assistant' && message.role !== 'user')) {
			return undefined;
		}
		const sender = this.messageSender;
		return {
			copy: () => void navigator.clipboard.writeText(message.text),
			...(message.role === 'assistant' && sender?.setMessageFeedback
				? {
						feedback: (value: 'like' | 'dislike') => {
							// Clicking the active choice clears it.
							void sender.setMessageFeedback!(session.sessionId, message.id, message.feedback === value ? undefined : value);
						},
					}
				: {}),
			...(sender?.forkSession ? { fork: () => void sender.forkSession!(session.sessionId, message.id) } : {}),
		};
	}

	/** Path → data URL for image attachments in the transcript; undefined when the sender can't resolve media. */
	private buildImageResolver(): ((path: string) => Promise<string | undefined>) | undefined {
		const sessionId = this.session?.sessionId;
		const resolve = this.messageSender?.resolveMedia?.bind(this.messageSender);
		return sessionId && resolve ? path => resolve(sessionId, path) : undefined;
	}

	private notifyPermissionListeners(): void {
		for (const listener of this.permissionListeners) {
			listener();
		}
	}

	private updateReconnectStatus(): void {
		const reconnect = this.session?.reconnect.get();
		this.reconnectStatus.hidden = !reconnect;
		this.reconnectLabel.textContent = reconnect ? `Reconnecting… ${reconnect.attempt}/${reconnect.maxAttempts}` : '';
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

		// Dock-style magnification follows the pointer along the rail. The
		// pointer position is re-read at frame time so a leave between the move
		// and its animation frame cannot resurrect the magnification.
		let magnifyPointerY: number | undefined;
		let magnifyScheduled = false;
		this.timeline.addEventListener('mousemove', event => {
			magnifyPointerY = event.clientY;
			if (magnifyScheduled) {
				return;
			}
			magnifyScheduled = true;
			requestAnimationFrame(() => {
				magnifyScheduled = false;
				this.magnifyTicks(magnifyPointerY);
			});
		});
		this.timeline.addEventListener('mouseleave', () => {
			magnifyPointerY = undefined;
			this.magnifyTicks(undefined);
		});

		// Keep the timeline's position marker in sync with the reading position.
		let scrollScheduled = false;
		this.transcript.addEventListener('scroll', () => {
			if (scrollScheduled) {
				return;
			}
			scrollScheduled = true;
			requestAnimationFrame(() => {
				scrollScheduled = false;
				this.updateTimelineCurrent();
			});
		});
	}

	private render(): void {
		this.element.classList.toggle('empty', !this.session);
		this.element.dataset.status = this.session ? conversationStatusId(this.session.status.get()) : 'empty';
		this.element.dataset.interactivity = this.session?.interactivity.get() ?? 'none';
		this.header.element.hidden = !this.session;

		// A structural change (new/removed row) can move scrollTop; a pure content
		// patch never does. Follow the output while the reader is at (or near) the
		// bottom; preserve their position otherwise.
		const stickToBottom = this.scrollToBottomOnRender || this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 48;
		const previousScrollTop = this.transcript.scrollTop;
		this.scrollToBottomOnRender = false;

		const messages = this.session?.messages.get() ?? [];
		this.reconcileTranscript(messages);

		const hasLiveWork = messages.some(message => message.role === 'work' && message.durationMs === undefined);
		const approval = this.session?.pendingApproval.get();
		// These trailing rows aren't part of the keyed reconciliation above (they
		// aren't backed by a message id) — always re-evaluate them.
		this.transcript.querySelector('.conversation-approval')?.remove();
		this.transcript.querySelector('.conversation-working-row')?.remove();
		this.transcript.querySelector('.conversation-thinking-row')?.remove();
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
		this.renderTimeline(messages);
		this.updateComposerState();
		this.updateContextRing();
	}

	/**
	 * Keyed diff against {@link renderedRows}: a row is created once and then
	 * patched in place for as long as its message id survives. This is what
	 * keeps hover-revealed UI (the message action bar's fade-in, a work step's
	 * expanded detail) from restarting on every streamed token — only the row
	 * whose content actually changed gets touched; every other row, including
	 * ones the reader is currently hovering, is left completely alone.
	 */
	private reconcileTranscript(messages: readonly ISessionMessage[]): void {
		if (messages.length === 0) {
			if (this.renderedRows.size > 0) {
				clearNode(this.transcript);
				this.renderedRows.clear();
			}
			if (!this.transcript.querySelector('.conversation-empty')) {
				const empty = append(this.transcript, document.createElement('div'));
				empty.className = 'conversation-empty';
				empty.textContent = this.session ? 'No messages yet' : 'No session selected';
			}
			return;
		}
		this.transcript.querySelector('.conversation-empty')?.remove();

		const seen = new Set<string>();
		let cursor: ChildNode | null = this.transcript.firstChild;

		for (const message of messages) {
			seen.add(message.id);
			const existing = this.renderedRows.get(message.id);

			let element: HTMLElement;
			if (existing) {
				element = existing.element;
				if (message.role === 'work') {
					// A work block's rendering also depends on state outside the
					// message itself — the expand-override and per-step detail toggles
					// (both set by clicks, not by a new message object) and the live
					// ticker — so it always resyncs. Cheap, and work steps have no
					// hover-fade UI to protect (unlike the message action bar below).
					this.patchWorkBlock(element, message);
				} else if (existing.message !== message) {
					this.patchRow(element, message);
				}
				existing.message = message;
			} else {
				element = message.role === 'work' ? this.createWorkBlock(message) : createMessageRow(message, this.buildMessageActions(message), this.buildImageResolver());
				this.renderedRows.set(message.id, { element, message });
			}

			if (element === cursor) {
				cursor = cursor.nextSibling;
			} else {
				this.transcript.insertBefore(element, cursor);
			}
		}

		for (const [id, entry] of this.renderedRows) {
			if (!seen.has(id)) {
				entry.element.remove();
				this.renderedRows.delete(id);
			}
		}
	}

	/** Patch an existing user/assistant/tool row's dynamic content in place — never recreate it. Work blocks go through patchWorkBlock instead (see reconcileTranscript). */
	private patchRow(element: HTMLElement, message: ISessionMessage): void {
		const textEl = element.querySelector<HTMLElement>('.conversation-message-bubble, .conversation-message-text');
		if (textEl) {
			if (message.role === 'assistant') {
				clearNode(textEl);
				textEl.appendChild(renderMarkdown(message.text));
			} else {
				textEl.textContent = message.text;
			}
		}

		let detailEl = element.querySelector<HTMLElement>('.conversation-tool-detail');
		if (message.detail) {
			if (!detailEl) {
				detailEl = document.createElement('div');
				detailEl.className = 'conversation-tool-detail';
				element.querySelector('.conversation-message-body')?.appendChild(detailEl);
			}
			detailEl.textContent = message.detail;
		} else {
			detailEl?.remove();
		}

		setFeedbackButtonState(element.querySelector('[data-feedback="like"]'), 'like', message.feedback);
		setFeedbackButtonState(element.querySelector('[data-feedback="dislike"]'), 'dislike', message.feedback);
	}

	/** Rebuild a work block's step list and refresh its header (title, spinner, expand state). */
	private patchWorkBlock(block: HTMLElement, message: ISessionMessage): void {
		this.updateWorkBlockHeader(block, message);

		const stepsList = block.querySelector<HTMLElement>('.conversation-work-steps');
		if (!stepsList) {
			return;
		}
		clearNode(stepsList);
		(message.steps ?? []).forEach((step, index) => {
			stepsList.appendChild(this.createWorkStepRow(`${message.id}:${index}`, step));
		});
	}

	/** The only place that decides a work block's title text, spinner, and expand state — called on real content changes and on the once-a-second live tick alike. */
	private updateWorkBlockHeader(block: HTMLElement, message: ISessionMessage): void {
		const live = message.durationMs === undefined;
		if (live && !this.workFirstSeen.has(message.id)) {
			this.workFirstSeen.set(message.id, Date.now());
		}
		const expanded = this.workExpandOverride.get(message.id) ?? live;

		block.classList.toggle('live', live);

		const header = block.querySelector<HTMLElement>('.conversation-work-header');
		const title = block.querySelector<HTMLElement>('.conversation-work-title');
		if (title) {
			title.textContent = live
				? `Working for ${formatDurationMs(Date.now() - (this.workFirstSeen.get(message.id) ?? Date.now()))}`
				: `Worked for ${formatDurationMs(message.durationMs ?? 0)}`;
		}
		if (header) {
			header.setAttribute('aria-expanded', String(expanded));
			const hasSpinner = header.querySelector('.codicon-loading') !== null;
			if (live && !hasSpinner) {
				const spinner = document.createElement('span');
				spinner.className = 'codicon codicon-loading codicon-modifier-spin';
				spinner.setAttribute('aria-hidden', 'true');
				header.insertBefore(spinner, header.firstChild);
			} else if (!live && hasSpinner) {
				header.querySelector('.codicon-loading')?.remove();
			}
		}
		const chevron = block.querySelector<HTMLElement>('.conversation-work-header > .codicon-chevron-down, .conversation-work-header > .codicon-chevron-right');
		if (chevron) {
			chevron.className = `codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`;
		}
		const stepsList = block.querySelector<HTMLElement>('.conversation-work-steps');
		if (stepsList) {
			stepsList.hidden = !expanded;
		}
	}

	/**
	 * The rail on the left maps the whole conversation: ONE tick per turn
	 * (a user message plus everything up to the next one — work, reply).
	 * Hovering previews the turn (question, answer excerpt, files touched),
	 * moving the pointer magnifies nearby ticks dock-style, clicking jumps
	 * to the turn's start.
	 */
	private renderTimeline(messages: readonly ISessionMessage[]): void {
		clearNode(this.timeline);
		this.closeTimelinePreview();
		this.previewTick = undefined;
		this.tickTurns.clear();

		interface ITurn {
			user?: ISessionMessage;
			work?: ISessionMessage;
			assistant?: ISessionMessage;
			blocks: ISessionMessage[];
		}
		const turns: ITurn[] = [];
		for (const message of messages) {
			if (message.role === 'tool') {
				continue;
			}
			if (message.role === 'user' || turns.length === 0) {
				turns.push({ blocks: [] });
			}
			const turn = turns[turns.length - 1]!;
			turn.blocks.push(message);
			if (message.role === 'user') {
				turn.user = message;
			} else if (message.role === 'work') {
				turn.work = message;
			} else if (message.role === 'assistant') {
				turn.assistant = message;
			}
		}

		this.timeline.classList.toggle('empty', turns.length < 2);

		for (const turn of turns) {
			const firstBlock = turn.blocks[0]!;
			const tick = append(this.timeline, document.createElement('button')) as HTMLButtonElement;
			tick.className = 'conversation-timeline-tick';
			tick.type = 'button';
			tick.dataset.targetId = firstBlock.id;
			// The turn's member ids, so the scroll marker can map any visible
			// message back to its tick.
			tick.dataset.blockIds = turn.blocks.map(block => block.id).join(' ');
			tick.setAttribute('aria-label', 'Jump to turn');
			tick.addEventListener('click', () => {
				this.transcript.querySelector(`[data-message-id="${firstBlock.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			});
			// Preview is driven by rail proximity (see magnifyTicks), not by
			// hovering the 2px-tall tick itself — that was near impossible to hit.
			this.tickTurns.set(tick, turn);
		}

		this.updateTimelineCurrent();
	}

	/**
	 * Dock-style magnification driven by pointer proximity, plus the scrub
	 * preview: the tick nearest the pointer previews its turn. Relaxes on leave.
	 */
	private magnifyTicks(pointerY: number | undefined): void {
		// A bit above the tick spacing (~12px) so the nearest tick clearly leads
		// while its immediate neighbour still tapers — wider reads as a sticky blob.
		const radius = 22;
		if (pointerY === undefined) {
			for (const tick of this.timeline.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
				tick.style.transform = '';
				tick.style.background = '';
			}
			this.previewTick = undefined;
			this.closeTimelinePreview();
			return;
		}

		let nearest: HTMLElement | undefined;
		let nearestDistance = Infinity;
		for (const tick of this.timeline.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
			const rect = tick.getBoundingClientRect();
			const distance = Math.abs(pointerY - (rect.top + rect.height / 2));
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = tick;
			}
			const factor = Math.max(0, 1 - distance / radius);
			// Length only — thickness stays constant.
			tick.style.transform = factor > 0 ? `scaleX(${1 + factor * 3.5})` : '';
			// Ticks within reach also brighten toward the pointer (22% at the
			// edge of the radius up to ~90% under it).
			tick.style.background = factor > 0 ? `color-mix(in srgb, var(--vscode-agents-color-text-primary) ${Math.round(22 + factor * 68)}%, transparent)` : '';
		}

		// Scrubbing the rail previews the nearest turn; only rebuild on change.
		if (nearest && nearest !== this.previewTick) {
			this.previewTick = nearest;
			const turn = this.tickTurns.get(nearest);
			if (turn) {
				this.openTimelinePreview(nearest, turn);
			}
		}
	}

	/** Highlight the tick for the message at the top of the viewport. */
	private updateTimelineCurrent(): void {
		const rows = this.transcript.querySelectorAll<HTMLElement>('[data-message-id]');
		let currentId: string | undefined;
		const atBottom = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 8;
		if (atBottom && rows.length > 0) {
			// Reading the live end — the last message is current.
			currentId = rows[rows.length - 1]!.dataset.messageId;
		} else {
			const anchor = this.transcript.scrollTop + 48;
			for (const row of rows) {
				if (row.offsetTop <= anchor) {
					currentId = row.dataset.messageId;
				} else {
					break;
				}
			}
		}
		for (const tick of this.timeline.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
			tick.classList.toggle('current', currentId !== undefined && (tick.dataset.blockIds ?? '').split(' ').includes(currentId));
		}
	}

	/** One card per turn: the question as title, the reply excerpt, files touched. */
	private openTimelinePreview(tick: HTMLElement, turn: { user?: ISessionMessage; work?: ISessionMessage; assistant?: ISessionMessage }): void {
		this.closeTimelinePreview();

		const card = document.createElement('div');
		card.className = 'conversation-timeline-preview';

		if (turn.user) {
			const title = append(card, document.createElement('div'));
			title.className = 'conversation-timeline-preview-title';
			title.textContent = turn.user.text;
		}

		const excerpt = append(card, document.createElement('div'));
		excerpt.className = 'conversation-timeline-preview-text';
		excerpt.textContent = turn.assistant ? turn.assistant.text.slice(0, 240) : 'Working…';

		const files = extractWorkFiles(turn.work);
		if (files.length > 0) {
			const chips = append(card, document.createElement('div'));
			chips.className = 'conversation-timeline-preview-files';
			for (const file of files.slice(0, 3)) {
				const chip = append(chips, document.createElement('span'));
				chip.className = 'conversation-timeline-preview-file';
				const icon = append(chip, document.createElement('span'));
				icon.className = 'codicon codicon-code';
				icon.setAttribute('aria-hidden', 'true');
				const name = append(chip, document.createElement('span'));
				name.className = 'conversation-timeline-preview-file-name';
				name.textContent = file;
			}
			if (files.length > 3) {
				const more = append(chips, document.createElement('span'));
				more.className = 'conversation-timeline-preview-file';
				more.textContent = `+${files.length - 3}`;
			}
		}

		this.element.appendChild(card);
		const viewRect = this.element.getBoundingClientRect();
		const tickRect = tick.getBoundingClientRect();
		const top = Math.min(Math.max(8, tickRect.top - viewRect.top - 12), this.element.clientHeight - card.offsetHeight - 8);
		card.style.top = `${top}px`;
		card.style.left = `${this.timeline.offsetWidth + 6}px`;
		this.timelinePreview = card;
	}

	private closeTimelinePreview(): void {
		this.timelinePreview?.remove();
		this.timelinePreview = undefined;
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
		block.dataset.messageId = message.id;

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
		// Reads aria-expanded fresh at click time, not the `expanded` captured
		// above — this header element persists across patches (updateWorkBlockHeader
		// keeps aria-expanded current), so a stale closure would toggle the wrong way.
		header.addEventListener('click', () => {
			const isExpanded = header.getAttribute('aria-expanded') === 'true';
			this.workExpandOverride.set(message.id, !isExpanded);
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
	 * The ring beside the model picker shows how much of the selected model's
	 * context window this conversation occupies. Prefers the provider's real
	 * token count from the most recent request (`session.contextUsage`); falls
	 * back to a ~4-chars-per-token estimate until the first reading arrives (or
	 * for providers that don't report usage). Hovering it reveals a two-line
	 * popover with the exact reading — "Context window: / N% used (M% left)".
	 * Hidden until a window size is known (nothing to be a percentage of).
	 */
	private updateContextRing(): void {
		const fill = this.contextRing.querySelector<SVGCircleElement>('.ring-fill');
		const value = this.contextRing.querySelector<HTMLElement>('.conversation-context-popover-value');
		const breakdownList = this.contextRing.querySelector<HTMLElement>('.conversation-context-breakdown');
		const footnote = this.contextRing.querySelector<HTMLElement>('.conversation-context-popover-footnote');
		if (!fill || !value || !breakdownList || !footnote) {
			return;
		}

		const contextLength = this.modelsService?.selectedModel.get()?.contextLength;
		if (!contextLength) {
			this.contextRing.hidden = true;
			return;
		}

		const usage = this.session?.contextUsage.get();
		// `usage.inputTokens` is already the best number the provider has — a
		// char/4 estimate before the first real reading lands in this process,
		// the real total after. `isRealTotal` is the ONLY thing that changes;
		// when contextUsage hasn't been touched at all yet, fall back the same
		// way the provider itself would (same formula, so the two never drift).
		const tokens = usage ? usage.inputTokens : estimateSessionTokens(this.session?.messages.get() ?? []);
		const isRealTotal = usage?.isRealTotal ?? false;
		const ratio = Math.min(1, tokens / contextLength);
		const usedPct = Math.round(ratio * 100);

		this.contextRing.hidden = false;
		this.contextRing.dataset.level = ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
		fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
		// A char/4 reading never survives a restart, and a run's first turn
		// reports one too (its context_breakdown event arrives before the model
		// has replied — there is no real count yet to show). The aria-label
		// always disclosed this; say it where sighted users can see it too,
		// otherwise a plausible percentage with no breakdown below it reads as
		// broken rather than as "no fresh data yet".
		value.textContent = `${usedPct}% used (${100 - usedPct}% left)${isRealTotal ? '' : ' (estimated)'}`;
		this.contextRing.setAttribute(
			'aria-label',
			`Context window: ${usedPct}% used, ~${formatTokens(tokens)} of ${formatTokens(contextLength)} tokens${isRealTotal ? '' : ' (estimated)'}`,
		);

		// The breakdown can populate BEFORE the total is real — a run's first
		// context_breakdown event fires ahead of its usage event, so the panel
		// shows the mechanisms working live even before the model has replied.
		// Free reuses the SAME `tokens` the ring itself is drawn from, so the
		// header percentage and "how much is left" never disagree with each
		// other — true whether that shared number is real or still an estimate.
		breakdownList.replaceChildren();
		const breakdown = usage?.breakdown;
		if (breakdown) {
			breakdownList.append(createBreakdownRow('System prompt', formatBreakdownEntry(breakdown.systemChars, contextLength)));
			breakdownList.append(createBreakdownRow('Project instructions', formatBreakdownEntry(breakdown.instructionsChars, contextLength)));
			breakdownList.append(createBreakdownRow('Skills', formatBreakdownEntry(breakdown.skillsChars, contextLength)));
			breakdownList.append(createBreakdownRow('Tools', formatBreakdownEntry(breakdown.toolsChars, contextLength)));
			if (breakdown.compactedChars > 0) {
				breakdownList.append(createBreakdownRow('Compacted summary', formatBreakdownEntry(breakdown.compactedChars, contextLength)));
			}
			breakdownList.append(createBreakdownRow('Messages', formatBreakdownEntry(breakdown.messagesChars, contextLength)));
			breakdownList.append(createBreakdownRow('Free', formatTokensWithPct(Math.max(0, contextLength - tokens), contextLength)));
		}
		footnote.textContent = isRealTotal ? 'Estimated by category · total is real' : 'All figures estimated — waiting for the model’s real count';
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
		const hasContent = hasText || this.images.hasImages();

		this.composer.hidden = interactivity === SessionInteractivity.Hidden;
		this.composer.classList.toggle('running', isRunning);
		this.composer.classList.toggle('idle', !isRunning);
		this.composer.dataset.state = isRunning ? 'running' : 'idle';
		this.input.disabled = !canType;
		this.sendButton.disabled = !canType || !hasContent;
		this.sendButton.hidden = isRunning;
		this.stopButton.hidden = !isRunning;
		this.input.placeholder = isRunning
			? this.queuedFollowUp
				? `Queued: ${this.queuedFollowUp}`
				: 'Working… your next message will be queued'
			: interactivity === SessionInteractivity.ReadOnly
				? 'Session is read-only'
				: 'Ask Mellivora, @ for files, / for commands, $ for skills, # for conversations';
	}

	/** Send a queued follow-up once the current run has settled. */
	private flushQueuedFollowUp(): void {
		const query = this.queuedFollowUp;
		if (query === undefined || this.isSending || !this.session || this.session.status.get() === SessionStatus.InProgress) {
			return;
		}
		this.queuedFollowUp = undefined;
		this.input.value = query;
		void this.send();
	}

	private async send(): Promise<void> {
		const query = this.input.value.trim();
		const session = this.session;
		if ((!query && !this.images.hasImages()) || !session || this.isSending || session.interactivity.get() !== SessionInteractivity.Full) {
			return;
		}

		// Never start a second run on top of a live one — hold the follow-up and
		// send it when the run settles (see flushQueuedFollowUp).
		if (session.status.get() === SessionStatus.InProgress) {
			this.queuedFollowUp = query;
			this.input.value = '';
			this.updateComposerState();
			return;
		}

		this.isSending = true;
		this.setSendError(undefined);
		this.updateComposerState();
		// Sending returns the reader to the live end of the conversation.
		this.scrollToBottomOnRender = true;

		try {
			const attachments = [...this.mentions.collectAttachments(query), ...this.skillMentions.collectAttachments(query), ...this.sessionMentions.collectAttachments(query)];
			const images = this.images.getImages();
			await this.messageSender?.sendMessage(session.sessionId, query, {
				...(attachments.length > 0 ? { attachments } : {}),
				...(images.length > 0 ? { images } : {}),
			});
			this.input.value = '';
			this.mentions.reset();
			this.skillMentions.reset();
			this.sessionMentions.reset();
			this.images.reset();
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

/** The #-picker's entries: other sessions, newest first, capped. */
export function listReferencableSessions(sessions: readonly ISession[], currentSessionId: string | undefined, limit: number = 50): { id: string; name: string; description: string }[] {
	return sessions
		.filter(session => session.sessionId !== currentSessionId && !session.isArchived.get())
		.sort((a, b) => b.updatedAt.get().getTime() - a.updatedAt.get().getTime())
		.slice(0, limit)
		.map(session => ({ id: session.sessionId, name: session.title.get(), description: session.updatedAt.get().toLocaleDateString() }));
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
	// A small ring (fill = % of the context window used) that reveals a hover
	// popover: the exact reading up top ("Context window: / N% used (M% left)"),
	// then a per-category breakdown of what the next request would send.
	// Starts hidden; updateContextRing reveals it once a model with a known
	// window is selected.
	const ring = document.createElement('span');
	ring.className = 'conversation-context-ring';
	ring.dataset.level = 'ok';
	ring.hidden = true;
	ring.innerHTML =
		'<svg viewBox="0 0 16 16" aria-hidden="true">' +
		`<circle class="ring-track" cx="8" cy="8" r="${RING_RADIUS}"></circle>` +
		`<circle class="ring-fill" cx="8" cy="8" r="${RING_RADIUS}" transform="rotate(-90 8 8)" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"></circle>` +
		'</svg>' +
		'<span class="conversation-context-popover" role="tooltip">' +
		'<span class="conversation-context-popover-header">' +
		'<span class="conversation-context-popover-caption">Context window:</span>' +
		'<span class="conversation-context-popover-value"></span>' +
		'</span>' +
		'<span class="conversation-context-breakdown"></span>' +
		'<span class="conversation-context-popover-footnote">Estimated by category · total is real</span>' +
		'</span>';
	return ring;
}

/** One row of the breakdown popover: a muted label and a right-aligned value. */
function createBreakdownRow(label: string, value: string): HTMLElement {
	const row = document.createElement('span');
	row.className = 'conversation-context-breakdown-row';
	const labelEl = document.createElement('span');
	labelEl.className = 'conversation-context-breakdown-label';
	labelEl.textContent = label;
	const valueEl = document.createElement('span');
	valueEl.className = 'conversation-context-breakdown-value';
	valueEl.textContent = value;
	row.append(labelEl, valueEl);
	return row;
}

/** `~4.1K tokens (0.4%)` — one decimal, `<0.1` below that. Shared by every row (category estimates AND the real Free count) so the popover reads consistently. */
function formatTokensWithPct(tokens: number, contextLength: number): string {
	const pct = contextLength > 0 ? (tokens / contextLength) * 100 : 0;
	return `~${formatTokens(tokens)} tokens (${pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(1)}%)`;
}

/** A category row's estimate: chars/4, then formatted the same way as every other row. */
function formatBreakdownEntry(chars: number, contextLength: number): string {
	return formatTokensWithPct(Math.round(chars / 4), contextLength);
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

interface IMessageActions {
	copy(): void;
	feedback?(value: 'like' | 'dislike'): void;
	fork?(): void;
}

function createMessageRow(message: ISessionMessage, actions?: IMessageActions, resolveImage?: (path: string) => Promise<string | undefined>): HTMLElement {
	const row = document.createElement('article');
	row.className = `conversation-message ${message.role}`;
	row.dataset.role = message.role;
	row.dataset.messageId = message.id;

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
		// An image-only message has no text — don't render an empty bubble.
		bubble.hidden = message.text.trim() === '';
		if (message.attachments && message.attachments.length > 0) {
			const chips = append(body, document.createElement('div'));
			chips.className = 'conversation-message-attachments';
			for (const attachment of message.attachments) {
				if (attachment.kind === 'image') {
					const thumb = append(chips, document.createElement('span'));
					thumb.className = 'conversation-message-image';
					const img = append(thumb, document.createElement('img')) as HTMLImageElement;
					img.alt = 'Attached image';
					// The bytes live on disk — hydrate the thumbnail when they arrive.
					void resolveImage?.(attachment.path).then(url => {
						if (url) {
							img.src = url;
						} else {
							thumb.remove();
						}
					});
					continue;
				}
				const chip = append(chips, document.createElement('span'));
				chip.className = 'conversation-message-attachment';
				chip.title = attachment.path;
				const icon = append(chip, document.createElement('span'));
				icon.className = `codicon ${attachment.kind === 'folder' ? 'codicon-folder' : attachment.kind === 'skill' ? 'codicon-lightbulb' : attachment.kind === 'session' ? 'codicon-comment-discussion' : 'codicon-file'}`;
				icon.setAttribute('aria-hidden', 'true');
				const name = append(chip, document.createElement('span'));
				name.textContent =
					attachment.kind === 'skill'
						? `$${attachment.path}`
						: attachment.kind === 'session'
							? (attachment.label ?? attachment.path)
							: attachment.path.split('/').pop()! + (attachment.kind === 'folder' ? '/' : '');
			}
		}
	} else if (message.role === 'assistant') {
		const text = append(body, document.createElement('div'));
		text.className = 'conversation-message-text conversation-markdown';
		text.appendChild(renderMarkdown(message.text));
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

	if (actions) {
		body.appendChild(createMessageActionBar(message, actions));
	}

	return row;
}

/** File names touched by a work block's write/edit tool steps. */
function extractWorkFiles(work: ISessionMessage | undefined): string[] {
	const files: string[] = [];
	for (const step of work?.steps ?? []) {
		const match = /^(?:write_file|edit_file|read_file) (.+)$/.exec(step.label);
		if (step.kind === 'tool' && match) {
			const name = match[1]!.split('/').pop()!;
			if (!files.includes(name)) {
				files.push(name);
			}
		}
	}
	return files;
}

/** "Today 14:23" / "Yesterday 09:05" / "Jul 6 18:30" — always 24-hour. */
function formatMessageTime(date: Date): string {
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 86_400_000;
	if (date.getTime() >= startOfToday) {
		return `Today ${time}`;
	}
	if (date.getTime() >= startOfYesterday) {
		return `Yesterday ${time}`;
	}
	return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** Hover action bar: copy, like/dislike (assistant), fork-from-here. */
function createMessageActionBar(message: ISessionMessage, actions: IMessageActions): HTMLElement {
	const bar = document.createElement('div');
	bar.className = 'conversation-message-actions';

	const addAction = (icon: string, title: string, onClick: () => void, options?: { readonly active?: boolean; readonly feedbackKind?: 'like' | 'dislike' }): void => {
		const button = append(bar, document.createElement('button')) as HTMLButtonElement;
		button.className = `conversation-message-action${options?.active ? ' active' : ''}`;
		button.type = 'button';
		button.title = title;
		button.setAttribute('aria-label', title);
		if (options?.feedbackKind) {
			// A stable hook so a later patch can toggle the active state in place
			// without recreating the button (see setFeedbackButtonState).
			button.dataset.feedback = options.feedbackKind;
		}
		const iconEl = append(button, document.createElement('span'));
		iconEl.className = `codicon ${icon}`;
		iconEl.setAttribute('aria-hidden', 'true');
		button.addEventListener('click', onClick);
	};

	addAction('codicon-copy', 'Copy', () => {
		actions.copy();
	});
	if (actions.feedback) {
		addAction('codicon-thumbsup', message.feedback === 'like' ? 'Remove like' : 'Like', () => actions.feedback!('like'), {
			active: message.feedback === 'like',
			feedbackKind: 'like',
		});
		addAction('codicon-thumbsdown', message.feedback === 'dislike' ? 'Remove dislike' : 'Dislike', () => actions.feedback!('dislike'), {
			active: message.feedback === 'dislike',
			feedbackKind: 'dislike',
		});
	}
	if (actions.fork) {
		addAction('codicon-git-branch', 'Fork from here', actions.fork);
	}

	if (message.timestamp) {
		const time = append(bar, document.createElement('span'));
		time.className = 'conversation-message-time';
		time.textContent = formatMessageTime(message.timestamp);
		time.title = message.timestamp.toLocaleString();
	}

	return bar;
}

/** Toggle a feedback button's active/title state in place — used when patching an existing row. */
function setFeedbackButtonState(button: Element | null, kind: 'like' | 'dislike', feedback: 'like' | 'dislike' | undefined): void {
	if (!(button instanceof HTMLButtonElement)) {
		return;
	}
	const active = feedback === kind;
	button.classList.toggle('active', active);
	const title = kind === 'like' ? (active ? 'Remove like' : 'Like') : active ? 'Remove dislike' : 'Dislike';
	button.title = title;
	button.setAttribute('aria-label', title);
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
			return 'Mellivora';
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
