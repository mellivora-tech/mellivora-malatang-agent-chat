/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { ChangesView } from '../../contrib/changes/browser/changesView.js';
import { DataBrowserView } from '../../contrib/data/browser/dataBrowserView.js';
import type { IEnvironmentsService } from '../../services/environments/browser/environmentsService.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface IAuxiliaryBarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	readonly environmentsService?: IEnvironmentsService;
}

type AuxiliaryTabKind = 'review' | 'data' | 'terminal' | 'browser';

const tabKinds: readonly {
	readonly kind: AuxiliaryTabKind;
	readonly label: string;
	readonly icon: string;
	readonly body?: string;
}[] = [
	{
		kind: 'review',
		label: 'Review',
		icon: 'codicon-diff',
	},
	{
		kind: 'data',
		label: '数据',
		icon: 'codicon-database',
	},
	{
		kind: 'terminal',
		label: 'Terminal',
		icon: 'codicon-terminal',
		body: 'No terminal session started',
	},
	{
		kind: 'browser',
		label: 'Browser',
		icon: 'codicon-globe',
		body: 'No browser preview open',
	},
];

/** An OPEN tab: an instance the user created, not a fixed destination. Its view
 *  stays mounted while other tabs are active, so switching away loses nothing. */
interface ITabInstance {
	readonly id: string;
	readonly kind: AuxiliaryTabKind;
	label: string;
	readonly container: HTMLElement;
	readonly disposables: DisposableStore;
}

/**
 * The right side pane, Codex-style: tabs are opened instances (closable, added
 * via a "+" menu), not an always-on strip of destinations. One instance per
 * kind for now — reopening a kind focuses it — but the model carries instance
 * ids so multi-instance tools (real terminals) can lift that later.
 */
export class AuxiliaryBarPart extends Part {
	readonly minimumWidth = 260;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	private tabsBar: HTMLElement | undefined;
	private content: HTMLElement | undefined;
	private empty: HTMLElement | undefined;
	private root: HTMLElement | undefined;
	private addMenu: HTMLElement | undefined;
	private readonly menuCleanup = this._register(new DisposableStore());

	private readonly openTabs: ITabInstance[] = [];
	private activeId: string | undefined;
	private instanceCounter = 0;

	constructor(private readonly options: IAuxiliaryBarPartOptions = {}) {
		super('workbench.parts.auxiliarybar', 'auxiliarybar');
		this._register(toDisposable(() => {
			for (const tab of this.openTabs) {
				tab.disposables.dispose();
			}
		}));
	}

	protected render(container: HTMLElement): void {
		const root = document.createElement('div');
		root.className = 'auxiliary-bar auxiliary-empty';
		container.appendChild(root);
		this.root = root;

		this.tabsBar = document.createElement('div');
		this.tabsBar.className = 'auxiliary-tabs';
		this.tabsBar.setAttribute('role', 'tablist');
		root.appendChild(this.tabsBar);

		this.content = document.createElement('div');
		this.content.className = 'auxiliary-content';
		root.appendChild(this.content);

		this.empty = this.renderEmptyState();
		root.appendChild(this.empty);

		this.update();
	}

