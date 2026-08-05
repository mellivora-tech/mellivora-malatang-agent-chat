/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { PermissionMode } from '../../services/agent/common/agent.js';
import { permissionMode } from '../../services/agent/browser/permissionModeService.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type {
	ISession,
	ISessionAttachment,
	ISessionContextUsage,
	ISessionMessage,
	ISessionPausedRun,
	ISessionPendingApproval,
	ISessionReconnect,
} from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus, estimateSessionTokens } from '../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import { installSlashCommands, TEMPLATE_COMMANDS, type IComposerCommand } from './composerCommands.js';
import { installImageAttachments, type IImageController } from './composerImages.js';
import { installPromptHistory, type IPromptHistoryController } from './composerHistory.js';
import { installFileMentions, installSessionMentions, installSkillMentions, type IMentionController } from './composerMentions.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';
import { ApprovalDock } from './approvalDock.js';
import { listReferencableSessions } from './conversationView.js';

export interface IComposerMessageSender {
	sendMessage(sessionId: string, query: string, options?: { readonly attachments?: readonly ISessionAttachment[]; readonly images?: readonly IPendingImage[] }): Promise<unknown>;
	stopSession(sessionId: string): Promise<unknown>;
	resumeSession?(sessionId: string): Promise<unknown>;
	setSessionPermissionMode?(sessionId: string, mode: PermissionMode): Promise<unknown>;
	forkSession?(sessionId: string, messageId: string): Promise<unknown>;
	getSessions?(): readonly ISession[];
}

export interface IComposerViewOptions {
	readonly messageSender?: IComposerMessageSender | undefined;
	readonly modelsService?: IModelsService | undefined;
	readonly projectsService?: IProjectsService | undefined;
	readonly skillsService?: ISkillsService | undefined;
	readonly sessionsPartService?: ISessionsPartService | undefined;
	/** Called once a message is successfully dispatched. */
	readonly onSend?: (() => void) | undefined;
}

export interface IComposerRenderModel {
	readonly sessionId: string | undefined;
	readonly projectId: string | undefined;
	readonly status: SessionStatus;
	readonly interactivity: SessionInteractivity;
	readonly messages: readonly ISessionMessage[];
	readonly contextUsage: ISessionContextUsage | undefined;
	readonly pausedRun: ISessionPausedRun | undefined;
	readonly reconnect: ISessionReconnect | undefined;
	readonly permissionMode: PermissionMode;
	readonly approvals: readonly ISessionPendingApproval[];
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The bottom composer: input, send/stop, mentions, images, model/permission
 * pickers, paused-run banner, context ring, reconnect status, and the docked
 * approval strip. The header (ConversationContext) lives outside this view and
 * is inserted via {@link insertHeader} so the parent can keep its session
 * lifecycle coupling.
 */
export class ComposerView extends Disposable {
	readonly element: HTMLFormElement;
	readonly input: HTMLTextAreaElement;

	private readonly approvalDock: ApprovalDock;
	private readonly pausedBanner: HTMLElement;
	private readonly pausedBannerText: HTMLElement;
	private readonly pausedBannerResume: HTMLButtonElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly sendError: HTMLElement;
	private readonly reconnectStatus: HTMLElement;
	private readonly reconnectLabel: HTMLElement;
	private readonly contextRing: HTMLElement;
	// Portaled to <body> — see the comment on createContextRing for why.
	private readonly contextPopover: HTMLElement;

	private readonly mentions: IMentionController;
	private readonly skillMentions: IMentionController;
	private readonly sessionMentions: IMentionController;
	private readonly images: IImageController;
	private readonly promptHistory: IPromptHistoryController;

	private isSending = false;
	private isStopping = false;
	private queuedFollowUp: string | undefined;
	private lastModel: IComposerRenderModel | undefined;
	private lastPermissionMode: PermissionMode | undefined;
	private readonly permissionListeners = new Set<() => void>();

