/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveLocale, localize } from '../../common/i18n/i18n.js';
import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type {
	IActiveSession,
	IPlanComment,
	ISession,
	ISessionAttachment,
	ISessionDataBrowse,
	ISessionMessage,
	ISessionPendingApproval,
} from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus, estimateSessionTokens } from '../../services/sessions/common/session.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import type { IDataFilesBridge } from '../../services/dataFiles/common/dataFiles.js';
import { installSlashCommands, TEMPLATE_COMMANDS, type IComposerCommand } from './composerCommands.js';
import { installImageAttachments, type IImageController } from './composerImages.js';
import { installPromptHistory, type IPromptHistoryController } from './composerHistory.js';
import { installFileMentions, installSessionMentions, installSkillMentions, type IMentionController } from './composerMentions.js';
import { ConversationContext } from './conversationContext.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';
import { installQuotaIndicator, type IQuotaIndicator } from './quotaIndicator.js';
import type { IModelsBridge } from '../../services/models/common/models.js';
import { permissionMode } from '../../services/agent/browser/permissionModeService.js';
import type { PermissionMode } from '../../services/agent/common/agent.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import { createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { mountOrUpdateReactRow } from './agentUi/bridge/mountReactRow.js';
import { WorkBlock } from './agentUi/components/WorkBlock.js';
import { PlanCard } from './agentUi/components/PlanCard.js';
import { MessageRow } from './agentUi/components/MessageRow.js';
import { UiCard } from './agentUi/components/UiCard.js';

export interface ISessionMessageSender {
	sendMessage(sessionId: string, query: string, options?: { readonly attachments?: readonly ISessionAttachment[]; readonly images?: readonly IPendingImage[] }): Promise<unknown>;
	stopSession(sessionId: string): Promise<unknown>;
	/** Resume a quota/rate-frozen run (#19 缺陷 2). */
	resumeSession?(sessionId: string): Promise<unknown>;
	setSessionPermissionMode?(sessionId: string, mode: PermissionMode): Promise<unknown>;
	setMessageFeedback?(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<unknown>;
	/** Flip a plan artifact's review state (approve / supersede); the store overlays it onto the plan message. */
	setPlanState?(sessionId: string, messageId: string, state: 'draft' | 'approved' | 'superseded'): Promise<unknown>;
	/** Upsert a review comment on a plan section (resolve = same id with resolved:true). */
	setPlanComment?(sessionId: string, comment: IPlanComment): Promise<unknown>;
	forkSession?(sessionId: string, messageId: string): Promise<unknown>;
	/** Data URL for a stored image attachment, for thumbnails in the transcript. */
	resolveMedia?(sessionId: string, path: string): Promise<string | undefined>;
	/** All sessions, for the #-mention picker (sessionsService satisfies this structurally). */
	getSessions?(): readonly ISession[];
}

// A reader within this band above the live end counts as "following the
// output" — renders keep them pinned; anything further up is a deliberate
// scroll-back whose position must be preserved.
const FOLLOW_BAND_PX = 48;
// settleScrollAtBottom's termination cap: ~1s at 60fps.
const MAX_SETTLE_FRAMES = 60;

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
	// Portaled to <body> — see the comment on createContextRing for why.
	private readonly contextPopover: HTMLElement;
	private readonly quotaIndicator: IQuotaIndicator;
	private readonly pausedBanner: HTMLElement;
	private readonly pausedBannerText: HTMLElement;
	private readonly pausedBannerResume: HTMLButtonElement;
	private readonly header = this._register(new ConversationContext());
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;
	private isSending = false;
	private isStopping = false;
	// A follow-up typed while a run is live is held here and sent when it settles,
	// so a second run never overlaps the first (single slot; a newer one replaces it).
	private queuedFollowUp: string | undefined;
	/** The approval request whose Allow button already got initial focus (re-render guard). */
	private focusedApprovalId: string | undefined;
	/** Approval request ids seen per session — drives the compact-density switch. */
	private readonly approvalsSeen = new Map<string, Set<string>>();
	private scrollToBottomOnRender = false;
	// rAF handle of the settle loop that re-pins a forced scroll-to-bottom
	// while the transcript is still growing (see settleScrollAtBottom).
	private scrollSettleFrame: number | undefined;
	// Fan-out for the session-aware permission picker (the underlying observable
	// swaps whenever another session becomes active).
	private readonly permissionListeners = new Set<() => void>();
	private workTicker: ReturnType<typeof setInterval> | undefined;
	// Rendered rows keyed by message id, so a streaming delta patches only the
	// row that actually changed instead of tearing down the whole transcript —
	// rebuilding every row on every token would restart hover-revealed UI (e.g.
	// the message action bar's fade-in) on unrelated, unchanged messages too.
	private readonly renderedRows = new Map<string, { element: HTMLElement; message: ISessionMessage; reactRoot?: Root }>();

	private readonly mentions: IMentionController;
	private readonly skillMentions: IMentionController;
	private readonly sessionMentions: IMentionController;
	private readonly images: IImageController;
	private readonly promptHistory: IPromptHistoryController;

