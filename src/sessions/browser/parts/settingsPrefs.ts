/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyThemeTokens, getTokenCssVariableName, type ThemeId } from '../../platform/theme/theme.js';
import { withLegacyAliases } from '../../common/theme.js';
import { deriveTheme, type IThemeSeed } from '../../common/themeSeed.js';
import { findThemePreset, THEME_PRESETS } from '../../common/themePresets.js';
import { LOCALE_PREFERENCES, type LocalePreference } from '../../common/i18n/i18n.js';

/**
 * Renderer-side UI preferences, persisted to localStorage and applied to the
 * workbench root. These are real, effective settings (appearance, motion,
 * locale) — no backing IPC is required because they only affect the renderer.
 */

/** One appearance slot (#8 P3): the chosen preset, plus a seed snapshot iff the user customized it (its presence IS the dirty flag). */
export interface IAppearanceSlotPrefs {
	readonly presetId: string;
	readonly seed?: IThemeSeed;
}

/** Codex-shaped appearance state: a mode selector and an independent preset per polarity (GitHub Light + Gruvbox Dark is a legal pair). */
export interface IAppearancePrefs {
	readonly mode: 'system' | 'light' | 'dark';
	readonly light: IAppearanceSlotPrefs;
	readonly dark: IAppearanceSlotPrefs;
}

export interface IUiPreferences {
	/** Legacy single-theme field — kept in sync with the resolved slot for anything still reading it; `appearance` is the source of truth. */
	readonly theme: ThemeId;
	readonly reduceMotion: boolean;
	/** #9: 'system' follows the OS; a pinned locale takes effect on next reload
	 *  (i18n.ts resolves the active locale once at module load — same model
	 *  the theme preference uses in practice for a full restyle). */
	readonly locale: LocalePreference;
	readonly appearance: IAppearancePrefs;
}

const STORAGE_KEY = 'agentChat.preferences';
const THEMES: readonly ThemeId[] = ['dark', 'light', 'highContrast'];
const DEFAULT_APPEARANCE: IAppearancePrefs = { mode: 'dark', light: { presetId: 'light' }, dark: { presetId: 'dark' } };
const DEFAULTS: IUiPreferences = { theme: 'dark', reduceMotion: false, locale: 'system', appearance: DEFAULT_APPEARANCE };

function sanitizeSlot(raw: unknown, fallback: IAppearanceSlotPrefs, polarity: 'light' | 'dark'): IAppearanceSlotPrefs {
	if (typeof raw !== 'object' || raw === null) {
		return fallback;
	}
	const record = raw as Record<string, unknown>;
	const preset = typeof record['presetId'] === 'string' ? findThemePreset(record['presetId']) : undefined;
	if (!preset || preset.polarity !== polarity) {
		return fallback;
	}
	const seed = record['seed'];
	const validSeed =
		typeof seed === 'object' &&
		seed !== null &&
		typeof (seed as Record<string, unknown>)['background'] === 'string' &&
		typeof (seed as Record<string, unknown>)['foreground'] === 'string' &&
		typeof (seed as Record<string, unknown>)['accent'] === 'string';
	return { presetId: preset.id, ...(validSeed ? { seed: seed as IThemeSeed } : {}) };
}

function sanitizeAppearance(raw: unknown, legacyTheme: ThemeId): IAppearancePrefs {
	// Pre-#8 prefs carried only `theme` — migrate it: highContrast is a DARK
	// preset in the new model, not a mode.
	const migrated: IAppearancePrefs =
		legacyTheme === 'light'
			? { mode: 'light', light: { presetId: 'light' }, dark: { presetId: 'dark' } }
			: legacyTheme === 'highContrast'
				? { mode: 'dark', light: { presetId: 'light' }, dark: { presetId: 'highContrast' } }
				: DEFAULT_APPEARANCE;
	if (typeof raw !== 'object' || raw === null) {
		return migrated;
	}
	const record = raw as Record<string, unknown>;
	const mode = record['mode'] === 'system' || record['mode'] === 'light' || record['mode'] === 'dark' ? record['mode'] : migrated.mode;
	return {
		mode,
		light: sanitizeSlot(record['light'], migrated.light, 'light'),
		dark: sanitizeSlot(record['dark'], migrated.dark, 'dark'),
	};
}

