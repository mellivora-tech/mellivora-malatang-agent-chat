/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { IDataFilesBridge } from '../../services/dataFiles/common/dataFiles.js';
import type { IPlanComment, ISessionDataBrowse, ISessionMessage } from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../services/sessions/common/session.js';
import type { IObservable } from '../../base/common/observable.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import { createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { mountOrUpdateReactRow } from './agentUi/bridge/mountReactRow.js';
import { MessageRow } from './agentUi/components/MessageRow.js';
import { PlanCard } from './agentUi/components/PlanCard.js';
import { UiCard } from './agentUi/components/UiCard.js';
import { WorkBlock } from './agentUi/components/WorkBlock.js';
import type { IMessageActions, ISessionMessageSender } from './conversationView.js';

export type ITranscriptMessageSender = ISessionMessageSender;

export interface ITranscriptViewOptions {
	readonly messageSender?: ITranscriptMessageSender | undefined;
	readonly sessionsPartService?: ISessionsPartService | undefined;
	readonly dataFiles?: IDataFilesBridge | undefined;
	/** Called on transcript scroll (throttled to rAF). */
	readonly onScroll?: (() => void) | undefined;
	/** Called when a row requests focus back on the composer input. */
	readonly onFocusComposer?: (() => void) | undefined;
}

export interface ITranscriptRenderModel {
	readonly messages: readonly ISessionMessage[];
	readonly sessionId: string | undefined;
	readonly projectId: string | undefined;
	readonly status: SessionStatus;
	readonly createdAt: Date | undefined;
	readonly hasPendingApprovals: boolean;
	readonly interactivity: SessionInteractivity;
	readonly planComments: IObservable<readonly IPlanComment[]> | undefined;
}

// A reader within this band above the live end counts as "following the
// output" — renders keep them pinned; anything further up is a deliberate
// scroll-back whose position must be preserved.
const FOLLOW_BAND_PX = 48;
// settleScrollAtBottom's termination cap: ~1s at 60fps.
const MAX_SETTLE_FRAMES = 60;

/**
 * The scrollable transcript: keyed message rows, React roots, scroll
 * stickiness, and the transient working/thinking rows. Extracted from
 * ConversationView to isolate DOM reconciliation and React bridging from
 * composer and session lifecycle logic.
 */
export class TranscriptView extends Disposable {
	readonly element: HTMLElement;

	// Rendered rows keyed by message id, so a streaming delta patches only the
	// row that actually changed instead of tearing down the whole transcript —
	// rebuilding every row on every token would restart hover-revealed UI (e.g.
	// the message action bar's fade-in) on unrelated, unchanged messages too.
	private readonly renderedRows = new Map<string, { element: HTMLElement; message: ISessionMessage; reactRoot?: Root }>();
	// A follow-up typed while a run is live is held here and sent when it settles,
	// so a second run never overlaps the first (single slot; a newer one replaces it).
	private forceScrollToBottomOnRender = false;
	// rAF handle of the settle loop that re-pins a forced scroll-to-bottom
	// while the transcript is still growing (see settleScrollAtBottom).
	private scrollSettleFrame: number | undefined;
	private workTicker: ReturnType<typeof setInterval> | undefined;
	private lastModel: ITranscriptRenderModel | undefined;

	constructor(private readonly options: ITranscriptViewOptions) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'conversation-transcript';

