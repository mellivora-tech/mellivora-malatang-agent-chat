/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BUILTIN_THEME_SEEDS, type IThemeSeed } from './themeSeed.js';

/**
 * The preset library (#8 P3, Codex-style): each well-known color scheme is a
 * ~6-value seed JSON — this is exactly why a dozen presets cost almost
 * nothing under the seed model, where a 44-value hand table per preset would
 * be a maintenance disaster. Base color values come from the schemes' public
 * palettes (color values are not copyrightable; names credited):
 * Catppuccin (MIT), Gruvbox (MIT), GitHub Primer (MIT), Atom One (MIT),
 * Everforest (MIT), Nord (MIT).
 */
export interface IThemePreset {
	readonly id: string;
	/** Display name — scheme names are proper nouns, shown as-is in every locale. */
	readonly label: string;
	readonly polarity: 'light' | 'dark';
	readonly seed: IThemeSeed;
}

export const THEME_PRESETS: readonly IThemePreset[] = [
	{ id: 'dark', label: 'Dark', polarity: 'dark', seed: BUILTIN_THEME_SEEDS.dark },
	{ id: 'light', label: 'Light', polarity: 'light', seed: BUILTIN_THEME_SEEDS.light },
	{ id: 'highContrast', label: 'High Contrast', polarity: 'dark', seed: BUILTIN_THEME_SEEDS.highContrast },
	{
		id: 'catppuccin-mocha',
		label: 'Catppuccin Mocha',
		polarity: 'dark',
		seed: { background: '#1e1e2e', foreground: '#cdd6f4', accent: '#cba6f7', success: '#a6e3a1', danger: '#f38ba8', warning: '#f9e2af', info: '#89b4fa' },
	},
	{
		id: 'catppuccin-latte',
		label: 'Catppuccin Latte',
		polarity: 'light',
		seed: { background: '#eff1f5', foreground: '#4c4f69', accent: '#8839ef', success: '#40a02b', danger: '#d20f39', warning: '#df8e1d', info: '#1e66f5' },
	},
	{
		id: 'gruvbox-dark',
		label: 'Gruvbox Dark',
		polarity: 'dark',
		seed: { background: '#282828', foreground: '#ebdbb2', accent: '#d79921', success: '#b8bb26', danger: '#fb4934', warning: '#fabd2f', info: '#83a598' },
	},
	{
		id: 'github-dark',
		label: 'GitHub Dark',
		polarity: 'dark',
		seed: { background: '#0d1117', foreground: '#e6edf3', accent: '#2f81f7', success: '#3fb950', danger: '#f85149', warning: '#d29922', info: '#58a6ff' },
	},
	{
		id: 'github-light',
		label: 'GitHub Light',
		polarity: 'light',
		seed: { background: '#ffffff', foreground: '#1f2328', accent: '#0969da', success: '#1a7f37', danger: '#cf222e', warning: '#9a6700', info: '#0969da' },
	},
	{
		id: 'one-dark',
		label: 'One Dark',
		polarity: 'dark',
		seed: { background: '#282c34', foreground: '#abb2bf', accent: '#61afef', success: '#98c379', danger: '#e06c75', warning: '#e5c07b', info: '#56b6c2' },
	},
	{
		id: 'everforest-dark',
		label: 'Everforest Dark',
		polarity: 'dark',
		seed: { background: '#2d353b', foreground: '#d3c6aa', accent: '#a7c080', success: '#a7c080', danger: '#e67e80', warning: '#dbbc7f', info: '#7fbbb3' },
	},
	{
		id: 'nord',
		label: 'Nord',
		polarity: 'dark',
		seed: { background: '#2e3440', foreground: '#d8dee9', accent: '#88c0d0', success: '#a3be8c', danger: '#bf616a', warning: '#ebcb8b', info: '#81a1c1' },
	},
];

export function findThemePreset(id: string): IThemePreset | undefined {
	return THEME_PRESETS.find(preset => preset.id === id);
}

export function presetsForPolarity(polarity: 'light' | 'dark'): readonly IThemePreset[] {
	return THEME_PRESETS.filter(preset => preset.polarity === polarity);
}