export function readPreferences(): IUiPreferences {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
		const theme = THEMES.includes(raw['theme'] as ThemeId) ? (raw['theme'] as ThemeId) : DEFAULTS.theme;
		return {
			theme,
			reduceMotion: typeof raw['reduceMotion'] === 'boolean' ? raw['reduceMotion'] : DEFAULTS.reduceMotion,
			locale: LOCALE_PREFERENCES.includes(raw['locale'] as LocalePreference) ? (raw['locale'] as LocalePreference) : DEFAULTS.locale,
			appearance: sanitizeAppearance(raw['appearance'], theme),
		};
	} catch {
		return DEFAULTS;
	}
}

export function updatePreferences(patch: Partial<IUiPreferences>): IUiPreferences {
	const merged: IUiPreferences = { ...readPreferences(), ...patch };
	// Keep the legacy `theme` field tracking the resolved slot — old readers
	// (and the e2e's data-agents-theme assertions) stay coherent.
	const next: IUiPreferences = { ...merged, theme: resolveActiveThemeId(merged.appearance) };
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Persistence is best-effort; still apply the change this session.
	}
	applyUiPreferences(next);
	return next;
}

/** The slot the current mode selects (system → OS preference). */
export function resolveActiveSlot(appearance: IAppearancePrefs): { readonly polarity: 'light' | 'dark'; readonly slot: IAppearanceSlotPrefs } {
	const polarity = appearance.mode === 'system' ? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appearance.mode;
	return { polarity, slot: appearance[polarity] };
}

/** The ThemeId whose BASE tokens (and data-agents-theme attr) back the active slot — highContrast keeps its identity, every other preset rides its polarity. */
function resolveActiveThemeId(appearance: IAppearancePrefs): ThemeId {
	const { polarity, slot } = resolveActiveSlot(appearance);
	return slot.presetId === 'highContrast' ? 'highContrast' : polarity;
}

/** The seed the active slot renders: the user's customized seed, else the preset's. */
export function resolveActiveSeed(appearance: IAppearancePrefs): IThemeSeed {
	const { slot } = resolveActiveSlot(appearance);
	return slot.seed ?? findThemePreset(slot.presetId)?.seed ?? THEME_PRESETS[0]!.seed;
}

const FONT_TOKEN_UI = 'agents.font.ui';
const FONT_TOKEN_MONO = 'agents.font.mono';

/** Overlay a seed's derived colors (and font overrides) on top of the applied base theme. */
function applySeedOverlay(target: HTMLElement, seed: IThemeSeed): void {
	const values = withLegacyAliases(deriveTheme(seed));
	for (const [id, value] of Object.entries(values)) {
		target.style.setProperty(getTokenCssVariableName(id), value);
	}
	if (seed.uiFont !== undefined && seed.uiFont.trim() !== '') {
		target.style.setProperty(getTokenCssVariableName(FONT_TOKEN_UI), seed.uiFont);
	}
	if (seed.codeFont !== undefined && seed.codeFont.trim() !== '') {
		target.style.setProperty(getTokenCssVariableName(FONT_TOKEN_MONO), seed.codeFont);
	}
}

let systemModeListener: (() => void) | undefined;

/** Apply the preferences to the workbench root (theme tokens + motion class). */
export function applyUiPreferences(prefs: IUiPreferences = readPreferences()): void {
	const root = document.querySelector<HTMLElement>('.agent-sessions-workbench');
	if (!root) {
		return;
	}

	const themeId = resolveActiveThemeId(prefs.appearance);
	const seed = resolveActiveSeed(prefs.appearance);
	// Document root first (html/body base styles consume tokens), then the
	// workbench root (keeps data-agents-theme where the e2e — and CSS scoping —
	// expect it). The base theme supplies sizes + the data attr; the seed
	// overlay then rewrites every color var, so built-in and custom seeds run
	// the SAME pipeline (one code path, no privileged built-ins).
	for (const target of [document.documentElement, root]) {
		applyThemeTokens(target, themeId);
		applySeedOverlay(target, seed);
	}
	root.classList.toggle('reduce-motion', prefs.reduceMotion);

	// mode 'system' re-applies live when the OS flips (registered once).
	if (prefs.appearance.mode === 'system' && systemModeListener === undefined && typeof matchMedia === 'function') {
		const media = matchMedia('(prefers-color-scheme: light)');
		const onChange = (): void => applyUiPreferences();
		media.addEventListener('change', onChange);
		systemModeListener = () => media.removeEventListener('change', onChange);
	}
}
