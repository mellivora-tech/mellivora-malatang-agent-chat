/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, size } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import type { IDataFilesBridge } from '../../services/dataFiles/common/dataFiles.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import { ConversationView, type ISessionMessageSender } from './conversationView.js';

export class SessionView extends Disposable {
	readonly element: HTMLElement;

	private readonly content: HTMLElement;
	private readonly conversationView: ConversationView;
	private session: IActiveSession | undefined;

	constructor(
		messageSender?: ISessionMessageSender,
		modelsService?: IModelsService,
		projectsService?: IProjectsService,
		skillsService?: ISkillsService,
		sessionsPartService?: ISessionsPartService,
		dataFiles?: IDataFilesBridge,
	) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'session-view';
		this.element.tabIndex = -1;

		this.content = append(this.element, document.createElement('div'));
		this.content.className = 'session-view-content';

		this.conversationView = this._register(new ConversationView(messageSender, modelsService, projectsService, skillsService, sessionsPartService, dataFiles));
		this.content.appendChild(this.conversationView.element);

		this.openSession(undefined);
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.conversationView.openSession(session);
			return;
		}

		this.session = session;

		this.element.classList.toggle('empty', !session);
		this.conversationView.openSession(session);
	}

	setActive(active: boolean): void {
		this.element.classList.toggle('is-active', active);
	}

	focus(): void {
		this.conversationView.focus();
	}

	layout(width: number, height: number): void {
		size(this.element, width, height);
	}
}