	constructor(
		private readonly messageSender?: ISessionMessageSender,
		private readonly modelsService?: IModelsService,
		private readonly projectsService?: IProjectsService,
		private readonly skillsService?: ISkillsService,
		private readonly sessionsPartService?: ISessionsPartService,
		private readonly dataFiles?: IDataFilesBridge,
	) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'conversation-view';

		const bodyWrap = append(this.element, document.createElement('div'));
		bodyWrap.className = 'conversation-body';

		this.timeline = append(bodyWrap, document.createElement('div'));
		this.timeline.className = 'conversation-timeline';
		this.timeline.setAttribute('role', 'navigation');
		this.timeline.setAttribute('aria-label', localize('conv.timeline'));

		this.transcript = append(bodyWrap, document.createElement('div'));
		this.transcript.className = 'conversation-transcript';

		this.composer = append(this.element, document.createElement('form'));
		this.composer.className = 'conversation-composer';
		this.composer.appendChild(this.header.element);
		this.header.element.hidden = true;

		// Frozen-run banner (#19 缺陷 2): sits between the context bar and the
		// input. Not an error — a waiting state with its own exit button.
		this.pausedBanner = append(this.composer, document.createElement('div'));
		this.pausedBanner.className = 'conversation-paused-banner';
		this.pausedBanner.hidden = true;
		const pausedIcon = append(this.pausedBanner, document.createElement('span'));
		pausedIcon.className = 'codicon codicon-debug-pause';
		pausedIcon.setAttribute('aria-hidden', 'true');
		this.pausedBannerText = append(this.pausedBanner, document.createElement('span'));
		this.pausedBannerText.className = 'conversation-paused-banner-text';
		this.pausedBannerResume = append(this.pausedBanner, document.createElement('button')) as HTMLButtonElement;
		this.pausedBannerResume.type = 'button';
		this.pausedBannerResume.className = 'conversation-paused-banner-resume';
		this.pausedBannerResume.textContent = localize('paused.resumeNow');
		this.pausedBannerResume.addEventListener('click', () => {
			const sessionId = this.session?.sessionId;
			if (sessionId) {
				this.pausedBannerResume.disabled = true;
				void this.messageSender?.resumeSession?.(sessionId);
			}
		});

		const inputWrap = append(this.composer, document.createElement('div'));
		inputWrap.className = 'conversation-input-wrap';

		this.input = append(inputWrap, document.createElement('textarea')) as HTMLTextAreaElement;
		this.input.className = 'conversation-input';
		this.input.rows = 1;
		this.input.placeholder = localize('conv.placeholder');
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
		access.title = localize('conv.approvals');
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

		// Coding-plan quota (#19): lives at the RIGHT EDGE of the context bar
		// above the composer (user-picked placement 2026-07-20) — subscription
		// state sits with the workspace context, not among the send controls.
		// The host wrapper is owned here; ConversationContext re-adopts it on
		// each of its re-renders.
		const quotaHost = document.createElement('span');
		quotaHost.className = 'conversation-context-quota';
		this.quotaIndicator = this._register(
			installQuotaIndicator({
				container: quotaHost,
				fetchQuota: () => {
					const models = (globalThis as typeof globalThis & { readonly agentWindow?: { readonly models?: IModelsBridge } }).agentWindow?.models;
					return models?.codingQuota() ?? Promise.resolve(undefined);
				},
			}),
		);
		this.header.setTrailing(quotaHost);

		// A standalone read-only indicator — deliberately not part of the
		// model button, which is an interactive picker.
		this.contextRing = append(rightControls, createContextRing());
		// NOT appended to <body> yet: this constructor runs as part of Workbench's
		// field initializers, BEFORE Workbench.startup() calls
		// `container.replaceChildren(this.root)` — appending here would be wiped
		// out the moment that runs. showContextPopover() mounts it lazily, on
		// first use, well after startup() has finished.
		this.contextPopover = createContextPopover();
		this.contextRing.addEventListener('mouseenter', () => this.showContextPopover());
		this.contextRing.addEventListener('mouseleave', () => this.hideContextPopover());

		const model = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		model.className = 'conversation-model';
		model.type = 'button';
		model.title = localize('conv.pickModel');
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = localize('picker.noModel');
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
		this.stopButton.title = localize('conv.stop');
		this.stopButton.setAttribute('aria-label', localize('conv.stop'));
		appendCodicon(this.stopButton, 'codicon-debug-stop');

