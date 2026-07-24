/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILTIN_THEME_SEEDS, contrastRatio, deriveTheme, hexToRgb, semanticColorTokenIds, type IThemeSeed } from '../../src/sessions/common/themeSeed.js';

test('every built-in seed derives a COMPLETE map — no token id resolves to undefined', () => {
	for (const [name, seed] of Object.entries(BUILTIN_THEME_SEEDS)) {
		const derived = deriveTheme(seed);
		for (const id of semanticColorTokenIds) {
			assert.ok(typeof derived[id] === 'string' && derived[id] !== '', `${name}: ${id}`);
		}
	}
});

test('built-in anchors are the seed values verbatim (bg/fg/accent are inputs, never re-derived)', () => {
	const dark = deriveTheme(BUILTIN_THEME_SEEDS.dark);
	assert.equal(dark['agents.color.background'], '#111111');
	assert.equal(dark['agents.color.text.primary'], '#cccccc');
	assert.equal(dark['agents.color.accent'], '#0078d4');
	// The fitted ladder and family rules reproduce the retired hand table.
	assert.equal(dark['agents.color.text.secondary'], 'rgba(204, 204, 204, 0.72)');
	assert.equal(dark['agents.color.panel.border'], 'rgba(204, 204, 204, 0.15)');
	assert.equal(dark['agents.color.input.background'], '#1f1f1f');
	const light = deriveTheme(BUILTIN_THEME_SEEDS.light);
	assert.equal(light['agents.color.panel.background'], '#ffffff');
	assert.equal(light['agents.color.inactiveSession.background'], '#f6f8fa');
});

test('WCAG: primary text reads ≥4.5:1 on the background for every built-in AND for a hostile seed (clamp engages)', () => {
	for (const [name, seed] of Object.entries(BUILTIN_THEME_SEEDS)) {
		const derived = deriveTheme(seed);
		const ratio = contrastRatio(hexToRgb(derived['agents.color.text.primary']), hexToRgb(derived['agents.color.background']));
		assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}`);
	}
	// Gray-on-gray: unusable as seeded — the clamp must rescue it.
	const hostile: IThemeSeed = { background: '#777777', foreground: '#888888', accent: '#0078d4' };
	const derived = deriveTheme(hostile);
	const ratio = contrastRatio(hexToRgb(derived['agents.color.text.primary']), hexToRgb(derived['agents.color.background']));
	assert.ok(ratio >= 4.5, `clamped ratio ${ratio.toFixed(2)}`);
	assert.notEqual(derived['agents.color.text.primary'], '#888888', 'the failing foreground was moved');
});

test('accent foreground: white-biased pick — white on mid blue, black only when decisively better', () => {
	const blue = deriveTheme({ background: '#111111', foreground: '#cccccc', accent: '#0078d4' });
	assert.equal(blue['agents.color.accent.foreground'], '#ffffff');
	const orange = deriveTheme({ background: '#000000', foreground: '#ffffff', accent: '#f38518' });
	assert.equal(orange['agents.color.accent.foreground'], '#000000');
	const nordFrost = deriveTheme({ background: '#2e3440', foreground: '#d8dee9', accent: '#88c0d0' });
	assert.equal(nordFrost['agents.color.accent.foreground'], '#000000');
});

test('contrast slider scales the text ladder monotonically; 100 saturates secondary to the full foreground', () => {
	const at = (contrast: number): string => deriveTheme({ background: '#111111', foreground: '#cccccc', accent: '#0078d4', contrast })['agents.color.text.muted'];
	const alphaOf = (value: string): number => Number(/,\s*([\d.]+)\)$/.exec(value)?.[1] ?? '1');
	assert.ok(alphaOf(at(0)) < alphaOf(at(50)));
	assert.ok(alphaOf(at(50)) < alphaOf(at(100)));
	const saturated = deriveTheme({ background: '#111111', foreground: '#cccccc', accent: '#0078d4', contrast: 100 });
	assert.equal(saturated['agents.color.text.secondary'], '#cccccc', 'alpha ≥1 collapses to the solid color');
});

test('a border seed flattens the theme: solid borders everywhere, surfaces stay the background (HC character)', () => {
	const derived = deriveTheme({ background: '#000000', foreground: '#ffffff', accent: '#f38518', border: '#6fc3df' });
	assert.equal(derived['agents.color.panel.border'], '#6fc3df');
	assert.equal(derived['agents.color.divider'], '#6fc3df');
	assert.equal(derived['agents.color.panel.background'], '#000000');
	assert.equal(derived['agents.color.input.background'], '#000000');
});

test('overrides apply last and win verbatim', () => {
	const derived = deriveTheme({ background: '#111111', foreground: '#cccccc', accent: '#0078d4', overrides: { 'agents.color.sidebar.background': '#24343a' } });
	assert.equal(derived['agents.color.sidebar.background'], '#24343a');
});

test('every library preset derives WCAG-passing text and matches its declared polarity (#8 P3)', async () => {
	const { THEME_PRESETS } = await import('../../src/sessions/common/themePresets.js');
	const { relativeLuminance } = await import('../../src/sessions/common/themeSeed.js');
	for (const preset of THEME_PRESETS) {
		const derived = deriveTheme(preset.seed);
		const ratio = contrastRatio(hexToRgb(derived['agents.color.text.primary']), hexToRgb(derived['agents.color.background']));
		assert.ok(ratio >= 4.5, `${preset.id}: ${ratio.toFixed(2)}`);
		const isDark = relativeLuminance(hexToRgb(preset.seed.background)) < 0.5;
		assert.equal(isDark ? 'dark' : 'light', preset.polarity, `${preset.id} polarity`);
	}
});
