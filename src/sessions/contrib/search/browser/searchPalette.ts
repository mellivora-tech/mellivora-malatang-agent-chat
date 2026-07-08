/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';

export type SearchPaletteTab = 'all' | 'actions' | 'tasks' | 'files';
export type SearchPaletteActionGroup = 'suggested' | 'panels';

export interface ISearchPaletteTask {
	readonly id: string;
	readonly title: string;
	readonly timeLabel: string;
}

export interface ISearchPaletteAction {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly group: SearchPaletteActionGroup;
	readonly keybinding?: string;
	run(): void;
}

export interface ISearchPaletteRecentChanges {
	readonly taskTitle?: string;
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface ISearchPaletteOptions {
	readonly getHost: () => HTMLElement;
	readonly getTasks: () => readonly ISearchPaletteTask[];
	readonly openTask: (id: string) => void;
	readonly actions: readonly ISearchPaletteAction[];
	readonly getRecentChanges: () => ISearchPaletteRecentChanges | undefined;
}

const TABS: readonly { readonly id: SearchPaletteTab; readonly label: string; readonly icon: string }[] = [
	{ id: 'all', label: 'All', icon: 'codicon-list-selection' },
	{ id: 'actions', label: 'Actions', icon: 'codicon-zap' },
	{ id: 'tasks', label: 'Tasks', icon: 'codicon-comment-discussion' },
	{ id: 'files', label: 'Files', icon: 'codicon-file' },
];

const GROUP_TITLES: Readonly<Record<SearchPaletteActionGroup, string>> = {
	suggested: 'Suggested',
	panels: 'Panels',
};

const TASK_LIMIT = 6;

type Entry = { readonly kind: 'header'; readonly label: string } | { readonly kind: 'item'; readonly label: string; readonly icon: string; readonly keybinding?: string; readonly run: () => void } | { readonly kind: 'empty'; readonly label: string };

export class SearchPalette extends Disposable {
	private readonly openStore = this._register(new DisposableStore());
	private backdrop: HTMLElement | undefined;
	private input: HTMLInputElement | undefined;
	private listElement: HTMLElement | undefined;
	private tab: SearchPaletteTab = 'all';
	private query = '';
	private selectedIndex = 0;
	private itemButtons: HTMLButtonElement[] = [];

	constructor(private readonly options: ISearchPaletteOptions) {
		super();
	}

	get isOpen(): boolean {
		return this.backdrop !== undefined;
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	open(): void {
		if (this.isOpen) {
			this.input?.focus();
			return;
		}

		this.tab = 'all';
		this.query = '';
		this.selectedIndex = 0;

		const backdrop = document.createElement('div');
		backdrop.className = 'search-palette-backdrop';
		backdrop.addEventListener('mousedown', event => {
			if (event.target === backdrop) {
				this.close();
			}
		});

		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'search-palette';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Search');

		const searchRow = append(dialog, document.createElement('div'));
		searchRow.className = 'search-palette-search';
		const searchIcon = append(searchRow, document.createElement('span'));
		searchIcon.className = 'codicon codicon-search search-palette-search-icon';
		searchIcon.setAttribute('aria-hidden', 'true');
		const input = append(searchRow, document.createElement('input')) as HTMLInputElement;
		input.className = 'search-palette-input';
		input.type = 'text';
		input.placeholder = 'Search actions, tasks, or files';
		input.setAttribute('aria-label', 'Search actions, tasks, or files');
		input.spellcheck = false;
		input.addEventListener('input', () => {
			this.query = input.value;
			this.selectedIndex = 0;
			this.renderList();
		});
		input.addEventListener('keydown', event => this.onInputKeydown(event));
		this.input = input;

		const tabs = append(dialog, document.createElement('div'));
		tabs.className = 'search-palette-tabs';
		tabs.setAttribute('role', 'tablist');
		for (const tab of TABS) {
			const chip = append(tabs, document.createElement('button')) as HTMLButtonElement;
			chip.className = 'search-palette-tab';
			chip.type = 'button';
			chip.dataset.tab = tab.id;
			chip.setAttribute('role', 'tab');
			chip.classList.toggle('active', tab.id === this.tab);
			chip.setAttribute('aria-selected', String(tab.id === this.tab));
			const chipIcon = append(chip, document.createElement('span'));
			chipIcon.className = `codicon ${tab.icon}`;
			chipIcon.setAttribute('aria-hidden', 'true');
			const chipLabel = append(chip, document.createElement('span'));
			chipLabel.textContent = tab.label;
			chip.addEventListener('click', () => {
				this.tab = tab.id;
				this.selectedIndex = 0;
				for (const other of Array.from(tabs.children)) {
					const isActive = other === chip;
					other.classList.toggle('active', isActive);
					other.setAttribute('aria-selected', String(isActive));
				}
				this.renderList();
				this.input?.focus();
			});
		}

		const list = append(dialog, document.createElement('div'));
		list.className = 'search-palette-list';
		list.setAttribute('role', 'listbox');
		this.listElement = list;

		const host = this.options.getHost();
		host.appendChild(backdrop);
		this.backdrop = backdrop;

		this.openStore.add({ dispose: () => backdrop.remove() });
		this.renderList();
		input.focus();
	}

	close(): void {
		if (!this.isOpen) {
			return;
		}
		this.openStore.clear();
		this.backdrop = undefined;
		this.input = undefined;
		this.listElement = undefined;
		this.itemButtons = [];
	}

	private onInputKeydown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				this.close();
				return;
			case 'ArrowDown':
				event.preventDefault();
				this.moveSelection(1);
				return;
			case 'ArrowUp':
				event.preventDefault();
				this.moveSelection(-1);
				return;
			case 'Enter': {
				event.preventDefault();
				this.itemButtons[this.selectedIndex]?.click();
				return;
			}
		}
	}

