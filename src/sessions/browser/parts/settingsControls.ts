/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Dropdown } from './dropdown.js';

/**
 * The reusable Cursor-style settings language: a section (muted label + card)
 * holding rows, each pairing a label/description on the left with a control
 * (toggle / dropdown / button) on the right.
 */

/** Create a section (optional muted title) and return its card, to which rows are appended. */
export function settingsSection(parent: HTMLElement, title?: string): HTMLElement {
	const section = append(parent, document.createElement('section'));
	section.className = 'sessions-settings-section';
	if (title) {
		const label = append(section, document.createElement('div'));
		label.className = 'sessions-settings-section-title';
		label.textContent = title;
	}
	const card = append(section, document.createElement('div'));
	card.className = 'sessions-settings-card';
	return card;
}

export interface ISettingsRowOptions {
	readonly title: string;
	readonly description?: string;
}

/** Append a row to a card and return the control slot for the caller to fill. */
export function settingsRow(card: HTMLElement, options: ISettingsRowOptions): HTMLElement {
	const row = append(card, document.createElement('div'));
	row.className = 'sessions-settings-row';

	const text = append(row, document.createElement('div'));
	text.className = 'sessions-settings-row-text';
	const title = append(text, document.createElement('div'));
	title.className = 'sessions-settings-row-title';
	title.textContent = options.title;
	if (options.description) {
		const description = append(text, document.createElement('div'));
		description.className = 'sessions-settings-row-desc';
		description.textContent = options.description;
	}

	const control = append(row, document.createElement('div'));
	control.className = 'sessions-settings-row-control';
	return control;
}

export function settingsToggle(parent: HTMLElement, checked: boolean, onChange: (value: boolean) => void): HTMLButtonElement {
	const toggle = append(parent, document.createElement('button')) as HTMLButtonElement;
	toggle.className = 'sessions-settings-toggle';
	toggle.type = 'button';
	toggle.setAttribute('role', 'switch');
	append(toggle, document.createElement('span')).className = 'sessions-settings-toggle-knob';

	let current = checked;
	const paint = (value: boolean): void => {
		toggle.classList.toggle('on', value);
		toggle.setAttribute('aria-checked', String(value));
	};
	paint(current);
	toggle.addEventListener('click', () => {
		current = !current;
		paint(current);
		onChange(current);
	});

	return toggle;
}

export interface ISettingsOption {
	readonly value: string;
	readonly label: string;
}

export function settingsDropdown(parent: HTMLElement, options: readonly ISettingsOption[], value: string, onChange: (value: string) => void): Dropdown {
	// The self-drawn Dropdown, not a native <select>: the OS renders a native
	// select's popup and no theme token reaches it — same reasoning as the
	// project-config form fields, now unified (2026-07-20).
	const dropdown = new Dropdown({ items: options, value, onChange });
	parent.appendChild(dropdown.element);
	return dropdown;
}

export function settingsButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
	const button = append(parent, document.createElement('button')) as HTMLButtonElement;
	button.className = 'sessions-settings-btn';
	button.type = 'button';
	button.textContent = label;
	button.addEventListener('click', onClick);
	return button;
}

export interface IPageHeaderOptions {
	readonly title: string;
	readonly description?: string;
	/** Optional right-aligned action on the title row (Cursor's "+ New" / "Manage View"). */
	readonly actionLabel?: string;
	readonly onAction?: () => void;
	/** Additional right-aligned actions, rendered left of `actionLabel`. */
	readonly actions?: readonly { readonly label: string; readonly onClick: () => void }[];
}

/**
 * A settings page header: a medium (heading2) title with an optional right-aligned
 * action button, and an optional muted description line beneath. Deliberately not
 * an <h1> — that reads too large inside the settings shell.
 */
export function settingsPageHeader(parent: HTMLElement, options: IPageHeaderOptions): void {
	const header = append(parent, document.createElement('div'));
	header.className = 'sessions-page-header';

	const bar = append(header, document.createElement('div'));
	bar.className = 'sessions-page-header-bar';
	const title = append(bar, document.createElement('div'));
	title.className = 'sessions-page-header-title';
	title.setAttribute('role', 'heading');
	title.setAttribute('aria-level', '2');
	title.textContent = options.title;
	if (options.actions && options.actions.length > 0) {
		const group = append(bar, document.createElement('div'));
		group.className = 'sessions-page-header-actions';
		for (const action of options.actions) {
			settingsButton(group, action.label, action.onClick);
		}
	} else if (options.actionLabel && options.onAction) {
		settingsButton(bar, options.actionLabel, options.onAction);
	}

	if (options.description) {
		const description = append(header, document.createElement('div'));
		description.className = 'sessions-page-header-desc';
		description.textContent = options.description;
	}
}

