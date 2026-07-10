/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';

/**
 * Slash commands for the composer textareas: a message that STARTS with `/`
 * opens an anchored picker over the registered commands. Two kinds:
 * - 'action' runs immediately (open the model picker, fork, stop…) and clears
 *   the input — nothing is sent;
 * - 'template' expands into the input as a prompt scaffold the user can edit
 *   before sending.
 * The leading-slash-only rule keeps paths like `src/a.ts` from triggering.
 *
 * IMPORTANT: install BEFORE the composer's own Enter-to-send keydown listener —
 * at-target listeners run in registration order, and an Enter that picks a
 * command must not also send the message.
 */

export interface IComposerCommand {
	/** Without the slash, e.g. 'fork'. */
	readonly name: string;
	readonly description: string;
	readonly kind: 'action' | 'template';
	/** kind 'action': executed on pick. */
	readonly run?: () => void;
	/** kind 'template': replaces the input text on pick. */
	readonly template?: string;
}

/** The active /-token: only when the whole message starts with `/` and the caret is still inside that first word. */
export function findCommandQuery(text: string, caret: number): string | undefined {
	if (!text.startsWith('/') || caret < 1) {
		return undefined;
	}
	const token = text.slice(1, caret);
	return /\s/.test(token) ? undefined : token;
}

/** Prefix matches rank above substring matches; both case-insensitive. */
export function filterCommands(commands: readonly IComposerCommand[], query: string): IComposerCommand[] {
	const needle = query.toLowerCase();
	if (needle === '') {
		return [...commands];
	}
	const prefixed = commands.filter(command => command.name.toLowerCase().startsWith(needle));
	const contained = commands.filter(command => !command.name.toLowerCase().startsWith(needle) && (command.name.toLowerCase().includes(needle) || command.description.toLowerCase().includes(needle)));
	return [...prefixed, ...contained];
}

export interface ICommandInstallOptions {
	/** Positioned ancestor hosting the menu — the composer clips overflow. */
	readonly host: HTMLElement;
	readonly input: HTMLTextAreaElement;
	/** Evaluated at open time, so availability can depend on session state. */
	readonly getCommands: () => readonly IComposerCommand[];
}

export function installSlashCommands(options: ICommandInstallOptions): IDisposable {
	const { host, input } = options;

	let menu: HTMLElement | undefined;
	let items: IComposerCommand[] = [];
	let activeIndex = 0;

	const closeMenu = (): void => {
		menu?.remove();
		menu = undefined;
		items = [];
		activeIndex = 0;
		document.removeEventListener('mousedown', onOutsideMouseDown, true);
	};

	const onOutsideMouseDown = (event: MouseEvent): void => {
		if (menu && event.target instanceof Node && !menu.contains(event.target) && event.target !== input) {
			closeMenu();
		}
	};

	const renderMenu = (): void => {
		if (!menu) {
			menu = append(host, document.createElement('div'));
			menu.className = 'composer-mention-menu';
			menu.setAttribute('role', 'listbox');
			document.addEventListener('mousedown', onOutsideMouseDown, true);
		}
		const hostRect = host.getBoundingClientRect();
		const inputRect = input.getBoundingClientRect();
		menu.style.left = `${inputRect.left - hostRect.left}px`;
		menu.style.width = `${inputRect.width}px`;
		menu.style.bottom = `${hostRect.bottom - inputRect.top + 6}px`;

		menu.replaceChildren();
		if (items.length === 0) {
			const empty = append(menu, document.createElement('div'));
			empty.className = 'composer-mention-empty';
			empty.textContent = 'No matching commands';
			return;
		}
		items.forEach((command, index) => {
			const item = append(menu!, document.createElement('button')) as HTMLButtonElement;
			item.className = `composer-mention-item${index === activeIndex ? ' active' : ''}`;
			item.type = 'button';
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(index === activeIndex));
			const name = append(item, document.createElement('span'));
			name.className = 'composer-mention-item-name';
			name.textContent = `/${command.name}`;
			const description = append(item, document.createElement('span'));
			description.className = 'composer-mention-item-desc';
			description.textContent = command.description;
			// mousedown, not click: keep focus (and the caret) in the textarea.
			item.addEventListener('mousedown', event => {
				event.preventDefault();
				pick(command);
			});
			item.addEventListener('mouseenter', () => {
				activeIndex = index;
				renderMenu();
			});
		});
		menu.querySelector('.composer-mention-item.active')?.scrollIntoView({ block: 'nearest' });
	};

	const pick = (command: IComposerCommand): void => {
		closeMenu();
		if (command.kind === 'action') {
			input.value = '';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			command.run?.();
			return;
		}
		input.value = `${command.template ?? ''}`;
		input.setSelectionRange(input.value.length, input.value.length);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.focus();
	};

	const refresh = (): void => {
		const caret = input.selectionStart ?? input.value.length;
		const query = findCommandQuery(input.value, caret);
		if (query === undefined) {
			closeMenu();
			return;
		}
		items = filterCommands(options.getCommands(), query);
		activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
		renderMenu();
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (!menu || event.isComposing) {
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopImmediatePropagation();
			const delta = event.key === 'ArrowDown' ? 1 : -1;
			activeIndex = items.length === 0 ? 0 : (activeIndex + delta + items.length) % items.length;
			renderMenu();
		} else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
			const command = items[activeIndex];
			if (command) {
				event.preventDefault();
				event.stopImmediatePropagation();
				pick(command);
			} else {
				closeMenu();
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			closeMenu();
		}
	};

	const onInput = (): void => refresh();
	const onCaretMove = (): void => {
		if (menu) {
			refresh();
		}
	};

	input.addEventListener('keydown', onKeydown);
	input.addEventListener('input', onInput);
	input.addEventListener('click', onCaretMove);
	input.addEventListener('keyup', onCaretMove);
	input.addEventListener('blur', () => {
		setTimeout(() => {
			if (menu && document.activeElement !== input) {
				closeMenu();
			}
		}, 100);
	});

	return toDisposable(() => {
		closeMenu();
		input.removeEventListener('keydown', onKeydown);
		input.removeEventListener('input', onInput);
		input.removeEventListener('click', onCaretMove);
		input.removeEventListener('keyup', onCaretMove);
	});
}

/** Prompt scaffolds shared by both composers. */
export const TEMPLATE_COMMANDS: readonly IComposerCommand[] = [
	{ name: 'review', kind: 'template', description: 'Review the working-tree changes', template: 'Review the current working-tree changes for bugs first, then suggest simplifications.' },
	{ name: 'explain', kind: 'template', description: 'Explain how this project works', template: 'Explain how this project works: entry points, main modules, and how they fit together.' },
	{ name: 'fix', kind: 'template', description: 'Run checks and fix failures', template: 'Run the checks (typecheck, lint, tests) and fix any failures you find.' },
];