		// Keep the timeline's position marker in sync with the reading position.
		let scrollScheduled = false;
		this.element.addEventListener('scroll', () => {
			if (scrollScheduled) {
				return;
			}
			scrollScheduled = true;
			requestAnimationFrame(() => {
				scrollScheduled = false;
				this.options.onScroll?.();
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
		this.element.addEventListener(
			'load',
			event => {
				if (event.target instanceof HTMLImageElement && this.isNearBottom(FOLLOW_BAND_PX + event.target.getBoundingClientRect().height)) {
					this.element.scrollTop = this.element.scrollHeight;
				}
			},
			true,
		);
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
		for (const entry of this.renderedRows.values()) {
			entry.reactRoot?.unmount();
		}
		this.renderedRows.clear();
		super.dispose();
	}

	/** Force the transcript to the bottom on the next render(). */
	stickToBottomOnNextRender(): void {
		this.forceScrollToBottomOnRender = true;
	}

	render(model: ITranscriptRenderModel): void {
		this.lastModel = model;

		// A structural change (new/removed row) can move scrollTop; a pure content
		// patch never does. Follow the output while the reader is at (or near) the
		// bottom; preserve their position otherwise.
		const forcedScrollToBottom = this.forceScrollToBottomOnRender;
		const stickToBottom = forcedScrollToBottom || this.isNearBottom(FOLLOW_BAND_PX);
		const previousScrollTop = this.element.scrollTop;
		this.forceScrollToBottomOnRender = false;

		// Digest messages are hidden context for the next run's transcript, not
		// conversation — drop them before any rendering (rows, timeline, tickers).
		const messages = model.messages.filter(message => message.role !== 'digest');
		this.reconcileTranscript(messages, model);

		const hasLiveWork = messages.some(message => message.role === 'work' && message.durationMs === undefined);
		// These trailing rows aren't part of the keyed reconciliation above (they
		// aren't backed by a message id) — always re-evaluate them.
		this.element.querySelector('.conversation-working-row')?.remove();
		this.element.querySelector('.conversation-thinking-row')?.remove();
		if (!model.hasPendingApprovals && model.status === SessionStatus.InProgress && !hasLiveWork && model.interactivity !== SessionInteractivity.Hidden) {
			// Mock/legacy runs without a work block keep the plain progress rows.
			this.element.appendChild(this.createWorkingRow(model.createdAt));
			this.element.appendChild(this.createThinkingRow());
		}

		if (stickToBottom) {
			this.element.scrollTop = this.element.scrollHeight;
		} else {
			this.element.scrollTop = previousScrollTop;
		}
		if (forcedScrollToBottom) {
			this.settleScrollAtBottom();
		}

		this.updateWorkTicker(hasLiveWork);
	}

	/** Remove every row and empty state — used when switching sessions. */
	clear(): void {
		clearNode(this.element);
		for (const entry of this.renderedRows.values()) {
			entry.reactRoot?.unmount();
		}
		this.renderedRows.clear();
		this.lastModel = undefined;
	}

	/**
	 * Scroll a message into view and flash it. Two async producers must finish
	 * first: React commits row content after the synchronous reconcile
	 * (createRoot), and a freshly opened session runs settleScrollAtBottom,
	 * which would re-pin the bottom right over this scroll — so retry frames
	 * until the row exists and the settle loop has terminated (~2s cap, then
	 * give up silently: the message no longer exists).
	 */
	revealMessage(messageId: string, attempt = 0): void {
		const row = this.element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
		if (!row || this.scrollSettleFrame !== undefined) {
			if (attempt < 120) {
				requestAnimationFrame(() => this.revealMessage(messageId, attempt + 1));
			}
			return;
		}
		row.scrollIntoView({ behavior: 'smooth', block: 'center' });
		row.classList.add('artifact-reveal-highlight');
		setTimeout(() => row.classList.remove('artifact-reveal-highlight'), 2000);
	}

	/** Re-pin a forced scroll-to-bottom across the frames in which the transcript
	 *  is still growing. Row content is React-rendered (mountOrUpdateReactRow),
	 *  and createRoot().render() commits ASYNCHRONOUSLY — the synchronous
	 *  `scrollTop = scrollHeight` in render() measures host divs whose content
	 *  hasn't committed yet, so a single shot lands short of the real bottom
	 *  and the freshly opened conversation stays scrolled to the TOP. Keep
	 *  pinning every frame until the scroll height holds steady for two
	 *  consecutive frames (React commits and fast-decoding thumbnails settled),
	 *  capped so the loop always terminates. Late-arriving growth (a slow image
	 *  decode) is covered by the capture-phase `load` listener instead. */
	private settleScrollAtBottom(): void {
		if (this.scrollSettleFrame !== undefined) {
			cancelAnimationFrame(this.scrollSettleFrame);
		}
		let lastHeight = -1;
		let steadyFrames = 0;
		let framesLeft = MAX_SETTLE_FRAMES;
		const step = () => {
			this.element.scrollTop = this.element.scrollHeight;
			const height = this.element.scrollHeight;
			steadyFrames = height === lastHeight ? steadyFrames + 1 : 0;
			lastHeight = height;
			framesLeft -= 1;
			this.scrollSettleFrame = steadyFrames >= 2 || framesLeft <= 0 ? undefined : requestAnimationFrame(step);
		};
		this.scrollSettleFrame = requestAnimationFrame(step);
	}

	/** Whether the reader is within `bandPx` of the live end — the shared "still following" predicate. */
	private isNearBottom(bandPx: number): boolean {
		return this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < bandPx;
	}

	/**
	 * Keyed diff against {@link renderedRows}: a row is created once and then
	 * patched in place for as long as its message id survives. This is what
	 * keeps hover-revealed UI (the message action bar's fade-in, a work step's
	 * expanded detail) from restarting on every streamed token — only the row
	 * whose content actually changed gets touched; every other row, including
	 * ones the reader is currently hovering, is left completely alone.
	 */
	private reconcileTranscript(messages: readonly ISessionMessage[], model: ITranscriptRenderModel): void {
		if (messages.length === 0) {
			if (this.renderedRows.size > 0) {
				clearNode(this.element);
				this.renderedRows.clear();
			}
			if (!this.element.querySelector('.conversation-empty')) {
				const empty = append(this.element, document.createElement('div'));
				empty.className = 'conversation-empty';
				empty.textContent = localize('conv.noMessages');
			}
			return;
		}
		this.element.querySelector('.conversation-empty')?.remove();

		const seen = new Set<string>();
		let cursor: ChildNode | null = this.element.firstChild;

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
					existing.reactRoot = mountOrUpdateReactRow(element, existing.reactRoot, this.createRowElement(message, model));
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
				const reactRoot = mountOrUpdateReactRow(element, undefined, this.createRowElement(message, model));
				this.renderedRows.set(message.id, { element, message, reactRoot });
			}

			if (element === cursor) {
				cursor = cursor.nextSibling;
			} else {
				this.element.insertBefore(element, cursor);
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
		const sessionsPartService = this.options.sessionsPartService;
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
	private createPlanCardElement(message: ISessionMessage, model: ITranscriptRenderModel): ReactNode {
		return createElement(PlanCard, {
			message,
			sessionId: model.sessionId,
			planComments: model.planComments,
			messageSender: this.options.messageSender,
			onFocusComposer: this.options.onFocusComposer ?? (() => undefined),
		});
	}

	/** Dispatches a message to its React row element by role (see reconcileTranscript). */
	private createRowElement(message: ISessionMessage, model: ITranscriptRenderModel): ReactNode {
		switch (message.role) {
			case 'work':
				return this.createWorkBlockElement(message);
			case 'plan':
				return this.createPlanCardElement(message, model);
			case 'ui':
				return createElement(UiCard, {
					message,
					sessionId: model.sessionId,
					messageSender: this.options.messageSender,
					onFocusComposer: this.options.onFocusComposer ?? (() => undefined),
					openSurface: this.options.sessionsPartService ? () => this.options.sessionsPartService!.openSurfacePanel() : undefined,
					// The card supplies sessionId + title; only the view knows the
					// project, so it enriches meta here (#13 P0 export capture).
					exportText: this.options.dataFiles
						? (defaultName, content, meta) =>
								this.options.dataFiles!.exportText(defaultName, content, meta && { ...meta, ...(model.projectId !== undefined ? { projectId: model.projectId } : {}) })
						: undefined,
				});
			default:
				return createElement(MessageRow, {
					message,
					actions: this.buildMessageActions(message, model),
					resolveImage: this.buildImageResolver(model),
					resolveDocument: this.buildDocumentResolver(model),
				});
		}
	}

	private buildMessageActions(message: ISessionMessage, model: ITranscriptRenderModel): IMessageActions | undefined {
		const sessionId = model.sessionId;
		if (!sessionId || (message.role !== 'assistant' && message.role !== 'user')) {
			return undefined;
		}
		const sender = this.options.messageSender;
		return {
			copy: () => void navigator.clipboard.writeText(message.text),
			...(message.role === 'assistant' && sender?.setMessageFeedback
				? {
						feedback: (value: 'like' | 'dislike') => {
							// Clicking the active choice clears it.
							void sender.setMessageFeedback!(sessionId, message.id, message.feedback === value ? undefined : value);
						},
					}
				: {}),
			...(sender?.forkSession ? { fork: () => void sender.forkSession!(sessionId, message.id) } : {}),
		};
	}

	/** Path → data URL for image attachments in the transcript; undefined when the sender can't resolve media. */
	private buildImageResolver(model: ITranscriptRenderModel): ((path: string) => Promise<string | undefined>) | undefined {
		const sessionId = model.sessionId;
		const resolve = this.options.messageSender?.resolveMedia?.bind(this.options.messageSender);
		return sessionId && resolve ? path => resolve(sessionId, path) : undefined;
	}

	/** Path → markdown for document attachments (the split answer's full text); undefined when the sender can't resolve it. */
	private buildDocumentResolver(model: ITranscriptRenderModel): ((path: string) => Promise<string | undefined>) | undefined {
		const sessionId = model.sessionId;
		const resolve = this.options.messageSender?.resolveDocumentText?.bind(this.options.messageSender);
		return sessionId && resolve ? path => resolve(sessionId, path) : undefined;
	}

	private updateWorkTicker(hasLiveWork: boolean): void {
		if (hasLiveWork && this.workTicker === undefined) {
			// The header shows elapsed seconds; deltas already re-render constantly,
			// the ticker only covers quiet stretches (thinking, long tool calls).
			this.workTicker = setInterval(() => this.refresh(), 1000);
		} else if (!hasLiveWork && this.workTicker !== undefined) {
			clearInterval(this.workTicker);
			this.workTicker = undefined;
		}
	}

	private refresh(): void {
		if (this.lastModel) {
			this.render(this.lastModel);
		}
	}

	private createWorkingRow(createdAt: Date | undefined): HTMLElement {
		const row = document.createElement('div');
		row.className = 'conversation-working-row';

		const label = append(row, document.createElement('div'));
		label.className = 'conversation-working-label';
		label.textContent = formatWorkingDuration(createdAt);

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
