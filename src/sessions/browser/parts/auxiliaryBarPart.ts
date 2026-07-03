/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { MutableDisposable } from '../../base/common/lifecycle.js';
import { ChangesView } from '../../contrib/changes/browser/changesView.js';
import { FilesView } from '../../contrib/files/browser/filesView.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface IAuxiliaryBarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

type AuxiliaryTab = 'changes' | 'files';

export class AuxiliaryBarPart extends Part {
	readonly minimumWidth = 260;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	private readonly currentView = this._register(new MutableDisposable<ChangesView | FilesView>());
	private activeTab: AuxiliaryTab = 'changes';
	private tabContainer!: HTMLElement;
	private contentContainer!: HTMLElement;

	constructor(private readonly options: IAuxiliaryBarPartOptions = {}) {
		super('workbench.parts.auxiliarybar', 'auxiliarybar');
	}

	protected render(container: HTMLElement): void {
		container.textContent = '';

		const root = document.createElement('div');
		root.className = 'auxiliary-bar';
		container.appendChild(root);

		this.tabContainer = document.createElement('div');
		this.tabContainer.className = 'auxiliary-tabs';
		root.appendChild(this.tabContainer);

		this.contentContainer = document.createElement('div');
		this.contentContainer.className = 'auxiliary-content';
		root.appendChild(this.contentContainer);

		this.renderTabs();
		this.renderActiveView();
	}

	private renderTabs(): void {
		this.tabContainer.textContent = '';

		for (const tab of [
			{ id: 'changes' as const, label: 'Changes', icon: 'codicon-git-compare' },
			{ id: 'files' as const, label: 'Files', icon: 'codicon-files' }
		]) {
			const button = document.createElement('button');
			button.className = 'auxiliary-tab';
			button.type = 'button';
			button.setAttribute('aria-selected', String(tab.id === this.activeTab));
			if (tab.id === this.activeTab) {
				button.classList.add('active');
			}
			button.addEventListener('click', () => {
				if (this.activeTab === tab.id) {
					return;
				}

				this.activeTab = tab.id;
				this.renderTabs();
				this.renderActiveView();
			});

			const icon = document.createElement('span');
			icon.className = `codicon ${tab.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);

			const label = document.createElement('span');
			label.textContent = tab.label;
			button.appendChild(label);

			this.tabContainer.appendChild(button);
		}
	}

	private renderActiveView(): void {
		this.contentContainer.textContent = '';

		if (this.activeTab === 'changes') {
			this.currentView.value = new ChangesView(this.contentContainer, {
				...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
				...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {})
			});
			return;
		}

		this.currentView.value = new FilesView(this.contentContainer);
	}
}
