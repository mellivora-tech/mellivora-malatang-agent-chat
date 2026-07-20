/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Seed-derived themes (#8 P2, Codex-style): a theme is not a hand-maintained
 * 44-value table but a pure function of ~6 seed values. The derivation rules
 * below were REVERSE-FITTED from the three hand-tuned built-ins — the ladder
 * alphas, elevation percentages and polarity switches reproduce the previous
 * tables exactly for most tokens (±1 RGB point on a few dark surfaces).
 *
 * Deliberate design decisions that are NOT derivable (the sidebar's teal, the
 * avatar's brown, high contrast's solid cyan borders) stay pixel-true as seed
 * `overrides` — the escape hatch is part of the model, not a defeat of it:
 * a preset is still a ~6-value JSON plus at most a handful of exceptions.
 */

/** The full per-theme color surface. Moved here from theme.ts (which re-exports it) so the derive engine and the registry share one list without an import cycle. */
export const semanticColorTokenIds = [
	'agents.color.background',
	'agents.color.gradient.tint',
	'agents.color.sidebar.background',
	'agents.color.stage.background',
	'agents.color.stage.border',
	'agents.color.watermark',
	'agents.color.panel.background',
	'agents.color.panel.border',
	'agents.color.text.primary',
	'agents.color.text.secondary',
	'agents.color.text.muted',
	'agents.color.text.subtle',
	'agents.color.text.disabled',
	'agents.color.text.inverse',
	'agents.color.link',
	'agents.color.accent',
	'agents.color.accent.foreground',
	'agents.color.avatar.background',
	'agents.color.avatar.foreground',
	'agents.color.focusBorder',
	'agents.color.badge.background',
	'agents.color.badge.foreground',
	'agents.color.input.background',
	'agents.color.input.foreground',
	'agents.color.input.border',
	'agents.color.control.background',
	'agents.color.control.border',
	'agents.color.control.hoverBackground',
	'agents.color.selection.background',
	'agents.color.activeSession.background',
	'agents.color.inactiveSession.background',
	'agents.color.success',
	'agents.color.danger',
	'agents.color.warning',
	'agents.color.info',
	'agents.color.scrim',
	'agents.color.shadow',
	'agents.color.scrollbar.thumb',
	'agents.color.scrollbar.thumbHover',
	'agents.color.divider',
	'agents.color.modal.background',
	'agents.color.menu.background',
	'agents.color.menu.border',
] as const;

export type SemanticColorTokenId = (typeof semanticColorTokenIds)[number];
export type SemanticColorMap = Record<SemanticColorTokenId, string>;

/** L0: what a theme IS. Everything else derives. */
export interface IThemeSeed {
	/** Hex. The app background; polarity (dark/light) is derived from its luminance. */
	readonly background: string;
	/** Hex. Primary text; the whole text/border/control ladder is this color at fitted alphas. */
	readonly foreground: string;
	/** Hex. Focus, badges, selection, links; its own foreground is contrast-picked automatically. */
	readonly accent: string;
	/** 0-100 (default 50 = the built-in ladder). Scales the text ladder's alphas; WCAG clamping applies regardless. */
	readonly contrast?: number;
	/** Status colors — independent seeds by design (never derived from accent). Absent → polarity defaults. */
	readonly success?: string;
	readonly danger?: string;
	readonly warning?: string;
	/** Info tone; absent → follows the derived link color. */
	readonly info?: string;
	/** Solid border color (high-contrast style). Its presence ALSO flattens every surface to the background — HC's whole character. */
	readonly border?: string;
	/** Pixel-true exceptions (deliberate design values the formula cannot know). Applied last. */
	readonly overrides?: Readonly<Partial<Record<SemanticColorTokenId, string>>>;
}

// --- color math ----------------------------------------------------------------

interface IRgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export function hexToRgb(hex: string): IRgb {
	const raw = hex.replace('#', '');
	const full = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw;
	const value = Number.parseInt(full, 16);
	return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function toHex(rgb: IRgb): string {
	const channel = (value: number): string => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
	return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function mix(from: IRgb, to: IRgb, amount: number): IRgb {
	return { r: from.r + (to.r - from.r) * amount, g: from.g + (to.g - from.g) * amount, b: from.b + (to.b - from.b) * amount };
}

function alpha(rgb: IRgb, value: number): string {
	const rounded = Math.round(value * 100) / 100;
	if (rounded >= 1) {
		return toHex(rgb); // a fully-opaque "alpha" is just the color
	}
	return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${rounded})`;
}

/** WCAG relative luminance (0 black … 1 white). */
export function relativeLuminance(rgb: IRgb): number {
	const linear = (channel: number): number => {
		const scaled = channel / 255;
		return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG contrast ratio (1 … 21). */
export function contrastRatio(a: IRgb, b: IRgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * White or black text on the given color — with a bias toward white: on mid
 * blues (#0078d4) raw WCAG arithmetic narrowly prefers black, but every
 * design system ships white there; black only wins when it is DECISIVELY
 * better (bright accents like HC's #f38518, Nord's #88c0d0).
 */
function onColor(rgb: IRgb): string {
	const white: IRgb = { r: 255, g: 255, b: 255 };
	const black: IRgb = { r: 0, g: 0, b: 0 };
	return contrastRatio(white, rgb) * 1.25 >= contrastRatio(black, rgb) ? '#ffffff' : '#000000';
}

const WCAG_MINIMUM = 4.5;

/** Push `fg` toward the polarity pole until it reads ≥4.5:1 on `bg`. Candidates are evaluated CHANNEL-ROUNDED — the shipped hex is what must pass, not the float the search walked through. Returns fg unchanged when it already passes; the pole itself is the fallback for pathological backgrounds. */
export function clampToContrast(fg: IRgb, bg: IRgb): IRgb {
	if (contrastRatio(fg, bg) >= WCAG_MINIMUM) {
		return fg;
	}
	// The pole is whichever extreme actually reads better on THIS background —
	// not the polarity guess: around mid-gray (#777) the luminance-implied pole
	// can top out at 4.47:1 while the opposite pole clears 4.69:1. The better
	// pole always reaches ≥4.58:1 (the worst-case background sits at the
	// equal-ratio luminance), so the clamp can never fail entirely.
	const white: IRgb = { r: 255, g: 255, b: 255 };
	const black: IRgb = { r: 0, g: 0, b: 0 };
	const pole: IRgb = contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
	const rounded = (value: IRgb): IRgb => ({ r: Math.round(value.r), g: Math.round(value.g), b: Math.round(value.b) });
	let low = 0;
	let high = 1;
	for (let step = 0; step < 12; step++) {
		const middle = (low + high) / 2;
		if (contrastRatio(rounded(mix(fg, pole, middle)), bg) >= WCAG_MINIMUM) {
			high = middle;
		} else {
			low = middle;
		}
	}
	const candidate = rounded(mix(fg, pole, high));
	return contrastRatio(candidate, bg) >= WCAG_MINIMUM ? candidate : pole;
}

// --- derivation ----------------------------------------------------------------

/** The text ladder's base alphas (fitted: identical in the dark AND light built-ins). */
const LADDER = { secondary: 0.72, muted: 0.58, subtle: 0.42, disabled: 0.38 } as const;

export function deriveTheme(seed: IThemeSeed): SemanticColorMap {
	const bg = hexToRgb(seed.background);
	const fgRaw = hexToRgb(seed.foreground);
	const accent = hexToRgb(seed.accent);
	const isDark = relativeLuminance(bg) < 0.5;
	const flat = seed.border !== undefined; // high-contrast character: solid borders, no elevation
	const white: IRgb = { r: 255, g: 255, b: 255 };
	const black: IRgb = { r: 0, g: 0, b: 0 };

	// Contrast slider: 50 = the fitted ladder; the WCAG clamp below is the floor no slider can break.
	const contrast = Math.max(0, Math.min(100, seed.contrast ?? 50));
	const factor = 0.6 + (contrast / 100) * 0.8;
	const ladder = (base: number): string => alpha(fgRaw, Math.min(1, base * factor));

	const fg = clampToContrast(fgRaw, bg);
	const fgHex = toHex(fg);

	// Elevation: dark surfaces climb toward white in fitted steps; light
	// surfaces jump to white outright (the light built-in's panels are pure
	// white); a flat (bordered) theme has no elevation at all.
	const surface = (step: number): string => (flat ? toHex(bg) : isDark ? toHex(mix(bg, white, step)) : toHex(mix(bg, white, 1)));

	const border = (value: number): string => seed.border ?? alpha(fgRaw, value);

	const link = isDark ? toHex(mix(accent, white, 0.35)) : seed.accent;
	const accentForeground = onColor(accent);

	const derived: SemanticColorMap = {
		'agents.color.background': toHex(bg),
		'agents.color.gradient.tint': seed.accent,
		'agents.color.sidebar.background': flat ? toHex(bg) : toHex(mix(bg, accent, isDark ? 0.16 : 0.06)),
		'agents.color.stage.background': surface(0.04),
		'agents.color.stage.border': border(0.18),
		'agents.color.watermark': seed.border ?? alpha(fgRaw, isDark ? 0.11 : 0.09),
		'agents.color.panel.background': surface(0.085),
		'agents.color.panel.border': border(0.15),
		'agents.color.text.primary': fgHex,
		'agents.color.text.secondary': ladder(LADDER.secondary),
		'agents.color.text.muted': ladder(LADDER.muted),
		'agents.color.text.subtle': ladder(LADDER.subtle),
		'agents.color.text.disabled': ladder(LADDER.disabled),
		'agents.color.text.inverse': accentForeground,
		'agents.color.link': link,
		'agents.color.accent': seed.accent,
		'agents.color.accent.foreground': accentForeground,
		'agents.color.avatar.background': seed.accent,
		'agents.color.avatar.foreground': accentForeground,
		'agents.color.focusBorder': seed.accent,
		'agents.color.badge.background': seed.accent,
		'agents.color.badge.foreground': accentForeground,
		'agents.color.input.background': surface(0.06),
		'agents.color.input.foreground': fgHex,
		'agents.color.input.border': border(0.18),
		'agents.color.control.background': flat ? toHex(bg) : alpha(fgRaw, 0.05),
		'agents.color.control.border': border(0.16),
		'agents.color.control.hoverBackground': flat ? alpha(accent, 0.24) : alpha(fgRaw, isDark ? 0.1 : 0.08),
		'agents.color.selection.background': alpha(accent, flat ? 0.32 : isDark ? 0.18 : 0.14),
		'agents.color.activeSession.background': surface(0.04),
		'agents.color.inactiveSession.background': flat || !isDark ? toHex(bg) : surface(0.055),
		'agents.color.success': seed.success ?? (isDark ? '#7ee787' : '#1a7f37'),
		'agents.color.danger': seed.danger ?? (isDark ? '#ff7b72' : '#cf222e'),
		'agents.color.warning': seed.warning ?? (isDark ? '#cca700' : '#9a6700'),
		'agents.color.info': seed.info ?? link,
		'agents.color.scrim': flat ? alpha(black, 0.72) : isDark ? alpha(black, 0.36) : alpha(fgRaw, 0.28),
		'agents.color.shadow': flat ? alpha(black, 0.72) : isDark ? alpha(black, 0.48) : alpha(fgRaw, 0.18),
		'agents.color.scrollbar.thumb': seed.border ?? alpha(fgRaw, 0.28),
		'agents.color.scrollbar.thumbHover': flat ? seed.accent : alpha(fgRaw, 0.42),
		'agents.color.divider': border(0.1),
		'agents.color.modal.background': surface(0.065),
		'agents.color.menu.background': surface(0.055),
		'agents.color.menu.border': border(isDark ? 0.08 : 0.15),
	};

	return seed.overrides ? { ...derived, ...seed.overrides } : derived;
}

// --- the built-ins, demoted to seeds -------------------------------------------

/**
 * The three shipped themes as seeds. Overrides carry only the values that are
 * design decisions, not derivations: the teal sidebar/stage accents and brown
 * avatar of dark & light, dark's hand-picked link/menu chroma, and high
 * contrast's exact text ladder (its steps are not a uniform multiple of the
 * base ladder — accessibility values stay bit-true).
 */
export const BUILTIN_THEME_SEEDS: Readonly<Record<'dark' | 'light' | 'highContrast', IThemeSeed>> = {
	dark: {
		background: '#111111',
		foreground: '#cccccc',
		accent: '#0078d4',
		info: '#4fc1ff',
		overrides: {
			'agents.color.sidebar.background': '#24343a',
			'agents.color.stage.background': '#1a1a1a',
			'agents.color.activeSession.background': '#1a1a1a',
			'agents.color.stage.border': 'rgba(117, 187, 199, 0.28)',
			'agents.color.avatar.background': '#9b7b72',
			'agents.color.avatar.foreground': '#ffffff',
			'agents.color.link': '#4fc1ff',
			'agents.color.menu.background': '#1b1d22',
			'agents.color.menu.border': 'rgba(255, 255, 255, 0.08)',
			'agents.color.modal.background': '#202020',
			'agents.color.panel.background': '#252526',
		},
	},
	light: {
		background: '#f6f8fa',
		foreground: '#1f2328',
		accent: '#0969da',
		overrides: {
			'agents.color.sidebar.background': '#edf4f7',
			'agents.color.avatar.background': '#9b7b72',
			'agents.color.avatar.foreground': '#ffffff',
		},
	},
	highContrast: {
		background: '#000000',
		foreground: '#ffffff',
		accent: '#f38518',
		contrast: 100,
		border: '#6fc3df',
		success: '#00ff00',
		danger: '#ff0000',
		warning: '#ffff00',
		info: '#75beff',
		overrides: {
			'agents.color.link': '#75beff',
			'agents.color.text.muted': '#d6d6d6',
			'agents.color.text.subtle': '#bdbdbd',
			'agents.color.text.disabled': '#8a8a8a',
			'agents.color.avatar.background': '#f38518',
			'agents.color.avatar.foreground': '#000000',
		},
	},
};