	/** No tabs open: a picker of everything the pane can host. */
	private renderEmptyState(): HTMLElement {
		const empty = document.createElement('div');
		empty.className = 'auxiliary-empty-content';

		const title = document.createElement('h2');
		title.className = 'auxiliary-empty-title';
		title.textContent = 'Open tab';
		empty.appendChild(title);

		const description = document.createElement('p');
		description.className = 'auxiliary-empty-description';
		description.textContent = 'Choose a tab to open in the side pane.';
		empty.appendChild(description);

		const cards = document.createElement('div');
		cards.className = 'auxiliary-empty-cards';
		empty.appendChild(cards);

		for (const kind of tabKinds) {
			const button = document.createElement('button');
			button.className = 'auxiliary-empty-card';
			button.type = 'button';
			button.setAttribute('aria-label', kind.label);
			button.addEventListener('click', () => this.openTab(kind.kind));

			const icon = document.createElement('span');
			icon.className = `codicon ${kind.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);

			const label = document.createElement('span');
			label.textContent = kind.label;
			button.appendChild(label);

			cards.appendChild(button);
		}
		return empty;
	}

	/** Open (or focus, when already open) a tab of the given kind. */
	private openTab(kind: AuxiliaryTabKind): void {
		const existing = this.openTabs.find(tab => tab.kind === kind);
		if (existing) {
			this.focusTab(existing.id);
			return;
		}
		const spec = tabKinds.find(candidate => candidate.kind === kind)!;
		const disposables = new DisposableStore();

		const container = document.createElement('section');
		container.className = kind === 'data' ? 'auxiliary-view auxiliary-view-fill' : 'auxiliary-view';
		container.dataset.tabId = kind;
		const body = document.createElement('div');
		body.className = 'auxiliary-view-body';
		container.appendChild(body);
		this.content?.appendChild(container);

		const instance: ITabInstance = { id: `${kind}-${++this.instanceCounter}`, kind, label: spec.label, container, disposables };

		if (kind === 'review') {
			disposables.add(
				new ChangesView(body, {
					...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
					...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {}),
				}),
			);
		} else if (kind === 'data') {
			disposables.add(
				new DataBrowserView(body, {
					...(this.options.environmentsService ? { environmentsService: this.options.environmentsService } : {}),
					...(this.options.sessionsService ? { sessionsService: this.options.sessionsService } : {}),
					...(this.options.sessionsPartService ? { sessionsPartService: this.options.sessionsPartService } : {}),
					onContextChange: label => this.renameTab(instance.id, label),
				}),
			);
		} else {
			body.textContent = spec.body ?? '';
		}

		this.openTabs.push(instance);
		this.activeId = instance.id;
		this.update();
	}

	private closeTab(id: string): void {
		const index = this.openTabs.findIndex(tab => tab.id === id);
		if (index < 0) {
			return;
		}
		const [closed] = this.openTabs.splice(index, 1);
		closed!.disposables.dispose();
		closed!.container.remove();
		if (this.activeId === id) {
			const neighbor = this.openTabs[index] ?? this.openTabs[index - 1];
			this.activeId = neighbor?.id;
		}
		this.update();
	}

	private focusTab(id: string): void {
		this.activeId = id;
		this.update();
	}

	/** A view reported richer context (e.g. the data tab's source·table). */
	private renameTab(id: string, label: string): void {
		const tab = this.openTabs.find(candidate => candidate.id === id);
		if (tab && tab.label !== label) {
			tab.label = label;
			this.update();
		}
	}

	/** Sync every piece of chrome to openTabs/activeId. Views are NOT rebuilt —
	 *  only shown/hidden — so tab switches keep grid state, scroll, everything. */
	private update(): void {
		const hasTabs = this.openTabs.length > 0;
		this.root?.classList.toggle('auxiliary-empty', !hasTabs);
		if (this.tabsBar) {
			this.tabsBar.hidden = !hasTabs;
		}
		if (this.content) {
			this.content.hidden = !hasTabs;
		}
		if (this.empty) {
			this.empty.hidden = hasTabs;
		}
		for (const tab of this.openTabs) {
			tab.container.style.display = tab.id === this.activeId ? '' : 'none';
		}
		this.renderTabsBar();
	}

	private renderTabsBar(): void {
		const bar = this.tabsBar;
		if (!bar) {
			return;
		}
		bar.textContent = '';
		for (const tab of this.openTabs) {
			const spec = tabKinds.find(candidate => candidate.kind === tab.kind)!;
			const chip = document.createElement('button');
			chip.className = 'auxiliary-tab';
			chip.classList.toggle('active', tab.id === this.activeId);
			chip.type = 'button';
			chip.dataset.tabId = tab.kind;
			chip.dataset.instanceId = tab.id;
			chip.setAttribute('role', 'tab');
			chip.setAttribute('aria-selected', String(tab.id === this.activeId));
			chip.title = tab.label;
			chip.addEventListener('click', () => this.focusTab(tab.id));

			const icon = document.createElement('span');
			icon.className = `codicon ${spec.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			chip.appendChild(icon);

			const label = document.createElement('span');
			label.className = 'auxiliary-tab-label';
			label.textContent = tab.label;
			chip.appendChild(label);

			const close = document.createElement('span');
			close.className = 'codicon codicon-close auxiliary-tab-close';
			close.setAttribute('role', 'button');
			close.setAttribute('aria-label', `关闭 ${tab.label}`);
			close.addEventListener('click', event => {
				event.stopPropagation();
				this.closeTab(tab.id);
			});
			chip.appendChild(close);

			bar.appendChild(chip);
		}

		const add = document.createElement('button');
		add.className = 'auxiliary-tab-add';
		add.type = 'button';
		add.title = '打开…';
		add.setAttribute('aria-label', '打开新 tab');
		add.setAttribute('aria-haspopup', 'menu');
		const addIcon = document.createElement('span');
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');
		add.appendChild(addIcon);
		add.addEventListener('click', event => {
			event.stopPropagation();
			this.toggleAddMenu(add);
		});
		bar.appendChild(add);
	}

	/** The "+" menu: everything the pane can host; picking an open kind focuses it. */
	private toggleAddMenu(anchor: HTMLElement): void {
		if (this.addMenu) {
			this.closeAddMenu();
			return;
		}
		const menu = document.createElement('div');
		menu.className = 'auxiliary-add-menu';
		menu.setAttribute('role', 'menu');
		for (const kind of tabKinds) {
			const item = document.createElement('button');
			item.className = 'auxiliary-add-menu-item';
			item.type = 'button';
			item.setAttribute('role', 'menuitem');
			item.dataset.tabId = kind.kind;
			const icon = document.createElement('span');
			icon.className = `codicon ${kind.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			item.appendChild(icon);
			const label = document.createElement('span');
			label.textContent = kind.label;
			item.appendChild(label);
			item.addEventListener('click', () => {
				this.closeAddMenu();
				this.openTab(kind.kind);
			});
			menu.appendChild(item);
		}

		const rect = anchor.getBoundingClientRect();
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		// Mount inside the workbench root so the theme tokens resolve (same
		// reasoning as Dropdown's floating menu).
		(anchor.closest('.monaco-workbench') ?? document.body).appendChild(menu);
		this.addMenu = menu;

		// Any outside pointer press or Escape dismisses; listeners die with the menu.
		const onPress = (event: MouseEvent): void => {
			if (!(event.target instanceof Node) || !menu.contains(event.target)) {
				this.closeAddMenu();
			}
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				this.closeAddMenu();
			}
		};
		document.addEventListener('mousedown', onPress, true);
		document.addEventListener('keydown', onKey, true);
		this.menuCleanup.add(toDisposable(() => {
			document.removeEventListener('mousedown', onPress, true);
			document.removeEventListener('keydown', onKey, true);
		}));
	}

	private closeAddMenu(): void {
		this.menuCleanup.clear();
		this.addMenu?.remove();
		this.addMenu = undefined;
	}
}