		this.sendButton = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		this.sendButton.className = 'conversation-send-button';
		this.sendButton.type = 'submit';
		this.sendButton.title = localize('conv.send');
		this.sendButton.setAttribute('aria-label', localize('conv.send'));
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
						{ name: 'model', kind: 'action', description: localize('conv.action.pickModel'), run: () => model.click() },
						{ name: 'permission', kind: 'action', description: localize('conv.action.pickPermission'), run: () => access.click() },
						...(session && lastMessage && this.messageSender?.forkSession
							? [
									{
										name: 'fork',
										kind: 'action' as const,
										description: localize('conv.action.fork'),
										run: () => void this.messageSender!.forkSession!(session.sessionId, lastMessage.id),
									},
								]
							: []),
						...(session?.status.get() === SessionStatus.InProgress
							? [{ name: 'stop', kind: 'action' as const, description: localize('conv.action.stop'), run: () => void this.stop() }]
							: []),
						...TEMPLATE_COMMANDS,
					];
				},
			}),
		);

		// After every menu module: their open-menu handlers stopImmediatePropagation
		// on the arrows, which is what keeps recall out of menu navigation.
		this.promptHistory = this._register(
			installPromptHistory({
				input: this.input,
				getHistory: () => (this.session?.messages.get() ?? []).filter(message => message.role === 'user').map(message => message.text),
			}),
		);

		// Data browser → composer: structured reference text lands in the input
		// (consume-once; the observable resets so the same text can come again).
		if (this.sessionsPartService) {
			const insertRequest = this.sessionsPartService.composerInsertRequest;
			this._register(
				insertRequest.subscribe(() => {
					const text = insertRequest.get();
					if (text === undefined || text === '') {
						return;
					}
					insertRequest.set(undefined);
					const current = this.input.value;
					this.input.value = current === '' ? text : `${current.replace(/\s+$/, '')}\n${text}`;
					this.input.dispatchEvent(new Event('input', { bubbles: true }));
					this.input.focus();
					this.input.setSelectionRange(this.input.value.length, this.input.value.length);
				}),
			);
		}

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
		// Mentions, pending images and history drafts belong to the session they
		// were staged in.
		this.mentions.reset();
		this.skillMentions.reset();
		this.sessionMentions.reset();
		this.images.reset();
		this.promptHistory.reset();
		// A freshly opened conversation starts at its latest message.
		this.scrollToBottomOnRender = true;

		if (session) {
			this.sessionDisposables.add(session.messages.subscribe(() => this.render()));
			// planComments has no subscription here — PlanCard (React) subscribes to
			// it directly via useObservable, so a comment change re-renders just that
			// card's own root instead of forcing a full transcript reconcile.
			this.sessionDisposables.add(session.interactivity.subscribe(() => this.render()));
			this.sessionDisposables.add(
				session.status.subscribe(() => {
					this.render();
					this.flushQueuedFollowUp();
					// A run settling is what moves the plan quota — re-read it as
					// soon as the session leaves InProgress instead of waiting for
					// the 5-minute timer.
					if (session.status.get() !== SessionStatus.InProgress) {
						this.quotaIndicator.refresh();
					}
				}),
			);
			this.sessionDisposables.add(session.pendingApproval.subscribe(() => this.render()));
			this.sessionDisposables.add(session.reconnect.subscribe(() => this.updateReconnectStatus()));
			this.sessionDisposables.add(session.permissionMode.subscribe(() => this.notifyPermissionListeners()));
			this.sessionDisposables.add(session.contextUsage.subscribe(() => this.updateContextRing()));
			this.sessionDisposables.add(session.pausedRun.subscribe(() => this.updatePausedBanner()));
		}
		this.updatePausedBanner();
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
		this.reconnectLabel.textContent = reconnect ? localize('conv.reconnecting', reconnect.attempt, reconnect.maxAttempts) : '';
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

		// Attachment thumbnails resolve and decode AFTER their row committed
		// (resolveMedia is async) — possibly past the settle loop's window. An
		// <img> growing under a reader pinned at the bottom would push the live
		// end out of view, so re-pin; `load` doesn't bubble, hence capture.
		// By `load` the image has ALREADY grown the transcript (reading scroll
		// geometry forces the post-decode layout), so "was the reader at the
		// bottom" needs the image's own height added back onto the band —
		// against the bare band, any image taller than it defeats the re-pin.
		this.transcript.addEventListener(
			'load',
			event => {
				if (event.target instanceof HTMLImageElement && this.isNearBottom(FOLLOW_BAND_PX + event.target.getBoundingClientRect().height)) {
					this.transcript.scrollTop = this.transcript.scrollHeight;
				}
			},
			true,
		);
	}

	private render(): void {
		this.element.classList.toggle('empty', !this.session);
		this.element.dataset.status = this.session ? conversationStatusId(this.session.status.get()) : 'empty';
		this.element.dataset.interactivity = this.session?.interactivity.get() ?? 'none';
		this.header.element.hidden = !this.session;

		// A structural change (new/removed row) can move scrollTop; a pure content
		// patch never does. Follow the output while the reader is at (or near) the
		// bottom; preserve their position otherwise.
		const forcedScrollToBottom = this.scrollToBottomOnRender;
		const stickToBottom = forcedScrollToBottom || this.isNearBottom(FOLLOW_BAND_PX);
		const previousScrollTop = this.transcript.scrollTop;
		this.scrollToBottomOnRender = false;

		// Digest messages are hidden context for the next run's transcript, not
		// conversation — drop them before any rendering (rows, timeline, tickers).
		const messages = (this.session?.messages.get() ?? []).filter(message => message.role !== 'digest');
		this.reconcileTranscript(messages);

		const hasLiveWork = messages.some(message => message.role === 'work' && message.durationMs === undefined);
		const approval = this.session?.pendingApproval.get();
		// These trailing rows aren't part of the keyed reconciliation above (they
		// aren't backed by a message id) — always re-evaluate them.
		this.transcript.querySelector('.conversation-approval')?.remove();
		this.transcript.querySelector('.conversation-working-row')?.remove();
		this.transcript.querySelector('.conversation-thinking-row')?.remove();
		if (approval) {
			const card = createApprovalCard(approval, this.useCompactApproval(approval));
			this.transcript.appendChild(card);
			// The card is re-created on every render (incl. the 1s live ticker), so
			// focus the Allow button ONCE per request — not every second — and never
			// steal focus the user has already moved into the card.
			if (approval.requestId !== this.focusedApprovalId && !card.contains(document.activeElement)) {
				card.querySelector<HTMLButtonElement>('.conversation-approval-allow')?.focus();
			}
			this.focusedApprovalId = approval.requestId;
		} else {
			this.focusedApprovalId = undefined;
		}
		if (!approval && this.session?.status.get() === SessionStatus.InProgress && !hasLiveWork) {
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
		if (forcedScrollToBottom) {
			this.settleScrollAtBottom();
		}

		this.updateWorkTicker(hasLiveWork);
		this.renderTimeline(messages);
		this.updateComposerState();
		this.updateContextRing();
	}

	/**
	 * Re-pin a forced scroll-to-bottom across the frames in which the transcript
	 * is still growing. Row content is React-rendered (mountOrUpdateReactRow),
	 * and createRoot().render() commits ASYNCHRONOUSLY — the synchronous
	 * `scrollTop = scrollHeight` in render() measures host divs whose content
	 * hasn't committed yet, so a single shot lands short of the real bottom
	 * and the freshly opened conversation stays scrolled to the TOP. Keep
	 * pinning every frame until the scroll height holds steady for two
	 * consecutive frames (React commits and fast-decoding thumbnails settled),
	 * capped so the loop always terminates. Late-arriving growth (a slow image
	 * decode) is covered by the capture-phase `load` listener instead.
	 */
	private settleScrollAtBottom(): void {
		if (this.scrollSettleFrame !== undefined) {
			cancelAnimationFrame(this.scrollSettleFrame);
		}
		let lastHeight = -1;
		let steadyFrames = 0;
		let framesLeft = MAX_SETTLE_FRAMES;
		const step = () => {
			this.transcript.scrollTop = this.transcript.scrollHeight;
			const height = this.transcript.scrollHeight;
			steadyFrames = height === lastHeight ? steadyFrames + 1 : 0;
			lastHeight = height;
			framesLeft -= 1;
			this.scrollSettleFrame = steadyFrames >= 2 || framesLeft <= 0 ? undefined : requestAnimationFrame(step);
		};
		this.scrollSettleFrame = requestAnimationFrame(step);
	}

	/** Whether the reader is within `bandPx` of the live end — the shared "still following" predicate. */
	private isNearBottom(bandPx: number): boolean {
		return this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < bandPx;
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
				empty.textContent = this.session ? localize('conv.noMessages') : localize('conv.noSession');
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
				// A work block's rendering also depends on state outside the message
				// itself — its own expand/step-detail state and the live ticker — so
				// it always resyncs; React bails out on an unchanged subtree, so this
				// is cheap. Everything else is identity-gated: an unchanged message
				// means unchanged content, because PlanCard subscribes to its own
				// external store and MessageRow is a pure function of the message prop
				// (no hand-split "patch only the dynamic bits" needed — React's own
				// diffing already leaves untouched DOM, like the action bar's
				// hover-fade, alone).
				if (message.role === 'work' || existing.message !== message) {
					existing.reactRoot = mountOrUpdateReactRow(element, existing.reactRoot, this.createRowElement(message));
				}
				existing.message = message;
			} else {
				// A bare host div — the React component owns everything inside it,
				// including its own root element and data-message-id; the extra
				// wrapper is inert for layout (every row type sizes itself via
				// margin/its own grid, not parent gap/child-selectors) and
				// transparent to `[data-message-id]` queries (querySelectorAll
				// reaches through it).
				element = document.createElement('div');
				const reactRoot = mountOrUpdateReactRow(element, undefined, this.createRowElement(message));
				this.renderedRows.set(message.id, { element, message, reactRoot });
			}

			if (element === cursor) {
				cursor = cursor.nextSibling;
			} else {
				this.transcript.insertBefore(element, cursor);
			}
		}

		for (const [id, entry] of this.renderedRows) {
			if (!seen.has(id)) {
				entry.reactRoot?.unmount();
				entry.element.remove();
				this.renderedRows.delete(id);
			}
		}
	}

	/** "Worked for 16m 56s ⌄" — one collapsible block per agent run, holding the thinking stretches and tool calls with their durations. React-rendered (see reconcileTranscript); this just builds the element. */
	private createWorkBlockElement(message: ISessionMessage): ReactNode {
		const sessionsPartService = this.sessionsPartService;
		return createElement(WorkBlock, {
			message,
			onOpenDataBrowser: sessionsPartService && ((browse: ISessionDataBrowse) => sessionsPartService.openDataBrowser(browse)),
		});
	}

	/**
	 * The reviewable plan artifact card (`role:'plan'`): sectioned content with
	 * the version in the header. A draft card carries the review actions
	 * (按此执行 / 让它改); a superseded one collapses to its header. A message
	 * whose structured payload is missing falls back to its markdown text.
	 * React-rendered (see reconcileTranscript); this just builds the element.
	 */
	private createPlanCardElement(message: ISessionMessage): ReactNode {
		return createElement(PlanCard, {
			message,
			sessionId: this.session?.sessionId,
			planComments: this.session?.planComments,
			messageSender: this.messageSender,
			onFocusComposer: () => this.input.focus(),
		});
	}

	/** Dispatches a message to its React row element by role (see reconcileTranscript). */
	private createRowElement(message: ISessionMessage): ReactNode {
		switch (message.role) {
			case 'work':
				return this.createWorkBlockElement(message);
			case 'plan':
				return this.createPlanCardElement(message);
			case 'ui':
				return createElement(UiCard, {
					message,
					sessionId: this.session?.sessionId,
					messageSender: this.messageSender,
					onFocusComposer: () => this.input.focus(),
					openSurface: this.sessionsPartService ? () => this.sessionsPartService!.openSurfacePanel() : undefined,
					exportText: this.dataFiles ? (defaultName, content) => this.dataFiles!.exportText(defaultName, content) : undefined,
				});
			default:
				return createElement(MessageRow, { message, actions: this.buildMessageActions(message), resolveImage: this.buildImageResolver() });
		}
	}

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
			tick.setAttribute('aria-label', localize('conv.jumpToTurn'));
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
		// Tighter band than FOLLOW_BAND_PX: highlighting the last tick is about
		// being AT the end, not merely following it.
		const atBottom = this.isNearBottom(8);
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
		excerpt.textContent = turn.assistant ? turn.assistant.text.slice(0, 240) : localize('conv.workingEllipsis');

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
		if (this.scrollSettleFrame !== undefined) {
			cancelAnimationFrame(this.scrollSettleFrame);
			this.scrollSettleFrame = undefined;
		}
		// Portaled to <body>, outside `this.element` — removing the view's own
		// root would never take this with it.
		this.contextPopover.remove();
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
		const value = this.contextPopover.querySelector<HTMLElement>('.conversation-context-popover-value');
		const breakdownList = this.contextPopover.querySelector<HTMLElement>('.conversation-context-breakdown');
		const footnote = this.contextPopover.querySelector<HTMLElement>('.conversation-context-popover-footnote');
		if (!fill || !value || !breakdownList || !footnote) {
			return;
		}

		const contextLength = this.modelsService?.selectedModel.get()?.contextLength;
		if (!contextLength) {
			this.contextRing.hidden = true;
			this.hideContextPopover();
			return;
		}

		const usage = this.session?.contextUsage.get();
		// `usage.inputTokens` is already the best number the provider has — a
		// real bill from this process, a restored bill from the last run, or a
		// char/4 estimate. `totalSource` says which; when contextUsage hasn't
		// been touched at all yet, fall back the same way the provider itself
		// would (same formula, so the two never drift).
		const tokens = usage ? usage.inputTokens : estimateSessionTokens(this.session?.messages.get() ?? []);
		const totalSource = usage?.totalSource ?? 'estimate';
		const ratio = Math.min(1, tokens / contextLength);
		const usedPct = Math.round(ratio * 100);

		this.contextRing.hidden = false;
		this.contextRing.dataset.level = ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
		fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
		// Three honestly-labeled states: a fresh real reading needs no caveat; a
		// restored one is a true bill that may be stale ("last run"); an estimate
		// says so. The aria-label always disclosed the estimate case; the visible
		// text carries the same tags so a plausible number is never mistaken for
		// a fresh measurement.
		const totalSuffix = totalSource === 'real' ? '' : totalSource === 'restored' ? ' (last run)' : ' (estimated)';
		value.textContent = localize('conv.contextUsed', usedPct, 100 - usedPct, totalSuffix);
		this.contextRing.setAttribute('aria-label', localize('conv.contextAria', usedPct, formatTokens(tokens), formatTokens(contextLength), totalSuffix));

		// The breakdown can populate BEFORE the total is real — a run's first
		// context_breakdown event fires ahead of its usage event, so the panel
		// shows the mechanisms working live even before the model has replied.
		// Free closes the CATEGORY ledger (window − Σrows), so the rows always
		// sum to 100% among themselves; the header stays on the real/restored
		// total. The two speak different clocks by design — rows describe the
		// NEXT request, the total bills the last one — and the footnote says so.
		breakdownList.replaceChildren();
		const breakdown = usage?.breakdown;
		if (breakdown) {
			const categoryChars = breakdown.systemChars + breakdown.instructionsChars + breakdown.skillsChars + breakdown.toolsChars + breakdown.compactedChars + breakdown.messagesChars;
			breakdownList.append(createBreakdownRow('System prompt', formatBreakdownEntry(breakdown.systemChars, contextLength)));
			breakdownList.append(createBreakdownRow('Project instructions', formatBreakdownEntry(breakdown.instructionsChars, contextLength)));
			breakdownList.append(createBreakdownRow('Skills', formatBreakdownEntry(breakdown.skillsChars, contextLength)));
			breakdownList.append(createBreakdownRow('Tools', formatBreakdownEntry(breakdown.toolsChars, contextLength)));
			if (breakdown.compactedChars > 0) {
				breakdownList.append(createBreakdownRow('Compacted summary', formatBreakdownEntry(breakdown.compactedChars, contextLength)));
			}
			breakdownList.append(createBreakdownRow('Messages', formatBreakdownEntry(breakdown.messagesChars, contextLength)));
			breakdownList.append(createBreakdownRow('Free', formatTokensWithPct(Math.max(0, contextLength - Math.round(categoryChars / 4)), contextLength)));
		}
		footnote.textContent =
			totalSource === 'real'
				? 'Rows estimate the next request · total is real'
				: totalSource === 'restored'
					? 'From the last run · rows estimated'
					: 'All figures estimated — waiting for the model’s real count';

		// Content just changed height (e.g. rows appeared mid-hover as a live run
		// streams in) — reposition so it stays flipped/clamped correctly rather
		// than drifting off whatever position it was shown at.
		if (this.contextPopover.classList.contains('is-visible')) {
			this.positionContextPopover();
		}
	}

	/** The frozen-run banner (#19 缺陷 2): cause + concrete recovery plan, and the manual resume. */
	private updatePausedBanner(): void {
		const paused = this.session?.pausedRun.get();
		if (!paused) {
			this.pausedBanner.hidden = true;
			return;
		}
		this.pausedBanner.hidden = false;
		this.pausedBannerResume.disabled = false;
		const causeLabel = paused.cause === 'quota' ? localize('paused.causeQuota') : localize('paused.causeRate');
		const reset = formatPausedReset(paused.resetTime);
		this.pausedBannerText.textContent = reset !== undefined ? localize('paused.bannerWithReset', causeLabel, reset) : localize('paused.banner', causeLabel);
	}

	private showContextPopover(): void {
		if (this.contextRing.hidden) {
			return;
		}
		if (!this.contextPopover.isConnected) {
			// First real use, well after Workbench.startup()'s one-time
			// `replaceChildren` — safe to mount now (see the constructor comment).
			// Mount inside the WORKBENCH ROOT, not document.body: the theme's
			// custom properties are inline styles on that root
			// (applyThemeTokens), so outside its subtree every
			// var(--vscode-agents-*) fails to resolve — a transparent, unthemed
			// card (seen live: bare black text in dark theme). The root carries
			// no transform/filter, so position: fixed still anchors to the
			// viewport and escapes the root's own overflow: hidden.
			const host = this.contextRing.closest('.monaco-workbench') ?? document.body;
			host.append(this.contextPopover);
		}
		this.positionContextPopover();
		this.contextPopover.classList.add('is-visible');
	}

	private hideContextPopover(): void {
		this.contextPopover.classList.remove('is-visible');
	}

	/**
	 * Positions the portaled popover in viewport (fixed) coordinates from the
	 * ring's own rect — the only way to guarantee it isn't silently clipped by
	 * `.session-view`'s `overflow: hidden` now that the breakdown can run to
	 * 7+ rows. Opens above the ring by default (the composer sits at the
	 * window bottom); flips below when there truly isn't room above, and
	 * clamps horizontally so it never runs off either edge.
	 */
	private positionContextPopover(): void {
		const ringRect = this.contextRing.getBoundingClientRect();
		const gap = 6;
		// Measure the popover's OWN height with real content already rendered —
		// display is never 'none' (opacity-only), so offsetHeight is accurate
		// even before `is-visible` makes it visible to the eye.
		const popoverHeight = this.contextPopover.offsetHeight;
		const popoverWidth = this.contextPopover.offsetWidth;

		const roomAbove = ringRect.top - gap;
		const opensAbove = roomAbove >= popoverHeight || roomAbove >= window.innerHeight - ringRect.bottom - gap;
		const top = opensAbove ? Math.max(8, ringRect.top - gap - popoverHeight) : ringRect.bottom + gap;

		const desiredLeft = ringRect.left + ringRect.width / 2 - popoverWidth / 2;
		const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - popoverWidth - 8));

		this.contextPopover.style.top = `${top}px`;
		this.contextPopover.style.left = `${left}px`;
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
		label.textContent = localize('conv.thinking');

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
				? localize('conv.placeholder.queued', this.queuedFollowUp)
				: localize('conv.placeholder.working')
			: interactivity === SessionInteractivity.ReadOnly
				? localize('conv.placeholder.readOnly')
				: localize('conv.placeholder.full');
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

	/** Count this request against its session and decide the card's density. */
	private useCompactApproval(approval: ISessionPendingApproval): boolean {
		const sessionId = this.session?.sessionId;
		if (sessionId === undefined) {
			return false;
		}
		let seen = this.approvalsSeen.get(sessionId);
		if (!seen) {
			seen = new Set();
			this.approvalsSeen.set(sessionId, seen);
		}
		// The card re-renders every second (live ticker) — a request must count
		// once, not once per render, or the threshold would trip on a single prompt.
		const prior = seen.has(approval.requestId) ? seen.size - 1 : seen.size;
		seen.add(approval.requestId);
		return shouldRenderCompactApproval(prior, approval.toolName);
	}
}

