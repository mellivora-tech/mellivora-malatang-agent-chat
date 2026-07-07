/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';

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

export function settingsDropdown(parent: HTMLElement, options: readonly ISettingsOption[], value: string, onChange: (value: string) => void): HTMLSelectElement {
	const wrap = append(parent, document.createElement('div'));
	wrap.className = 'sessions-models-select';
	const select = append(wrap, document.createElement('select')) as HTMLSelectElement;
	select.className = 'sessions-settings-dropdown';
	for (const option of options) {
		const element = append(select, document.createElement('option')) as HTMLOptionElement;
		element.value = option.value;
		element.textContent = option.label;
	}
	select.value = value;
	select.addEventListener('change', () => onChange(select.value));

	const chevron = append(wrap, document.createElement('span'));
	chevron.className = 'codicon codicon-chevron-down sessions-models-select-chevron';
	chevron.setAttribute('aria-hidden', 'true');
	return select;
}

export function settingsButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
	const button = append(parent, document.createElement('button')) as HTMLButtonElement;
	button.className = 'sessions-settings-btn';
	button.type = 'button';
	button.textContent = label;
	button.addEventListener('click', onClick);
	return button;
}
