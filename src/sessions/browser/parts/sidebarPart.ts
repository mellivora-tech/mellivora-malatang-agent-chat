/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { SessionsList } from '../../contrib/sessions/browser/sessionsList.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface ISidebarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
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
			}),
		);
	}
}