/** The gate paused on a mutating tool: say what it wants and offer Allow / Deny. */
/** Per-tool presentation of an approval prompt: icon, human title, type chip, and how to show the detail. */
function describeApproval(toolName: string, detail: string): { icon: string; title: string; chip: string; command?: string; path?: string } {
	switch (toolName) {
		case 'bash':
			return { icon: 'codicon-terminal', title: localize('appr.runCommand'), chip: 'bash', command: detail };
		case 'write_file':
			return { icon: 'codicon-new-file', title: localize('appr.writeFile'), chip: 'write_file', path: detail.replace(/^write /, '') };
		case 'edit_file':
			return { icon: 'codicon-edit', title: localize('appr.editFile'), chip: 'edit_file', path: detail.replace(/^edit /, '') };
		case 'execute_data_source':
			// The SQL renders in the command slot — the user must see the exact
			// statement they are approving, same treatment as a bash command.
			return { icon: 'codicon-database', title: localize('appr.executeDataSource'), chip: 'execute_data_source', command: detail };
		default:
			return { icon: 'codicon-shield', title: localize('appr.generic'), chip: toolName };
	}
}

/** Full cards a session answers before the density drops to compact single-row. */
const COMPACT_APPROVAL_AFTER = 3;

/**
 * Whether an approval renders as the compact single-row variant: once a session
 * has already been through a few full cards, later prompts shrink to one line so
 * an approval-dense run stops eating the transcript. Only tools with a guard
 * BEHIND the prompt (bash sandbox, file-tool code root) may shrink —
 * run_on_server's only gate is the prompt itself, so it always gets the full card.
 */
