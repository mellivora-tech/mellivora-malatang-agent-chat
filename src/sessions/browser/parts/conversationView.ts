/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveLocale } from '../../common/i18n/i18n.js';
import { append } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IModelsBridge } from '../../services/models/common/models.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { IActiveSession, IPlanComment, ISession, ISessionAttachment } from '../../services/sessions/common/session.js';
import { SessionInteractivity, SessionStatus } from '../../services/sessions/common/session.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import type { IDataFilesBridge } from '../../services/dataFiles/common/dataFiles.js';
import type { PermissionMode } from '../../services/agent/common/agent.js';
import { permissionMode } from '../../services/agent/browser/permissionModeService.js';
import { TimelineRail } from './timelineRail.js';
import { TranscriptView } from './transcriptView.js';
import { ComposerView, conversationStatusId } from './composerView.js';
import { ConversationContext } from './conversationContext.js';
import { installQuotaIndicator, type IQuotaIndicator } from './quotaIndicator.js';

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

export class ConversationView extends Disposable {
	readonly element: HTMLElement;

	private readonly transcriptView: TranscriptView;
	private readonly timelineRail: TimelineRail;
	private readonly composerView: ComposerView;
	private readonly header = this._register(new ConversationContext());
	private readonly quotaIndicator: IQuotaIndicator;
	private readonly sessionDisposables = this._register(new DisposableStore());
	private session: IActiveSession | undefined;

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
				onFocusComposer: () => this.composerView.focus(),
			}),
		);

		this.timelineRail = this._register(new TimelineRail(this.element, this.transcriptView.element));
		bodyWrap.appendChild(this.transcriptView.element);
		bodyWrap.insertBefore(this.timelineRail.element, this.transcriptView.element);

		this.composerView = this._register(
			new ComposerView({
				messageSender,
				modelsService,
				projectsService,
				skillsService,
				sessionsPartService,
				onSend: () => this.transcriptView.stickToBottomOnNextRender(),
			}),
		);
		this.composerView.insertHeader(this.header.element);
		this.element.appendChild(this.composerView.element);

		// Coding-plan quota (#19): lives at the RIGHT EDGE of the context bar
		// above the composer (user-picked placement 2026-07-20).
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

		// Artifacts panel → transcript (#13 P1): only the view hosting the
		// requested session consumes (split views each subscribe; a mismatch
		// must leave the request for the right one).
		if (this.sessionsPartService) {
			const revealRequest = this.sessionsPartService.artifactRevealRequest;
			this._register(
				revealRequest.subscribe(() => {
					const request = revealRequest.get();
					if (!request || this.session?.sessionId !== request.sessionId) {
						return;
					}
					revealRequest.set(undefined);
					this.transcriptView.revealMessage(request.messageId);
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
		this.transcriptView.clear();
		this.composerView.reset();
		this.header.openSession(session);
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
					// A run settling is what moves the plan quota — re-read it as
					// soon as the session leaves InProgress instead of waiting for
					// the 5-minute timer.
					if (session.status.get() !== SessionStatus.InProgress) {
						this.quotaIndicator.refresh();
					}
				}),
			);
			this.sessionDisposables.add(session.pendingApprovals.subscribe(() => this.render()));
			this.sessionDisposables.add(session.contextUsage.subscribe(() => this.render()));
			this.sessionDisposables.add(session.pausedRun.subscribe(() => this.render()));
			this.sessionDisposables.add(session.reconnect.subscribe(() => this.render()));
			this.sessionDisposables.add(session.permissionMode.subscribe(() => this.render()));
		}
		this.render();
	}

	focus(): void {
		this.composerView.focus();
	}

	private _registerEventListeners(): void {
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
		const session = this.session;
		this.element.classList.toggle('empty', !session);
		this.element.dataset.status = session ? conversationStatusId(session.status.get()) : 'empty';
		this.element.dataset.interactivity = session?.interactivity.get() ?? 'none';

		const messages = (session?.messages.get() ?? []).filter(message => message.role !== 'digest');
		const approvals = session?.pendingApprovals.get() ?? [];

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

		this.composerView.render({
			sessionId: session?.sessionId,
			projectId: session?.projectId,
			status: session?.status.get() ?? SessionStatus.Untitled,
			interactivity: session?.interactivity.get() ?? SessionInteractivity.Full,
			messages,
			contextUsage: session?.contextUsage.get(),
			pausedRun: session?.pausedRun.get(),
			reconnect: session?.reconnect.get(),
			permissionMode: session?.permissionMode.get() ?? permissionMode.get(),
			approvals,
		});

		this.timelineRail.render(messages);
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

export interface IMessageActions {
	copy(): void;
	feedback?(value: 'like' | 'dislike'): void;
	fork?(): void;
}