	constructor(private readonly options: IComposerViewOptions) {
		super();

		this.element = document.createElement('form');
		this.element.className = 'conversation-composer';

		// Docked approval strip: pending decisions live here, above the input,
		// in a FIXED spot — the transcript is the record of what happened, the
		// composer zone is what needs the user NOW. Parallel tool batches stack
		// several cards; each resolves independently.
		this.approvalDock = this._register(new ApprovalDock());
		this.element.appendChild(this.approvalDock.element);

		// Frozen-run banner (#19 缺陷 2): sits between the context bar and the
		// input. Not an error — a waiting state with its own exit button.
		this.pausedBanner = append(this.element, document.createElement('div'));
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
			const sessionId = this.lastModel?.sessionId;
			if (sessionId) {
				this.pausedBannerResume.disabled = true;
				void this.options.messageSender?.resumeSession?.(sessionId);
			}
		});

		const inputWrap = append(this.element, document.createElement('div'));
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
					const projectId = this.lastModel?.projectId;
					return projectId && this.options.projectsService ? this.options.projectsService.listProjectFiles(projectId) : undefined;
				},
			}),
		);
		this.skillMentions = this._register(
			installSkillMentions({
				host: this.element,
				input: this.input,
				getSkills: () => this.options.skillsService?.skills.get() ?? [],
			}),
		);
		this.sessionMentions = this._register(
			installSessionMentions({
				host: this.element,
				input: this.input,
				getSessions: () => listReferencableSessions(this.options.messageSender?.getSessions?.() ?? [], this.lastModel?.sessionId),
			}),
		);
		this.images = this._register(installImageAttachments({ input: this.input, dropTarget: this.element, onDidChange: () => this.updateComposerState(this.lastModel) }));

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
					get: () => this.lastModel?.permissionMode ?? permissionMode.get(),
					set: mode => {
						const sessionId = this.lastModel?.sessionId;
						if (sessionId) {
							void this.options.messageSender?.setSessionPermissionMode?.(sessionId, mode);
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

		if (this.options.modelsService) {
			// Host the menus on the view root — the composer clips overflow.
			this._register(installModelPicker({ host: this.element, trigger: model, label: modelLabel, modelsService: this.options.modelsService }));
			this._register(installEffortPicker({ host: this.element, trigger: effort, label: effortLabel, modelsService: this.options.modelsService }));
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

		this.sendError = append(this.element, document.createElement('div'));
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
					const renderModel = this.lastModel;
					const sessionId = renderModel?.sessionId;
					const lastMessage = renderModel?.messages.at(-1);
					return [
						{ name: 'model', kind: 'action', description: localize('conv.action.pickModel'), run: () => model.click() },
						{ name: 'permission', kind: 'action', description: localize('conv.action.pickPermission'), run: () => access.click() },
						...(sessionId && lastMessage && this.options.messageSender?.forkSession
							? [
									{
										name: 'fork',
										kind: 'action' as const,
										description: localize('conv.action.fork'),
										run: () => void this.options.messageSender!.forkSession!(sessionId, lastMessage.id),
									},
								]
							: []),
						...(renderModel?.status === SessionStatus.InProgress
							? [{ name: 'stop', kind: 'action' as const, description: localize('conv.action.stop'), run: () => void this.stop(sessionId!) }]
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
				getHistory: () => (this.lastModel?.messages ?? []).filter(message => message.role === 'user').map(message => message.text),
			}),
		);

		// Data browser → composer: structured reference text lands in the input
		// (consume-once; the observable resets so the same text can come again).
		if (this.options.sessionsPartService) {
			const insertRequest = this.options.sessionsPartService.composerInsertRequest;
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
	}

	/**
	 * Insert the session header between the approval dock and the paused banner.
	 * The header is owned by the parent because it needs the full IActiveSession
	 * to subscribe to workspace/branch observables.
	 */
	insertHeader(header: HTMLElement): void {
		this.element.insertBefore(header, this.pausedBanner);
	}

	override dispose(): void {
		// Portaled to <body>, outside `this.element` — removing the view's own
		// root would never take this with it.
		this.contextPopover.remove();
		super.dispose();
	}

	render(model: IComposerRenderModel): void {
		this.lastModel = model;

		this.element.classList.toggle('empty', !model.sessionId);

		if (model.permissionMode !== this.lastPermissionMode) {
			this.lastPermissionMode = model.permissionMode;
			this.notifyPermissionListeners();
		}

		this.approvalDock.render(model.approvals, model.sessionId, {
			shouldFocusComposer: () => !(document.activeElement === this.input && this.input.value !== ''),
			focusComposer: () => this.input.focus(),
		});

		this.updateComposerState(model);
		this.updateContextRing(model);
		this.updatePausedBanner(model);
		this.updateReconnectStatus(model);

		if (model.status !== SessionStatus.InProgress) {
			this.flushQueuedFollowUp(model);
		}
	}

	focus(): void {
		if (!this.input.disabled) {
			this.input.focus();
			return;
		}

		this.element.focus();
	}

	/** Clear composer-specific per-session state (drafts, images, history index). */
	reset(): void {
		this.setSendError(undefined);
		this.queuedFollowUp = undefined;
		this.mentions.reset();
		this.skillMentions.reset();
		this.sessionMentions.reset();
		this.images.reset();
		this.promptHistory.reset();
	}

	setSendError(message: string | undefined): void {
		this.sendError.textContent = message ?? '';
		this.sendError.hidden = !message;
	}

	private _registerEventListeners(): void {
		this.element.addEventListener('submit', event => {
			event.preventDefault();
			const model = this.lastModel;
			if (model) {
				void this.send(model);
			}
		});

		this.stopButton.addEventListener('click', () => {
			const sessionId = this.lastModel?.sessionId;
			if (sessionId) {
				void this.stop(sessionId);
			}
		});

		this.input.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}

			event.preventDefault();
			const model = this.lastModel;
			if (model) {
				void this.send(model);
			}
		});

		this.input.addEventListener('input', () => this.updateComposerState(this.lastModel));
	}

	private updateComposerState(model: IComposerRenderModel | undefined): void {
		const interactivity = model?.interactivity ?? SessionInteractivity.Full;
		const isRunning = model?.status === SessionStatus.InProgress;
		const canType = Boolean(model?.sessionId && interactivity === SessionInteractivity.Full && !this.isSending);
		const hasText = this.input.value.trim().length > 0;
		const hasContent = hasText || this.images.hasImages();

		this.element.hidden = interactivity === SessionInteractivity.Hidden;
		this.element.classList.toggle('running', isRunning);
		this.element.classList.toggle('idle', !isRunning);
		this.element.dataset.state = isRunning ? 'running' : 'idle';
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

	private async send(model: IComposerRenderModel): Promise<void> {
		const query = this.input.value.trim();
		const sessionId = model.sessionId;
		if ((!query && !this.images.hasImages()) || !sessionId || this.isSending || model.interactivity !== SessionInteractivity.Full) {
			return;
		}

		// Never start a second run on top of a live one — hold the follow-up and
		// send it when the run settles (see flushQueuedFollowUp).
		if (model.status === SessionStatus.InProgress) {
			this.queuedFollowUp = query;
			this.input.value = '';
			this.updateComposerState(model);
			return;
		}

		this.isSending = true;
		this.setSendError(undefined);
		this.updateComposerState(model);
		// Sending returns the reader to the live end of the conversation.
		this.options.onSend?.();

		try {
			const attachments = [...this.mentions.collectAttachments(query), ...this.skillMentions.collectAttachments(query), ...this.sessionMentions.collectAttachments(query)];
			const images = this.images.getImages();
			await this.options.messageSender?.sendMessage(sessionId, query, {
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
			this.updateComposerState(model);
		}
	}

	private async stop(sessionId: string): Promise<void> {
		if (this.isStopping) {
			return;
		}

		this.isStopping = true;
		this.stopButton.disabled = true;

		try {
			await this.options.messageSender?.stopSession(sessionId);
		} catch {
			this.setSendError('Could not stop the session.');
		} finally {
			this.isStopping = false;
			this.stopButton.disabled = false;
		}
	}

	/** Send a queued follow-up once the current run has settled. */
	private flushQueuedFollowUp(model: IComposerRenderModel): void {
		const query = this.queuedFollowUp;
		if (query === undefined || this.isSending || !model.sessionId || model.status === SessionStatus.InProgress) {
			return;
		}
		this.queuedFollowUp = undefined;
		this.input.value = query;
		void this.send(model);
	}

	private notifyPermissionListeners(): void {
		for (const listener of this.permissionListeners) {
			listener();
		}
	}

	private updateReconnectStatus(model: IComposerRenderModel | undefined): void {
		const reconnect = model?.reconnect;
		this.reconnectStatus.hidden = !reconnect;
		this.reconnectLabel.textContent = reconnect ? localize('conv.reconnecting', reconnect.attempt, reconnect.maxAttempts) : '';
	}

	/** The frozen-run banner (#19 缺陷 2): cause + concrete recovery plan, and the manual resume. */
	private updatePausedBanner(model: IComposerRenderModel | undefined): void {
		const paused = model?.pausedRun;
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

	/**
	 * The ring beside the model picker shows how much of the selected model's
	 * context window this conversation occupies. Prefers the provider's real
	 * token count from the most recent request (`model.contextUsage`); falls
	 * back to a ~4-chars-per-token estimate until the first reading arrives (or
	 * for providers that don't report usage). Hovering it reveals a two-line
	 * popover with the exact reading — "Context window: / N% used (M% left)".
	 * Hidden until a window size is known (nothing to be a percentage of).
	 */
	private updateContextRing(model: IComposerRenderModel | undefined): void {
		const fill = this.contextRing.querySelector<SVGCircleElement>('.ring-fill');
		const value = this.contextPopover.querySelector<HTMLElement>('.conversation-context-popover-value');
		const breakdownList = this.contextPopover.querySelector<HTMLElement>('.conversation-context-breakdown');
		const footnote = this.contextPopover.querySelector<HTMLElement>('.conversation-context-popover-footnote');
		if (!fill || !value || !breakdownList || !footnote) {
			return;
		}

		const contextLength = this.options.modelsService?.selectedModel.get()?.contextLength;
		if (!contextLength) {
			this.contextRing.hidden = true;
			this.hideContextPopover();
			return;
		}

		const usage = model?.contextUsage;
		// `usage.inputTokens` is already the best number the provider has — a
		// real bill from this process, a restored bill from the last run, or a
		// char/4 estimate. `totalSource` says which; when contextUsage hasn't
		// been touched at all yet, fall back the same way the provider itself
		// would (same formula, so the two never drift).
		const messages = model?.messages ?? [];
		const tokens = usage ? usage.inputTokens : estimateSessionTokens(messages);
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
}

export function conversationStatusId(status: SessionStatus): string {
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

function appendCodicon(parent: HTMLElement, codicon: string): HTMLElement {
	const icon = append(parent, document.createElement('span'));
	icon.className = `codicon ${codicon}`;
	icon.setAttribute('aria-hidden', 'true');
	return icon;
}

function createContextRing(): HTMLElement {
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

function formatTokensWithPct(tokens: number, contextLength: number): string {
	const pct = contextLength > 0 ? (tokens / contextLength) * 100 : 0;
	return `~${formatTokens(tokens)} tokens (${pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(1)}%)`;
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

function formatBreakdownEntry(chars: number, contextLength: number): string {
	return formatTokensWithPct(Math.round(chars / 4), contextLength);
}

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