export function shouldRenderCompactApproval(priorPrompts: number, toolName: string): boolean {
	if (toolName !== 'bash' && toolName !== 'write_file' && toolName !== 'edit_file') {
		return false;
	}
	return priorPrompts >= COMPACT_APPROVAL_AFTER;
}

/** Muted-dir + bold-filename path spans, shared by the full and compact bodies. */
function appendApprovalPath(row: HTMLElement, path: string): void {
	const slash = path.lastIndexOf('/');
	if (slash >= 0) {
		const dir = append(row, document.createElement('span'));
		dir.className = 'conversation-approval-path-dir';
		dir.textContent = path.slice(0, slash + 1);
	}
	const base = append(row, document.createElement('span'));
	base.className = 'conversation-approval-path-base';
	base.textContent = slash >= 0 ? path.slice(slash + 1) : path;
}

/** Allow / always-allow / deny row. Compact drops the key hints, not the keys. */
function appendApprovalActions(card: HTMLElement, approval: ISessionPendingApproval, compact: boolean): void {
	const actions = append(card, document.createElement('div'));
	actions.className = 'conversation-approval-actions';

	const allow = append(actions, document.createElement('button')) as HTMLButtonElement;
	allow.className = 'conversation-approval-allow';
	allow.type = 'button';
	append(allow, document.createElement('span')).textContent = localize('appr.allow');
	if (!compact) {
		const allowKey = append(allow, document.createElement('kbd'));
		allowKey.className = 'conversation-approval-key';
		allowKey.textContent = '⏎';
	}
	allow.addEventListener('click', () => approval.respond(true));

	// "Always allow [pattern]" — offered only for safe, always-allowable tools
	// (main-side deriveGrant gates this; run_on_server never gets a label). The
	// pattern is shown verbatim so the user sees exactly what they're granting.
	if (approval.alwaysAllow !== undefined) {
		const always = append(actions, document.createElement('button')) as HTMLButtonElement;
		always.className = 'conversation-approval-always';
		always.type = 'button';
		always.title = localize('appr.alwaysTitle', approval.alwaysAllow);
		append(always, document.createElement('span')).textContent = localize('appr.always');
		const pattern = append(always, document.createElement('code'));
		pattern.className = 'conversation-approval-pattern';
		pattern.textContent = approval.alwaysAllow;
		always.addEventListener('click', () => approval.respond(true, true, 'session'));

		// The PERMANENT variant (persisted per project, personal & per-machine) —
		// only ever offered for bash: grants inside a project (main-side gated),
		// and only on the full card: a durable grant deserves the full ceremony.
		if (approval.alwaysAllowProject && !compact) {
			const forever = append(actions, document.createElement('button')) as HTMLButtonElement;
			forever.className = 'conversation-approval-always conversation-approval-always-project';
			forever.type = 'button';
			forever.title = localize('appr.projectTitle', approval.alwaysAllow);
			append(forever, document.createElement('span')).textContent = localize('appr.project');
			forever.addEventListener('click', () => approval.respond(true, true, 'project'));
		}
	}

	const deny = append(actions, document.createElement('button')) as HTMLButtonElement;
	deny.className = 'conversation-approval-deny';
	deny.type = 'button';
	append(deny, document.createElement('span')).textContent = localize('appr.deny');
	if (!compact) {
		const denyKey = append(deny, document.createElement('kbd'));
		denyKey.className = 'conversation-approval-key';
		denyKey.textContent = 'Esc';
	}
	deny.addEventListener('click', () => approval.respond(false));
}

