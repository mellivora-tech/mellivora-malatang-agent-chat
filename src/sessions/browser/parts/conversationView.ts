/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveLocale, localize } from '../../common/i18n/i18n.js';
import { append } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { IActiveSession, IPlanComment, ISession, ISessionAttachment } from '../../services/sessions/common/session.js';
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
import { TimelineRail } from './timelineRail.js';
import { ApprovalDock } from './approvalDock.js';
import { TranscriptView } from './transcriptView.js';
import type { IModelsBridge } from '../../services/models/common/models.js';
import { permissionMode } from '../../services/agent/browser/permissionModeService.js';
import type { PermissionMode } from '../../services/agent/common/agent.js';
import { toDisposable } from '../../base/common/lifecycle.js';

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
	/** Markdown of a split answer's document attachment — the reference card's expand (#13 长答案分流). */
	resolveDocumentText?(sessionId: string, path: string): Promise<string | undefined>;
	/** All sessions, for the #-mention picker (sessionsService satisfies this structurally). */
	getSessions?(): readonly ISession[];
}

// A reader within this band above the live end counts as "following the
// output" — renders keep them pinned; anything further up is a deliberate
// scroll-back whose position must be preserved.

export class ConversationView extends Disposable {
	readonly element: HTMLElement;

	private readonly transcriptView: TranscriptView;
	private readonly timelineRail: TimelineRail;
	private readonly composer: HTMLFormElement;
	private readonly approvalDock: ApprovalDock;
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
	// Fan-out for the session-aware permission picker (the underlying observable
	// swaps whenever another session becomes active).
	private readonly permissionListeners = new Set<() => void>();

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

		this.transcriptView = this._register(
			new TranscriptView({
				messageSender,
				sessionsPartService,
				dataFiles,
				onScroll: () => this.timelineRail.updateCurrent(),
				onFocusComposer: () => this.input.focus(),
			}),
		);

		this.timelineRail = this._register(new TimelineRail(this.element, this.transcriptView.element));
		bodyWrap.insertBefore(this.timelineRail.element, this.transcriptView.element);
		bodyWrap.appendChild(this.transcriptView.element);

		this.composer = append(this.element, document.createElement('form'));
		this.composer.className = 'conversation-composer';

		// Docked approval strip: pending decisions live here, above the input,
		// in a FIXED spot — the transcript is the record of what happened, the
		// composer zone is what needs the user NOW. Parallel tool batches stack
		// several cards; each resolves independently.
		this.approvalDock = this._register(new ApprovalDock());
		this.composer.appendChild(this.approvalDock.element);

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

			// Artifacts panel → transcript (#13 P1): only the view hosting the
			// requested session consumes (split views each subscribe; a mismatch
			// must leave the request for the right one).
			const revealRequest = this.sessionsPartService.artifactRevealRequest;
			this._register(
				revealRequest.subscribe(() => {
					const request = revealRequest.get();
					if (!request || this.session?.sessionId !== request.sessionId) {
						return;
					}
					revealRequest.set(undefined);
					this.revealMessage(request.messageId);
				}),
			);
		}

		this._registerEventListeners();
		this.render();
	}

	private revealMessage(messageId: string): void {
		this.transcriptView.revealMessage(messageId);
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
		this.transcriptView.clear();
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
		this.transcriptView.stickToBottomOnNextRender();

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
			this.sessionDisposables.add(session.pendingApprovals.subscribe(() => this.render()));
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
		this.timelineRail.element.addEventListener('mousemove', event => {
			magnifyPointerY = event.clientY;
			if (magnifyScheduled) {
				return;
			}
			magnifyScheduled = true;
			requestAnimationFrame(() => {
				magnifyScheduled = false;
				this.timelineRail.magnify(magnifyPointerY);
			});
		});
		this.timelineRail.element.addEventListener('mouseleave', () => {
			magnifyPointerY = undefined;
			this.timelineRail.magnify(undefined);
		});
	}

	private render(): void {
		this.element.classList.toggle('empty', !this.session);
		this.element.dataset.status = this.session ? conversationStatusId(this.session.status.get()) : 'empty';
		this.element.dataset.interactivity = this.session?.interactivity.get() ?? 'none';
		this.header.element.hidden = !this.session;

		const messages = (this.session?.messages.get() ?? []).filter(message => message.role !== 'digest');
		const approvals = this.session?.pendingApprovals.get() ?? [];
		const session = this.session;
		this.transcriptView.render({
			messages,
			sessionId: session?.sessionId,
			projectId: session?.projectId,
			status: session?.status.get() ?? SessionStatus.Untitled,
			createdAt: session?.createdAt,
			hasPendingApprovals: approvals.length > 0,
			interactivity: session?.interactivity.get() ?? SessionInteractivity.Full,
			planComments: session?.planComments,
		});

		this.approvalDock.render(approvals, session?.sessionId, {
			shouldFocusComposer: () => !(document.activeElement === this.input && this.input.value !== ''),
			focusComposer: () => this.input.focus(),
		});

		this.timelineRail.render(messages);
		this.updateComposerState();
		this.updateContextRing();
	}

	override dispose(): void {
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
		this.transcriptView.stickToBottomOnNextRender();

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
