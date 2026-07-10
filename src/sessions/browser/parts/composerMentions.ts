/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { ISessionAttachment } from '../../services/sessions/common/session.js';

/**
 * @-mentions for the composer textareas: typing `@` at a word boundary opens an
 * anchored picker over the project's files (folders are derived from the file
 * paths). Selecting inserts the mention inline (`@src/a.ts `) and records a
 * structured attachment; mentions whose inline text the user later deletes are
 * dropped at collect time. The same install() serves both the new-session and
 * the conversation composer — trigger logic lives only here.
 *
 * IMPORTANT: install BEFORE the composer's own Enter-to-send keydown listener —
 * at-target listeners run in registration order, and an Enter that picks a
 * mention must not also send the message.
 */

export interface IMentionEntry {
	readonly kind: 'file' | 'folder';
	readonly path: string;
}

const MAX_MENU_ITEMS = 50;

/** The active trigger-token at the caret: the trigger char (`@`, `$`) at a start/whitespace boundary, no whitespace between it and the caret. */
export function findMentionQuery(text: string, caret: number, trigger: string = '@'): { readonly start: number; readonly query: string } | undefined {
	for (let index = caret - 1; index >= 0; index--) {
		const char = text[index]!;
		if (char === trigger) {
			if (index > 0 && !/\s/.test(text[index - 1]!)) {
				return undefined;
			}
			return { start: index, query: text.slice(index + 1, caret) };
		}
		if (/\s/.test(char)) {
			return undefined;
		}
	}
	return undefined;
}

/** Files plus the folders they imply, filtered and ranked for the picker. */
export function filterMentionPaths(files: readonly string[], query: string, limit: number = MAX_MENU_ITEMS): IMentionEntry[] {
	const folders = new Set<string>();
	for (const file of files) {
		let slash = file.indexOf('/');
		while (slash !== -1) {
			folders.add(file.slice(0, slash));
			slash = file.indexOf('/', slash + 1);
		}
	}

	const entries: IMentionEntry[] = [
		...files.map(path => ({ kind: 'file' as const, path })),
		...[...folders].sort().map(path => ({ kind: 'folder' as const, path })),
	];

	const needle = query.toLowerCase();
	if (needle === '') {
		return entries.slice(0, limit);
	}

	const scored: { entry: IMentionEntry; score: number }[] = [];
	for (const entry of entries) {
		const path = entry.path.toLowerCase();
		const name = path.split('/').pop()!;
		let score: number;
		if (name.startsWith(needle)) {
			score = 0;
		} else if (name.includes(needle)) {
			score = 1;
		} else if (path.includes(needle)) {
			score = 2;
		} else if (isSubsequence(needle, path)) {
			score = 3;
		} else {
			continue;
		}
		scored.push({ entry, score });
	}
	scored.sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || (a.entry.path < b.entry.path ? -1 : 1));
	return scored.slice(0, limit).map(item => item.entry);
}

/** The inline text a mention occupies in the message (folders keep a trailing slash). */
export function mentionText(entry: IMentionEntry): string {
	return entry.kind === 'folder' ? `@${entry.path}/` : `@${entry.path}`;
}

/** Recorded mentions whose inline `@path` text still appears in the final message. */
export function collectMentionAttachments(text: string, recorded: ReadonlyMap<string, IMentionEntry>): ISessionAttachment[] {
	const attachments: ISessionAttachment[] = [];
	for (const [inline, entry] of recorded) {
		if (text.includes(inline)) {
			attachments.push({ kind: entry.kind, path: entry.path });
		}
	}
	return attachments;
}

function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) {
			index++;
			if (index === needle.length) {
				return true;
			}
		}
	}
	return false;
}

export interface IMentionInstallOptions {
	/** Positioned ancestor hosting the menu — the composer clips overflow. */
	readonly host: HTMLElement;
	readonly input: HTMLTextAreaElement;
	/** File paths for the current context; undefined disables the trigger (no project). */
	readonly loadPaths: () => Promise<readonly string[]> | undefined;
}

export interface IMentionController extends IDisposable {
	collectAttachments(text: string): ISessionAttachment[];
	/** Forget recorded mentions (call after a successful send). */
	reset(): void;
}

