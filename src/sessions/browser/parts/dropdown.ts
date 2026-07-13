/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';

export interface IDropdownOption {
	readonly value: string;
	readonly label: string;
}

export interface IDropdownOptions {
	readonly items: readonly IDropdownOption[];
	readonly value: string;
	readonly disabled?: boolean;
	readonly onChange?: (value: string) => void;
}

/**
 * A custom select: a themed trigger plus a self-drawn floating option menu
 * (checkmark on the current value, hover/selected states), instead of a native
 * `<select>` whose popup the OS renders and we cannot theme. The menu mounts
 * inside the workbench root so theme tokens resolve, and is positioned with
 * fixed viewport coordinates under the trigger.
 */
export class Dropdown extends Disposable {
	readonly element: HTMLButtonElement;
	private readonly labelElement: HTMLElement;
	private current: string;
	private menu: HTMLElement | undefined;

	constructor(private readonly options: IDropdownOptions) {
		super();
		this.current = options.value;

		this.element = document.createElement('button');
		this.element.className = 'sessions-dropdown';
		this.element.type = 'button';
		this.element.setAttribute('aria-haspopup', 'listbox');
		this.element.setAttribute('aria-expanded', 'false');
		if (options.disabled) {
			this.element.disabled = true;
		}
		this.labelElement = append(this.element, document.createElement('span'));
		this.labelElement.className = 'sessions-dropdown-label';
		this.labelElement.textContent = this.labelFor(this.current);
		const chevron = append(this.element, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-down sessions-dropdown-chevron';
		chevron.setAttribute('aria-hidden', 'true');

		this.element.addEventListener('click', event => {
			event.preventDefault();
			this.toggle();
		});
		this._register(toDisposable(() => this.close()));
	}

	get value(): string {
		return this.current;
	}

	private labelFor(value: string): string {
		return this.options.items.find(item => item.value === value)?.label ?? value;
	}

	private toggle(): void {
		if (this.options.disabled) {
			return;
		}
		if (this.menu) {
			this.close();
		} else {
			this.open();
		}
	}

	private open(): void {
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? document.body;
		const menu = document.createElement('div');
		menu.className = 'sessions-dropdown-menu';
		menu.setAttribute('role', 'listbox');
		for (const item of this.options.items) {
			const option = append(menu, document.createElement('button')) as HTMLButtonElement;
			option.className = 'sessions-dropdown-item';
			option.type = 'button';
			option.setAttribute('role', 'option');
			const active = item.value === this.current;
			option.setAttribute('aria-selected', String(active));
			const check = append(option, document.createElement('span'));
			check.className = active ? 'codicon codicon-check sessions-dropdown-check' : 'sessions-dropdown-check';
			append(option, document.createElement('span')).textContent = item.label;
			option.addEventListener('click', () => this.select(item.value));
		}

		host.appendChild(menu);
		const rect = this.element.getBoundingClientRect();
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		menu.style.minWidth = `${rect.width}px`;
		this.menu = menu;
		this.element.setAttribute('aria-expanded', 'true');

		// Defer the outside-click listener so the opening click doesn't immediately close it.
		setTimeout(() => document.addEventListener('mousedown', this.onOutside, true));
		document.addEventListener('keydown', this.onKeydown, true);
	}

	private close(): void {
		if (!this.menu) {
			return;
		}
		this.menu.remove();
		this.menu = undefined;
		this.element.setAttribute('aria-expanded', 'false');
		document.removeEventListener('mousedown', this.onOutside, true);
		document.removeEventListener('keydown', this.onKeydown, true);
	}

	private select(value: string): void {
		const changed = value !== this.current;
		this.current = value;
		this.labelElement.textContent = this.labelFor(value);
		this.close();
		if (changed) {
			this.options.onChange?.(value);
		}
	}

	private readonly onOutside = (event: MouseEvent): void => {
		if (event.target instanceof Node && !this.menu?.contains(event.target) && !this.element.contains(event.target)) {
			this.close();
		}
	};

	private readonly onKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			this.close();
		}
	};
}
