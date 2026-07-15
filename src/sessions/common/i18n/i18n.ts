/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { enUS } from './messages.enUS.js';
import { zhCN, type MessageKey } from './messages.zhCN.js';

export type { MessageKey };

/** The persisted preference: follow the OS, or pin a language. */
export type LocalePreference = 'system' | 'zh-CN' | 'en-US';
export type ResolvedLocale = 'zh-CN' | 'en-US';

export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['system', 'zh-CN', 'en-US'];

/** Shared with settingsPrefs — one localStorage object holds theme + motion + locale. */
export const PREFERENCES_STORAGE_KEY = 'agentChat.preferences';

/** zh-CN is the app's source language AND its default: 'system' resolves to
 *  it unconditionally in P0. Real OS-language detection (so an en-US system
 *  gets en-US without the user pinning it) is P1 — once locale switching is
 *  hot instead of reload-based, guessing wrong is cheap to correct; today a
 *  wrong guess would need a reload to undo, so P0 stays deterministic. */
export function resolveLocale(preference: LocalePreference): ResolvedLocale {
	return preference === 'en-US' ? 'en-US' : 'zh-CN';
}

/** Resolved once per process at module load (locale changes apply on reload,
 *  the same model the theme preference uses in practice for full restyles).
 *  Reads the raw preference directly so no UI module has to run first. */
function bootstrapLocale(): ResolvedLocale {
	try {
		if (typeof localStorage !== 'undefined') {
			const raw = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
			const preference = raw['locale'];
			if (preference === 'zh-CN' || preference === 'en-US') {
				return preference;
			}
		}
	} catch {
		// Corrupt prefs → follow the system.
	}
	return resolveLocale('system');
}

let activeLocale: ResolvedLocale = bootstrapLocale();

export function getActiveLocale(): ResolvedLocale {
	return activeLocale;
}

/** Test seam (and future hot-switch hook). Production changes apply on reload. */
export function setActiveLocale(locale: ResolvedLocale): void {
	activeLocale = locale;
}

/** The one lookup: translated template with `{n}` placeholders substituted.
 *  A missing translation falls back to the zh-CN source string. */
export function localize(key: MessageKey, ...args: readonly (string | number)[]): string {
	const template = (activeLocale === 'en-US' ? enUS[key] : undefined) ?? zhCN[key];
	return template.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? match : String(value);
	});
}