export interface ISkillMentionEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface ISkillMentionInstallOptions {
	readonly host: HTMLElement;
	readonly input: HTMLTextAreaElement;
	/** Evaluated at open time; empty list renders a "no skills" hint. */
	readonly getSkills: () => readonly ISkillMentionEntry[];
}

/**
 * `$`-mentions over the user's skills — same interaction contract as the file
 * mentions below (same install-order requirement, same collect-if-still-present
 * semantics), but over a small synchronous list. Picking inserts `$<id> ` and
 * records a `skill` attachment.
 */
export function installSkillMentions(options: ISkillMentionInstallOptions): IMentionController {
	const { host, input } = options;
	const recorded = new Map<string, ISessionAttachment>();

	let menu: HTMLElement | undefined;
	let items: ISkillMentionEntry[] = [];
	let activeIndex = 0;
	let tokenStart = -1;

	const closeMenu = (): void => {
		menu?.remove();
		menu = undefined;
		items = [];
		activeIndex = 0;
		tokenStart = -1;
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
			empty.textContent = 'No matching skills — add some in Settings › Skills';
			return;
		}
		items.forEach((skill, index) => {
			const item = append(menu!, document.createElement('button')) as HTMLButtonElement;
			item.className = `composer-mention-item${index === activeIndex ? ' active' : ''}`;
			item.type = 'button';
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(index === activeIndex));
			const icon = append(item, document.createElement('span'));
			icon.className = 'codicon codicon-lightbulb';
			icon.setAttribute('aria-hidden', 'true');
			const name = append(item, document.createElement('span'));
			name.className = 'composer-mention-item-name';
			name.textContent = skill.name;
			if (skill.description) {
				const description = append(item, document.createElement('span'));
				description.className = 'composer-mention-item-desc';
				description.textContent = skill.description;
			}
			item.addEventListener('mousedown', event => {
				event.preventDefault();
				pick(skill);
			});
			item.addEventListener('mouseenter', () => {
				activeIndex = index;
				renderMenu();
			});
		});
		menu.querySelector('.composer-mention-item.active')?.scrollIntoView({ block: 'nearest' });
	};

	const pick = (skill: ISkillMentionEntry): void => {
		const inline = `$${skill.id}`;
		const caret = input.selectionStart ?? input.value.length;
		if (tokenStart >= 0 && tokenStart <= caret) {
			input.setRangeText(`${inline} `, tokenStart, caret, 'end');
			recorded.set(inline, { kind: 'skill', path: skill.id });
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		closeMenu();
		input.focus();
	};

	const refresh = (): void => {
		const caret = input.selectionStart ?? input.value.length;
		const token = findMentionQuery(input.value, caret, '$');
		if (!token) {
			closeMenu();
			return;
		}
		tokenStart = token.start;
		const needle = token.query.toLowerCase();
		items = options.getSkills().filter(skill => needle === '' || skill.id.includes(needle) || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle));
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
			const skill = items[activeIndex];
			if (skill) {
				event.preventDefault();
				event.stopImmediatePropagation();
				pick(skill);
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

	const disposable = toDisposable(() => {
		closeMenu();
		input.removeEventListener('keydown', onKeydown);
		input.removeEventListener('input', onInput);
		input.removeEventListener('click', onCaretMove);
		input.removeEventListener('keyup', onCaretMove);
	});

	return {
		collectAttachments: text => {
			const attachments: ISessionAttachment[] = [];
			for (const [inline, attachment] of recorded) {
				if (text.includes(inline)) {
					attachments.push(attachment);
				}
			}
			return attachments;
		},
		reset: () => recorded.clear(),
		dispose: () => disposable.dispose(),
	};
}

export function installFileMentions(options: IMentionInstallOptions): IMentionController {
	const { host, input } = options;
	const recorded = new Map<string, IMentionEntry>();

	let menu: HTMLElement | undefined;
	let items: IMentionEntry[] = [];
	let activeIndex = 0;
	let tokenStart = -1;
	// One load per menu session (open → close); a stale response for a closed
	// menu is ignored via this generation counter.
	let paths: readonly string[] | undefined;
	let loading = false;
	let loadGeneration = 0;

	const closeMenu = (): void => {
		menu?.remove();
		menu = undefined;
		items = [];
		activeIndex = 0;
		tokenStart = -1;
		paths = undefined;
		loading = false;
		loadGeneration++;
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
		// Anchored above the input, growing upward.
		menu.style.bottom = `${hostRect.bottom - inputRect.top + 6}px`;

		menu.replaceChildren();
		if (items.length === 0) {
			const empty = append(menu, document.createElement('div'));
			empty.className = 'composer-mention-empty';
			empty.textContent = paths === undefined ? 'Loading files…' : 'No matching files';
			return;
		}
		items.forEach((entry, index) => {
			const item = append(menu!, document.createElement('button')) as HTMLButtonElement;
			item.className = `composer-mention-item${index === activeIndex ? ' active' : ''}`;
			item.type = 'button';
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(index === activeIndex));
			const icon = append(item, document.createElement('span'));
			icon.className = `codicon ${entry.kind === 'folder' ? 'codicon-folder' : 'codicon-file'}`;
			icon.setAttribute('aria-hidden', 'true');
			const segments = entry.path.split('/');
			const name = append(item, document.createElement('span'));
			name.className = 'composer-mention-item-name';
			name.textContent = segments.pop()! + (entry.kind === 'folder' ? '/' : '');
			if (segments.length > 0) {
				const dir = append(item, document.createElement('span'));
				dir.className = 'composer-mention-item-dir';
				dir.textContent = segments.join('/');
			}
			// mousedown, not click: keep focus (and the caret) in the textarea.
			item.addEventListener('mousedown', event => {
				event.preventDefault();
				pick(entry);
			});
			item.addEventListener('mouseenter', () => {
				activeIndex = index;
				renderMenu();
			});
		});
		menu.querySelector('.composer-mention-item.active')?.scrollIntoView({ block: 'nearest' });
	};

	const pick = (entry: IMentionEntry): void => {
		const inline = mentionText(entry);
		const caret = input.selectionStart ?? input.value.length;
		if (tokenStart >= 0 && tokenStart <= caret) {
			input.setRangeText(`${inline} `, tokenStart, caret, 'end');
			recorded.set(inline, entry);
			// setRangeText fires no input event; the composers resize/enable off it.
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		closeMenu();
		input.focus();
	};

	const refresh = (): void => {
		const caret = input.selectionStart ?? input.value.length;
		const token = findMentionQuery(input.value, caret);
		if (!token) {
			closeMenu();
			return;
		}
		const load = options.loadPaths();
		if (!load) {
			closeMenu();
			return;
		}
		tokenStart = token.start;
		if (paths === undefined) {
			if (!loading) {
				loading = true;
				const generation = ++loadGeneration;
				void Promise.resolve(load).then(
					loaded => {
						if (generation !== loadGeneration || !menu) {
							return;
						}
						loading = false;
						paths = loaded;
						refresh();
					},
					() => {
						if (generation === loadGeneration) {
							closeMenu();
						}
					},
				);
			}
			items = [];
			renderMenu();
			return;
		}
		items = filterMentionPaths(paths, token.query);
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
			const entry = items[activeIndex];
			if (entry) {
				event.preventDefault();
				event.stopImmediatePropagation();
				pick(entry);
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
	// Caret moves without input (click, arrow keys) can enter/leave a token.
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
		// Delay so a menu mousedown can land first (it prevents default, but blur
		// ordering differs across platforms).
		setTimeout(() => {
			if (menu && document.activeElement !== input) {
				closeMenu();
			}
		}, 100);
	});

	const disposable = toDisposable(() => {
		closeMenu();
		input.removeEventListener('keydown', onKeydown);
		input.removeEventListener('input', onInput);
		input.removeEventListener('click', onCaretMove);
		input.removeEventListener('keyup', onCaretMove);
	});

	return {
		collectAttachments: text => collectMentionAttachments(text, recorded),
		reset: () => recorded.clear(),
		dispose: () => disposable.dispose(),
	};
}
