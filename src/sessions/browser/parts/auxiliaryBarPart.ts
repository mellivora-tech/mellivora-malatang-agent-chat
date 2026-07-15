/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ChangesView } from '../../contrib/changes/browser/changesView.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface IAuxiliaryBarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

type AuxiliaryTabId = 'review' | 'terminal' | 'browser';

const auxiliaryTabs: readonly {
	readonly id: AuxiliaryTabId;
	readonly label: string;
	readonly icon: string;
	readonly title: string;
	readonly body?: string;
}[] = [
	{
		id: 'review',
		label: 'Review',
		icon: 'codicon-diff',
		title: 'Review',
	},
	{
		id: 'terminal',
		label: 'Terminal',
		icon: 'codicon-terminal',
		title: 'Terminal',
		body: 'No terminal session started',
	},
	{
		id: 'browser',
		label: 'Browser',
		icon: 'codicon-globe',
		title: 'Browser',
		body: 'No browser preview open',
	},
];

export class AuxiliaryBarPart extends Part {
	readonly minimumWidth = 260;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	private container: HTMLElement | undefined;
	private activeTab: AuxiliaryTabId | undefined;
	private readonly viewDisposables = this._register(new DisposableStore());

	constructor(private readonly options: IAuxiliaryBarPartOptions = {}) {
		super('workbench.parts.auxiliarybar', 'auxiliarybar');
	}

	protected render(container: HTMLElement): void {
		this.container = container;
		this.renderContent();
	}

	private renderContent(): void {
		const container = this.container;
		if (!container) {
			return;
		}

		this.viewDisposables.clear();
		container.textContent = '';

		const root = document.createElement('div');
		root.className = this.activeTab ? 'auxiliary-bar' : 'auxiliary-bar auxiliary-empty';
		container.appendChild(root);

		if (this.activeTab) {
			this.renderTabbedPane(root, this.activeTab);
			return;
		}

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

		for (const tab of auxiliaryTabs) {
			const button = document.createElement('button');
			button.className = 'auxiliary-empty-card';
			button.type = 'button';
			button.setAttribute('aria-label', tab.label);
			button.addEventListener('click', () => this.openTab(tab.id));

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

	private renderTabbedPane(root: HTMLElement, activeTabId: AuxiliaryTabId): void {
		const tabs = document.createElement('div');
		tabs.className = 'auxiliary-tabs';
		tabs.setAttribute('role', 'tablist');
		root.appendChild(tabs);

		for (const tab of auxiliaryTabs) {
			const button = document.createElement('button');
			button.className = 'auxiliary-tab';
			button.classList.toggle('active', tab.id === activeTabId);
			button.type = 'button';
			button.dataset.tabId = tab.id;
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(tab.id === activeTabId));
			button.addEventListener('click', () => this.openTab(tab.id));

			const icon = document.createElement('span');
			icon.className = `codicon ${tab.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);

			const label = document.createElement('span');
			label.textContent = tab.label;
			button.appendChild(label);

			tabs.appendChild(button);
		}

		const activeTab = auxiliaryTabs.find(tab => tab.id === activeTabId)!;
		const content = document.createElement('div');
		content.className = 'auxiliary-content';
		root.appendChild(content);

		const view = document.createElement('section');
		view.className = 'auxiliary-view';
		view.dataset.tabId = activeTab.id;
		content.appendChild(view);

		const title = document.createElement('h2');
		title.className = 'auxiliary-view-title';
		title.textContent = activeTab.title;
		view.appendChild(title);

		const body = document.createElement('div');
		body.className = 'auxiliary-view-body';
		view.appendChild(body);

		if (activeTab.id === 'review') {
			this.viewDisposables.add(
				new ChangesView(body, {
					...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
					...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {}),
				}),
			);
		} else {
			body.textContent = activeTab.body ?? '';
		}
	}

	private openTab(tabId: AuxiliaryTabId): void {
		this.activeTab = tabId;
		this.renderContent();
	}
}