function createApprovalCard(approval: ISessionPendingApproval, compact = false): HTMLElement {
	const card = document.createElement('div');
	card.className = compact ? 'conversation-approval conversation-approval-compact' : 'conversation-approval';
	card.setAttribute('role', 'alertdialog');
	card.setAttribute('aria-label', localize('appr.aria'));
	// Esc denies. The focused Allow button (a child) bubbles the keydown up here,
	// and the listener dies with the card — no document-level leak.
	card.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			approval.respond(false);
		}
	});

	const spec = describeApproval(approval.toolName, approval.detail);

	if (compact) {
		// One line: icon · detail (ellipsized, full text on hover) · small actions.
		// The session has already read a few full cards — density over ceremony.
		appendCodicon(card, spec.icon);
		const body = append(card, document.createElement('span'));
		body.className = 'conversation-approval-compact-detail';
		body.title = spec.command ?? spec.path ?? approval.detail;
		if (spec.command !== undefined) {
			const marker = append(body, document.createElement('span'));
			marker.className = 'conversation-approval-prompt';
			marker.textContent = '$';
			const cmd = append(body, document.createElement('code'));
			cmd.className = 'conversation-approval-compact-command';
			cmd.textContent = spec.command;
		} else if (spec.path !== undefined) {
			appendApprovalPath(body, spec.path);
		} else {
			const detail = append(body, document.createElement('code'));
			detail.className = 'conversation-approval-compact-command';
			detail.textContent = approval.detail;
		}
		appendApprovalActions(card, approval, true);
		return card;
	}

	const header = append(card, document.createElement('div'));
	header.className = 'conversation-approval-header';
	appendCodicon(header, spec.icon);
	const title = append(header, document.createElement('span'));
	title.className = 'conversation-approval-title';
	title.textContent = spec.title;
	const chip = append(header, document.createElement('span'));
	chip.className = 'conversation-approval-chip';
	chip.textContent = spec.chip;

	if (spec.command !== undefined) {
		// Terminal-style block: a $ prompt marker, and the command WRAPS instead of
		// scrolling off — a long path stays fully readable.
		const term = append(card, document.createElement('div'));
		term.className = 'conversation-approval-terminal';
		const marker = append(term, document.createElement('span'));
		marker.className = 'conversation-approval-prompt';
		marker.textContent = '$';
		const cmd = append(term, document.createElement('code'));
		cmd.className = 'conversation-approval-command';
		cmd.textContent = spec.command;
	} else if (spec.path !== undefined) {
		// Show the path with its directory muted and the filename emphasized.
		const row = append(card, document.createElement('div'));
		row.className = 'conversation-approval-path';
		appendCodicon(row, 'codicon-file');
		appendApprovalPath(row, spec.path);
	} else {
		const detail = append(card, document.createElement('code'));
		detail.className = 'conversation-approval-command';
		detail.textContent = approval.detail;
	}

	appendApprovalActions(card, approval, false);
	return card;
}

