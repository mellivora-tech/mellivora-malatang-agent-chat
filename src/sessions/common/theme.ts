/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerColor, registerTheme } from '../platform/theme/theme.js';

// The token list and the seed-derivation engine live in themeSeed.ts (#8 P2)
// — re-exported here so existing imports keep working.
export { semanticColorTokenIds, type SemanticColorTokenId, type SemanticColorMap, type IThemeSeed, deriveTheme, BUILTIN_THEME_SEEDS } from './themeSeed.js';
import { BUILTIN_THEME_SEEDS, deriveTheme, type SemanticColorMap, type SemanticColorTokenId } from './themeSeed.js';

type LegacyColorTokenId =
	| 'agents.background'
	| 'agentsPanel.background'
	| 'agentsPanel.foreground'
	| 'agentsPanel.border'
	| 'agentsGradient.tintColor'
	| 'agentsChatInput.background'
	| 'agentsChatInput.foreground'
	| 'agentsChatInput.border'
	| 'agentsBadge.background'
	| 'agentsBadge.foreground'
	| 'activeSessionView.background'
	| 'inactiveSessionView.background';

const legacyAliases: Record<LegacyColorTokenId, SemanticColorTokenId> = {
	'agents.background': 'agents.color.background',
	'agentsPanel.background': 'agents.color.panel.background',
	'agentsPanel.foreground': 'agents.color.text.primary',
	'agentsPanel.border': 'agents.color.panel.border',
	'agentsGradient.tintColor': 'agents.color.gradient.tint',
	'agentsChatInput.background': 'agents.color.input.background',
	'agentsChatInput.foreground': 'agents.color.input.foreground',
	'agentsChatInput.border': 'agents.color.input.border',
	'agentsBadge.background': 'agents.color.badge.background',
	'agentsBadge.foreground': 'agents.color.badge.foreground',
	'activeSessionView.background': 'agents.color.activeSession.background',
	'inactiveSessionView.background': 'agents.color.inactiveSession.background',
};

const darkColors: SemanticColorMap = deriveTheme(BUILTIN_THEME_SEEDS.dark);

const lightColors: SemanticColorMap = deriveTheme(BUILTIN_THEME_SEEDS.light);

const highContrastColors: SemanticColorMap = deriveTheme(BUILTIN_THEME_SEEDS.highContrast);

const darkThemeValues = withLegacyAliases(darkColors);
const lightThemeValues = withLegacyAliases(lightColors);
const highContrastThemeValues = withLegacyAliases(highContrastColors);
const registeredColorTokens = new Map<string, ReturnType<typeof registerColor>>();

registerColorTokens(darkThemeValues);

registerTheme({ id: 'dark', label: 'Dark', values: darkThemeValues });
registerTheme({ id: 'light', label: 'Light', values: lightThemeValues });
registerTheme({ id: 'highContrast', label: 'High Contrast', values: highContrastThemeValues });

export const agentsColorBackground = registeredColorTokens.get('agents.color.background')!;
export const agentsColorPanelBackground = registeredColorTokens.get('agents.color.panel.background')!;
export const agentsColorPanelBorder = registeredColorTokens.get('agents.color.panel.border')!;
export const agentsColorTextPrimary = registeredColorTokens.get('agents.color.text.primary')!;
export const agentsColorFocusBorder = registeredColorTokens.get('agents.color.focusBorder')!;
export const agentsColorBadgeBackground = registeredColorTokens.get('agents.color.badge.background')!;
export const agentsColorBadgeForeground = registeredColorTokens.get('agents.color.badge.foreground')!;

export const agentsBackground = registeredColorTokens.get('agents.background')!;
export const agentsPanelBackground = registeredColorTokens.get('agentsPanel.background')!;
export const agentsPanelForeground = registeredColorTokens.get('agentsPanel.foreground')!;
export const agentsPanelBorder = registeredColorTokens.get('agentsPanel.border')!;
export const agentsGradientTintColor = registeredColorTokens.get('agentsGradient.tintColor')!;
export const agentsChatInputBackground = registeredColorTokens.get('agentsChatInput.background')!;
export const agentsChatInputForeground = registeredColorTokens.get('agentsChatInput.foreground')!;
export const agentsChatInputBorder = registeredColorTokens.get('agentsChatInput.border')!;
export const agentsBadgeBackground = registeredColorTokens.get('agentsBadge.background')!;
export const agentsBadgeForeground = registeredColorTokens.get('agentsBadge.foreground')!;
export const activeSessionViewBackground = registeredColorTokens.get('activeSessionView.background')!;
export const inactiveSessionViewBackground = registeredColorTokens.get('inactiveSessionView.background')!;

function registerColorTokens(tokens: Readonly<Record<string, string>>): void {
	for (const [id, value] of Object.entries(tokens)) {
		registeredColorTokens.set(id, registerColor(id, value));
	}
}

/** Exported for the seed-overlay pipeline (#8 P3): a custom seed's derived map must cover the legacy alias ids too, or pre-rename CSS keeps the base theme's colors. */
export function withLegacyAliases(colors: SemanticColorMap): Readonly<Record<SemanticColorTokenId | LegacyColorTokenId, string>> {
	return {
		...colors,
		'agents.background': colors[legacyAliases['agents.background']],
		'agentsPanel.background': colors[legacyAliases['agentsPanel.background']],
		'agentsPanel.foreground': colors[legacyAliases['agentsPanel.foreground']],
		'agentsPanel.border': colors[legacyAliases['agentsPanel.border']],
		'agentsGradient.tintColor': colors[legacyAliases['agentsGradient.tintColor']],
		'agentsChatInput.background': colors[legacyAliases['agentsChatInput.background']],
		'agentsChatInput.foreground': colors[legacyAliases['agentsChatInput.foreground']],
		'agentsChatInput.border': colors[legacyAliases['agentsChatInput.border']],
		'agentsBadge.background': colors[legacyAliases['agentsBadge.background']],
		'agentsBadge.foreground': colors[legacyAliases['agentsBadge.foreground']],
		'activeSessionView.background': colors[legacyAliases['activeSessionView.background']],
		'inactiveSessionView.background': colors[legacyAliases['inactiveSessionView.background']],
	};
}
