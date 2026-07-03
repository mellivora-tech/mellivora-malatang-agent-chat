/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface IAuxiliaryBarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

export class AuxiliaryBarPart extends Part {
	readonly minimumWidth = 260;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	constructor(private readonly options: IAuxiliaryBarPartOptions = {}) {
		super('workbench.parts.auxiliarybar', 'auxiliarybar');
	}

	protected render(container: HTMLElement): void {
		container.textContent = '';

		const root = document.createElement('div');
		root.className = 'auxiliary-bar auxiliary-empty';
		container.appendChild(root);

		const content = document.createElement('div');
		content.className = 'auxiliary-empty-content';
		root.appendChild(content);

		const title = document.createElement('h2');
		title.className = 'auxiliary-empty-title';
		title.textContent = 'Open tab';
		content.appendChild(title);

		const description = document.createElement('p');
		description.className = 'auxiliary-empty-description';
		description.textContent = 'Choose a tab to open in the side pane.';
		content.appendChild(description);

		const cards = document.createElement('div');
		cards.className = 'auxiliary-empty-cards';
		content.appendChild(cards);

		for (const tab of [
			{ label: 'Review', icon: 'codicon-diff' },
			{ label: 'Terminal', icon: 'codicon-terminal' },
			{ label: 'Browser', icon: 'codicon-globe' }
		]) {
			const button = document.createElement('button');
			button.className = 'auxiliary-empty-card';
			button.type = 'button';
			button.setAttribute('aria-label', tab.label);

			const icon = document.createElement('span');
			icon.className = `codicon ${tab.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);

			const label = document.createElement('span');
			label.textContent = tab.label;
			button.appendChild(label);

			cards.appendChild(button);
		}
	}
}