/** The #-picker's entries: other sessions, newest first, capped. */
export function listReferencableSessions(
	sessions: readonly ISession[],
	currentSessionId: string | undefined,
	limit: number = 50,
): { id: string; name: string; description: string }[] {
	return sessions
		.filter(session => session.sessionId !== currentSessionId && !session.isArchived.get())
		.sort((a, b) => b.updatedAt.get().getTime() - a.updatedAt.get().getTime())
		.slice(0, limit)
		.map(session => ({ id: session.sessionId, name: session.title.get(), description: session.updatedAt.get().toLocaleDateString(getActiveLocale()) }));
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
	// A small ring (fill = % of the context window used). The hover popover
	// used to nest here as an absolutely-positioned child, but the breakdown
	// panel can run to 7+ rows — tall enough that `.session-view`'s
	// `overflow: hidden` silently clipped it. The popover is now a separate
	// element (see createContextPopover), portaled to <body> by the caller.
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
		'</svg>';
	return ring;
}

/**
 * The ring's hover popover — created separately so the caller can portal it
 * to `document.body` (see the class comment on {@link createContextRing}).
 * `position: fixed`, positioned and shown/hidden by positionContextPopover /
 * showContextPopover / hideContextPopover, not CSS `:hover` (the popover is
 * no longer a DOM descendant of the ring once portaled).
 */
function createContextPopover(): HTMLElement {
	const popover = document.createElement('span');
	popover.className = 'conversation-context-popover';
	popover.setAttribute('role', 'tooltip');
	popover.innerHTML =
		'<span class="conversation-context-popover-header">' +
		'<span class="conversation-context-popover-caption">Context window:</span>' +
		'<span class="conversation-context-popover-value"></span>' +
		'</span>' +
		'<span class="conversation-context-breakdown"></span>' +
		'<span class="conversation-context-popover-footnote">Estimated by category · total is real</span>';
	return popover;
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

/** Local `MM-DD HH:mm` for the paused banner's reset time; undefined for garbage. */
function formatPausedReset(iso: string | undefined): string | undefined {
	if (!iso) {
		return undefined;
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
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

export interface IMessageActions {
	copy(): void;
	feedback?(value: 'like' | 'dislike'): void;
	fork?(): void;
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

function formatWorkingDuration(startedAt: Date | undefined): string {
	const elapsedMs = Math.max(0, Date.now() - (startedAt?.getTime() ?? Date.now()));
	const totalSeconds = Math.floor(elapsedMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return localize('conv.workingForMS', minutes, seconds);
	}

	return localize('conv.workingForS', seconds);
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
