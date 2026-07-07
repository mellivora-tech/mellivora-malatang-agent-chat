/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyThemeTokens, type ThemeId } from '../../platform/theme/theme.js';

/**
 * Renderer-side UI preferences, persisted to localStorage and applied to the
 * workbench root. These are real, effective settings (theme, motion) — no
 * backing IPC is required because they only affect the renderer.
 */
export interface IUiPreferences {
	readonly theme: ThemeId;
	readonly reduceMotion: boolean;
}

const STORAGE_KEY = 'agentChat.preferences';
const THEMES: readonly ThemeId[] = ['dark', 'light', 'highContrast'];
const DEFAULTS: IUiPreferences = { theme: 'dark', reduceMotion: false };

export function readPreferences(): IUiPreferences {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
		return {
			theme: THEMES.includes(raw['theme'] as ThemeId) ? (raw['theme'] as ThemeId) : DEFAULTS.theme,
			reduceMotion: typeof raw['reduceMotion'] === 'boolean' ? raw['reduceMotion'] : DEFAULTS.reduceMotion,
		};
	} catch {
		return DEFAULTS;
	}
}

export function updatePreferences(patch: Partial<IUiPreferences>): IUiPreferences {
	const next: IUiPreferences = { ...readPreferences(), ...patch };
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Persistence is best-effort; still apply the change this session.
	}
	applyUiPreferences(next);
	return next;
}

/** Apply the preferences to the workbench root (theme tokens + motion class). */
export function applyUiPreferences(prefs: IUiPreferences = readPreferences()): void {
	const root = document.querySelector<HTMLElement>('.agent-sessions-workbench');
	if (!root) {
		return;
	}

	applyThemeTokens(root, prefs.theme);
	root.classList.toggle('reduce-motion', prefs.reduceMotion);
}