	private moveSelection(delta: number): void {
		if (this.itemButtons.length === 0) {
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + this.itemButtons.length) % this.itemButtons.length;
		this.applySelection();
	}

	private applySelection(): void {
		this.itemButtons.forEach((button, index) => {
			const selected = index === this.selectedIndex;
			button.classList.toggle('selected', selected);
			button.setAttribute('aria-selected', String(selected));
			if (selected) {
				button.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	private renderList(): void {
		const list = this.listElement;
		if (!list) {
			return;
		}

		clearNode(list);
		this.itemButtons = [];

		const entries = this.getEntries();
		if (entries.length === 0) {
			const empty = append(list, document.createElement('div'));
			empty.className = 'search-palette-empty';
			empty.textContent = 'No results';
			return;
		}

		for (const entry of entries) {
			if (entry.kind === 'header') {
				const header = append(list, document.createElement('div'));
				header.className = 'search-palette-section';
				header.textContent = entry.label;
				continue;
			}

			if (entry.kind === 'empty') {
				const message = append(list, document.createElement('div'));
				message.className = 'search-palette-section-empty';
				message.textContent = entry.label;
				continue;
			}

			const button = append(list, document.createElement('button')) as HTMLButtonElement;
			button.className = 'search-palette-row';
			button.type = 'button';
			button.setAttribute('role', 'option');
			const icon = append(button, document.createElement('span'));
			icon.className = `codicon ${entry.icon} search-palette-row-icon`;
			icon.setAttribute('aria-hidden', 'true');
			const label = append(button, document.createElement('span'));
			label.className = 'search-palette-row-label';
			label.textContent = entry.label;
			if (entry.keybinding) {
				const keys = append(button, document.createElement('span'));
				keys.className = 'search-palette-row-keys';
				keys.textContent = entry.keybinding;
			}
			const index = this.itemButtons.length;
			const run = entry.run;
			button.addEventListener('click', () => {
				this.close();
				run();
			});
			button.addEventListener('mousemove', () => {
				if (this.selectedIndex !== index) {
					this.selectedIndex = index;
					this.applySelection();
				}
			});
			this.itemButtons.push(button);
		}

		if (this.selectedIndex >= this.itemButtons.length) {
			this.selectedIndex = Math.max(0, this.itemButtons.length - 1);
		}
		this.applySelection();
	}

	private getEntries(): readonly Entry[] {
		const query = this.query.trim().toLowerCase();
		const matches = (text: string): boolean => query === '' || text.toLowerCase().includes(query);

		const taskEntries = (limit?: number): Entry[] => {
			const tasks = this.options.getTasks().filter(task => matches(task.title));
			const limited = limit === undefined ? tasks : tasks.slice(0, limit);
			return limited.map(task => ({ kind: 'item', label: task.title, icon: 'codicon-comment', keybinding: task.timeLabel, run: () => this.options.openTask(task.id) }));
		};

		const actionEntries = (group: SearchPaletteActionGroup): Entry[] =>
			this.options.actions
				.filter(action => action.group === group && matches(action.label))
				.map(action => ({ kind: 'item', label: action.label, icon: action.icon, ...(action.keybinding ? { keybinding: action.keybinding } : {}), run: () => action.run() }));

		const withHeader = (label: string, items: readonly Entry[]): Entry[] => (items.length > 0 ? [{ kind: 'header', label }, ...items] : []);

		switch (this.tab) {
			case 'tasks': {
				const tasks = taskEntries();
				return tasks.length > 0 ? [{ kind: 'header', label: 'Recent tasks' }, ...tasks] : [{ kind: 'header', label: 'Recent tasks' }, { kind: 'empty', label: query ? 'No matching tasks' : 'No tasks yet' }];
			}
			case 'files':
				return this.fileEntries();
			case 'actions':
				return [...withHeader(GROUP_TITLES.suggested, actionEntries('suggested')), ...withHeader(GROUP_TITLES.panels, actionEntries('panels'))];
			case 'all':
			default:
				return [...withHeader('Recent tasks', taskEntries(TASK_LIMIT)), ...withHeader(GROUP_TITLES.suggested, actionEntries('suggested')), ...withHeader(GROUP_TITLES.panels, actionEntries('panels'))];
		}
	}

	private fileEntries(): Entry[] {
		const changes = this.options.getRecentChanges();
		if (!changes || changes.files === 0) {
			return [
				{ kind: 'header', label: 'Recent changes' },
				{ kind: 'empty', label: 'No recent changes in current task' },
			];
		}

		const summary = `${changes.files} file${changes.files === 1 ? '' : 's'} changed  +${changes.additions}  −${changes.deletions}`;
		return [
			{ kind: 'header', label: 'Recent changes' },
			{ kind: 'item', label: changes.taskTitle ? `${changes.taskTitle} — ${summary}` : summary, icon: 'codicon-diff', run: () => {} },
		];
	}
}