export interface IScopeTab {
	readonly id: string;
	readonly label: string;
	/** Renders a small lock glyph — used for protected (read-only) environments. */
	readonly locked?: boolean;
}

export interface IScopeTabsOptions {
	readonly tabs: readonly IScopeTab[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	/** Trailing "+" affordance (e.g. add environment). */
	readonly onAdd?: () => void;
	readonly addTitle?: string;
}

/**
 * A lightweight scope switcher — compact text tabs for switching between instances
 * of the same view (e.g. dev / test / prod environments), with an optional trailing
 * "+". Kept deliberately light (no heavy underline) so it reads as chrome, not a
 * page-level tab strip.
 */
export function settingsScopeTabs(parent: HTMLElement, options: IScopeTabsOptions): void {
	const bar = append(parent, document.createElement('div'));
	bar.className = 'sessions-scope-tabs';
	bar.setAttribute('role', 'tablist');
	for (const tab of options.tabs) {
		const button = append(bar, document.createElement('button')) as HTMLButtonElement;
		button.className = 'sessions-scope-tab';
		button.type = 'button';
		button.setAttribute('role', 'tab');
		button.classList.toggle('active', tab.id === options.activeId);
		button.setAttribute('aria-selected', String(tab.id === options.activeId));
		append(button, document.createElement('span')).textContent = tab.label;
		if (tab.locked) {
			const lock = append(button, document.createElement('span'));
			lock.className = 'codicon codicon-lock sessions-scope-tab-lock';
			lock.setAttribute('aria-label', 'protected');
		}
		button.addEventListener('click', () => options.onSelect(tab.id));
	}
	if (options.onAdd) {
		const add = append(bar, document.createElement('button')) as HTMLButtonElement;
		add.className = 'sessions-scope-tab sessions-scope-tab-add';
		add.type = 'button';
		add.title = options.addTitle ?? 'Add';
		add.setAttribute('aria-label', options.addTitle ?? 'Add');
		append(add, document.createElement('span')).className = 'codicon codicon-add';
		add.addEventListener('click', options.onAdd);
	}
}

export interface IEmptyCardOptions {
	readonly title: string;
	readonly description?: string;
	readonly actionLabel?: string;
	readonly onAction?: () => void;
}

export interface ICardGridItem {
	readonly icon: string;
	readonly title: string;
	readonly description?: string;
	readonly onClick: () => void;
}

/** A responsive card grid (Cursor's "Suggested" catalog): each card is icon + title + description + chevron. */
export function settingsCardGrid(parent: HTMLElement, title: string | undefined, items: readonly ICardGridItem[]): void {
	if (title) {
		const label = append(parent, document.createElement('div'));
		label.className = 'sessions-settings-section-title';
		label.textContent = title;
	}
	const grid = append(parent, document.createElement('div'));
	grid.className = 'sessions-card-grid';
	for (const item of items) {
		const card = append(grid, document.createElement('button')) as HTMLButtonElement;
		card.className = 'sessions-card';
		card.type = 'button';
		const icon = append(card, document.createElement('span'));
		icon.className = `codicon ${item.icon} sessions-card-icon`;
		icon.setAttribute('aria-hidden', 'true');
		const body = append(card, document.createElement('div'));
		body.className = 'sessions-card-body';
		const cardTitle = append(body, document.createElement('div'));
		cardTitle.className = 'sessions-card-title';
		cardTitle.textContent = item.title;
		if (item.description) {
			const description = append(body, document.createElement('div'));
			description.className = 'sessions-card-desc';
			description.textContent = item.description;
		}
		const chevron = append(card, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-right sessions-card-chevron';
		chevron.setAttribute('aria-hidden', 'true');
		card.addEventListener('click', item.onClick);
	}
}

/** A centered empty-state card (Cursor's "No Plugins / No hooks configured" pattern) with an optional CTA. */
export function settingsEmptyCard(parent: HTMLElement, options: IEmptyCardOptions): HTMLElement {
	const card = append(parent, document.createElement('div'));
	card.className = 'sessions-empty-card';
	const title = append(card, document.createElement('div'));
	title.className = 'sessions-empty-card-title';
	title.textContent = options.title;
	if (options.description) {
		const description = append(card, document.createElement('div'));
		description.className = 'sessions-empty-card-desc';
		description.textContent = options.description;
	}
	if (options.actionLabel && options.onAction) {
		const actions = append(card, document.createElement('div'));
		actions.className = 'sessions-empty-card-actions';
		settingsButton(actions, options.actionLabel, options.onAction);
	}
	return card;
}
