/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../base/common/lifecycle.js';

/**
 * Shell-style prompt history for the composer textarea: ArrowUp with the caret
 * on the FIRST line recalls earlier prompts (newest first), ArrowDown on the
 * last line walks back toward the draft, which is restored past the newest
 * entry. Escape abandons navigation and restores the draft. Any manual edit
 * leaves history mode and the edited text becomes the next draft.
 *
 * The first-line/last-line guards keep multiline editing intact — everywhere
 * else the arrows keep their native caret behavior.
 *
 * IMPORTANT: install AFTER every menu module (mentions, slash commands). Their
 * keydown handlers stopImmediatePropagation while a menu is open, which is
 * exactly what silences history navigation for the arrows the menu consumes.
 */

/**
 * Newest-last recall stack from chronological prompt texts: trimmed, blanks
 * dropped, duplicates collapsed onto their most recent occurrence, capped.
 */
export function collectPromptHistory(texts: readonly string[], limit = 50): string[] {
	const seen = new Set<string>();
	const entries: string[] = [];
	for (let i = texts.length - 1; i >= 0 && entries.length < limit; i--) {
		const text = texts[i]!.trim();
		if (text === '' || seen.has(text)) {
			continue;
		}
		seen.add(text);
		entries.push(text);
	}
	return entries.reverse();
}

/** A collapsed caret before any newline — ArrowUp may recall instead of moving. */
export function caretOnFirstLine(value: string, selectionStart: number, selectionEnd: number): boolean {
	return selectionStart === selectionEnd && !value.slice(0, selectionStart).includes('\n');
}

/** A collapsed caret after the last newline — ArrowDown may navigate instead of moving. */
export function caretOnLastLine(value: string, selectionStart: number, selectionEnd: number): boolean {
	return selectionStart === selectionEnd && !value.slice(selectionEnd).includes('\n');
}

/**
 * Pure navigation state over a snapshot of entries plus the draft that was in
 * the input when navigation started. Index `entries.length` means "back at the
 * draft" (not navigating).
 */
export class PromptHistoryCursor {
	private index: number;

	constructor(
		private readonly entries: readonly string[],
		private readonly draft: string,
	) {
		this.index = entries.length;
	}

	/** False once navigation has stepped back onto the draft. */
	get active(): boolean {
		return this.index < this.entries.length;
	}

	/** Step to the older entry; undefined when already at the oldest. */
	up(): string | undefined {
		if (this.index === 0) {
			return undefined;
		}
		this.index--;
		return this.entries[this.index];
	}

	/** Step toward the draft; returns the draft itself (and deactivates) past the newest entry. */
	down(): string | undefined {
		if (!this.active) {
			return undefined;
		}
		this.index++;
		return this.index === this.entries.length ? this.draft : this.entries[this.index];
	}

	/** Abandon navigation: deactivate and hand the draft back. */
	cancel(): string {
		this.index = this.entries.length;
		return this.draft;
	}
}

export interface IPromptHistoryOptions {
	readonly input: HTMLTextAreaElement;
	/** Candidate texts in chronological order (oldest first); read when navigation starts. */
	readonly getHistory: () => readonly string[];
}

export interface IPromptHistoryController extends IDisposable {
	/** Drop any in-flight navigation — the draft belongs to the session it was typed in. */
	reset(): void;
}

export function installPromptHistory(options: IPromptHistoryOptions): IPromptHistoryController {
	const { input } = options;
	let cursor: PromptHistoryCursor | undefined;
	let applying = false;

	const apply = (text: string): void => {
		// The input event must still fire (send-button state tracks it), but it
		// must not be mistaken for a manual edit, which exits history mode.
		applying = true;
		input.value = text;
		input.setSelectionRange(text.length, text.length);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		applying = false;
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (event.isComposing || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		if (event.key === 'ArrowUp') {
			if (!caretOnFirstLine(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0)) {
				return;
			}
			if (!cursor) {
				const entries = collectPromptHistory(options.getHistory());
				if (entries.length === 0) {
					return;
				}
				cursor = new PromptHistoryCursor(entries, input.value);
			}
			// Consumed even at the oldest entry — a native caret jump to
			// position 0 mid-recall would read as "nothing happened".
			event.preventDefault();
			const text = cursor.up();
			if (text !== undefined) {
				apply(text);
			}
			return;
		}
		if (event.key === 'ArrowDown') {
			if (!cursor || !caretOnLastLine(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0)) {
				return;
			}
			event.preventDefault();
			const text = cursor.down();
			if (!cursor.active) {
				cursor = undefined;
			}
			if (text !== undefined) {
				apply(text);
			}
			return;
		}
		if (event.key === 'Escape' && cursor) {
			event.preventDefault();
			event.stopImmediatePropagation();
			apply(cursor.cancel());
			cursor = undefined;
		}
	};

	const onInput = (): void => {
		if (!applying) {
			// A manual edit leaves history mode; the edited text is the new draft.
			cursor = undefined;
		}
	};

	input.addEventListener('keydown', onKeydown);
	input.addEventListener('input', onInput);

	return {
		reset: () => {
			cursor = undefined;
		},
		dispose: () => {
			input.removeEventListener('keydown', onKeydown);
			input.removeEventListener('input', onInput);
		},
	};
}
