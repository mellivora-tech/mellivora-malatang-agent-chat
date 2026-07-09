/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { clearNode } from '../../base/browser/dom.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { WorkbenchMode } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import { Part } from '../part.js';
import { NewSessionView } from './newSessionView.js';
import { SessionView } from './sessionView.js';

export class SessionsPart extends Part {
	readonly minimumWidth = 640;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.High;

	private readonly sessionView: SessionView;
	private readonly newSessionView: NewSessionView;
	private container: HTMLElement | undefined;
	private mode: WorkbenchMode = 'newSession';
	private activeSession: IActiveSession | undefined;
	private width = 0;
	private height = 0;

	constructor(
		private readonly sessionsService?: ISessionsService,
		private readonly projectsService?: IProjectsService,
		modelsService?: IModelsService,
	) {
		super('workbench.parts.sessions', 'sessionspart');
		this.newSessionView = this._register(
			new NewSessionView({
				onStartSession: query => this.sessionsService?.startSession(query, this.getStartSessionOptions()) ?? Promise.resolve(),
				...(this.projectsService ? { projectsService: this.projectsService } : {}),
				...(modelsService ? { modelsService } : {}),
			}),
		);
		this.sessionView = this._register(new SessionView(this.sessionsService, modelsService));
	}

	private getStartSessionOptions(): { workspace: { label: string; description: string }; projectId: string } | undefined {
		const project = this.projectsService?.activeProject.get();
		return project ? { workspace: { label: project.name, description: project.path }, projectId: project.id } : undefined;
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.activeSession = active ?? visible.find((session): session is IActiveSession => Boolean(session));
		this.syncContent();
	}

	updateWorkbenchMode(mode: WorkbenchMode): void {
		this.mode = mode;
		this.syncContent();
	}

	focusSession(sessionId: string | undefined): void {
		const targetSessionId = sessionId ?? this.activeSession?.sessionId;
		if (!targetSessionId || targetSessionId === this.activeSession?.sessionId) {
			this.sessionView.focus();
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		this.width = this.element.clientWidth;
		this.height = this.element.clientHeight;
		this.layoutSessionView();
	}

	protected override render(container: HTMLElement): void {
		clearNode(container);
		this.container = document.createElement('div');
		this.container.className = 'sessions-part-container';
		container.appendChild(this.container);
		this.syncContent();
	}

	private syncContent(): void {
		if (!this.container) {
			return;
		}

		const showNewSession = this.mode === 'newSession' || !this.activeSession;
		this.container.classList.toggle('is-new-session', showNewSession);
		if (showNewSession) {
			this.sessionView.element.remove();
			this.sessionView.openSession(undefined);

			if (this.newSessionView.element.parentElement !== this.container) {
				this.container.appendChild(this.newSessionView.element);
			}
			return;
		}

		this.newSessionView.element.remove();
		if (this.sessionView.element.parentElement !== this.container) {
			this.container.appendChild(this.sessionView.element);
		}
		this.sessionView.openSession(this.activeSession);
		this.sessionView.setActive(true);

		this.layoutSessionView();
	}

	private layoutSessionView(): void {
		if (this.mode !== 'conversation' || this.sessionView.element.parentElement !== this.container) {
			return;
		}

		this.sessionView.layout(this.width, this.height);
	}
}
