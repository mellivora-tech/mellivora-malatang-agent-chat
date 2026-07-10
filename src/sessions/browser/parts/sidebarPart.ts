/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { SessionsList } from '../../contrib/sessions/browser/sessionsList.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import { Part } from '../part.js';

export interface ISidebarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	readonly projectsService?: IProjectsService;
	readonly modelsService?: IModelsService;
	readonly skillsService?: ISkillsService;
	readonly onToggleSidebar?: () => void;
}

export class SidebarPart extends Part {
	readonly minimumWidth = 220;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	constructor(private readonly options: ISidebarPartOptions = {}) {
		super('workbench.parts.sidebar', 'sidebar');
	}

	protected render(container: HTMLElement): void {
		container.textContent = '';
		this._register(
			new SessionsList(container, {
				...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
				...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {}),
				...(this.options.projectsService ? { projectsService: this.options.projectsService } : {}),
				...(this.options.modelsService ? { modelsService: this.options.modelsService } : {}),
				...(this.options.skillsService ? { skillsService: this.options.skillsService } : {}),
				...(this.options.onToggleSidebar ? { onToggleSidebar: this.options.onToggleSidebar } : {}),
			}),
		);
	}
}
