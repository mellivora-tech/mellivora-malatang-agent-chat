/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerColor, registerTheme } from '../platform/theme/theme.js';

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
] as const;

type SemanticColorTokenId = (typeof semanticColorTokenIds)[number];
type SemanticColorMap = Record<SemanticColorTokenId, string>;

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

const darkColors: SemanticColorMap = {
	'agents.color.background': '#111111',
	'agents.color.gradient.tint': '#0078d4',
	'agents.color.sidebar.background': '#24343a',
	'agents.color.stage.background': '#1a1a1a',
	'agents.color.stage.border': 'rgba(117, 187, 199, 0.28)',
	'agents.color.watermark': 'rgba(204, 204, 204, 0.11)',
	'agents.color.panel.background': '#252526',
	'agents.color.panel.border': 'rgba(204, 204, 204, 0.15)',
	'agents.color.text.primary': '#cccccc',
	'agents.color.text.secondary': 'rgba(204, 204, 204, 0.72)',
	'agents.color.text.muted': 'rgba(204, 204, 204, 0.58)',
	'agents.color.text.subtle': 'rgba(204, 204, 204, 0.42)',
	'agents.color.text.disabled': 'rgba(204, 204, 204, 0.38)',
	'agents.color.text.inverse': '#ffffff',
	'agents.color.link': '#4fc1ff',
	'agents.color.accent': '#0078d4',
	'agents.color.accent.foreground': '#ffffff',
	'agents.color.avatar.background': '#9b7b72',
	'agents.color.avatar.foreground': '#ffffff',
	'agents.color.focusBorder': '#0078d4',
	'agents.color.badge.background': '#0078d4',
	'agents.color.badge.foreground': '#ffffff',
	'agents.color.input.background': '#1f1f1f',
	'agents.color.input.foreground': '#cccccc',
	'agents.color.input.border': 'rgba(204, 204, 204, 0.18)',
	'agents.color.control.background': 'rgba(204, 204, 204, 0.05)',
	'agents.color.control.border': 'rgba(204, 204, 204, 0.16)',
	'agents.color.control.hoverBackground': 'rgba(204, 204, 204, 0.1)',
	'agents.color.selection.background': 'rgba(0, 120, 212, 0.18)',
	'agents.color.activeSession.background': '#1a1a1a',
	'agents.color.inactiveSession.background': '#1e1e1e',
	'agents.color.success': '#7ee787',
	'agents.color.danger': '#ff7b72',
	'agents.color.warning': '#cca700',
	'agents.color.info': '#4fc1ff',
	'agents.color.scrim': 'rgba(0, 0, 0, 0.36)',
	'agents.color.shadow': 'rgba(0, 0, 0, 0.48)',
	'agents.color.scrollbar.thumb': 'rgba(204, 204, 204, 0.28)',
	'agents.color.scrollbar.thumbHover': 'rgba(204, 204, 204, 0.42)',
	'agents.color.divider': 'rgba(204, 204, 204, 0.1)',
	'agents.color.modal.background': '#202020',
};

const lightColors: SemanticColorMap = {
	'agents.color.background': '#f6f8fa',
	'agents.color.gradient.tint': '#0969da',
	'agents.color.sidebar.background': '#edf4f7',
	'agents.color.stage.background': '#ffffff',
	'agents.color.stage.border': 'rgba(31, 35, 40, 0.18)',
	'agents.color.watermark': 'rgba(31, 35, 40, 0.09)',
	'agents.color.panel.background': '#ffffff',
	'agents.color.panel.border': 'rgba(31, 35, 40, 0.15)',
	'agents.color.text.primary': '#1f2328',
	'agents.color.text.secondary': 'rgba(31, 35, 40, 0.72)',
	'agents.color.text.muted': 'rgba(31, 35, 40, 0.58)',
	'agents.color.text.subtle': 'rgba(31, 35, 40, 0.42)',
	'agents.color.text.disabled': 'rgba(31, 35, 40, 0.38)',
	'agents.color.text.inverse': '#ffffff',
	'agents.color.link': '#0969da',
	'agents.color.accent': '#0969da',
	'agents.color.accent.foreground': '#ffffff',
	'agents.color.avatar.background': '#9b7b72',
	'agents.color.avatar.foreground': '#ffffff',
	'agents.color.focusBorder': '#0969da',
	'agents.color.badge.background': '#0969da',
	'agents.color.badge.foreground': '#ffffff',
	'agents.color.input.background': '#ffffff',
	'agents.color.input.foreground': '#1f2328',
	'agents.color.input.border': 'rgba(31, 35, 40, 0.18)',
	'agents.color.control.background': 'rgba(31, 35, 40, 0.05)',
	'agents.color.control.border': 'rgba(31, 35, 40, 0.16)',
	'agents.color.control.hoverBackground': 'rgba(31, 35, 40, 0.08)',
	'agents.color.selection.background': 'rgba(9, 105, 218, 0.14)',
	'agents.color.activeSession.background': '#ffffff',
	'agents.color.inactiveSession.background': '#f6f8fa',
	'agents.color.success': '#1a7f37',
	'agents.color.danger': '#cf222e',
	'agents.color.warning': '#9a6700',
	'agents.color.info': '#0969da',
	'agents.color.scrim': 'rgba(31, 35, 40, 0.28)',
	'agents.color.shadow': 'rgba(31, 35, 40, 0.18)',
	'agents.color.scrollbar.thumb': 'rgba(31, 35, 40, 0.28)',
	'agents.color.scrollbar.thumbHover': 'rgba(31, 35, 40, 0.42)',
	'agents.color.divider': 'rgba(31, 35, 40, 0.1)',
	'agents.color.modal.background': '#ffffff',
};

const highContrastColors: SemanticColorMap = {
	'agents.color.background': '#000000',
	'agents.color.gradient.tint': '#f38518',
	'agents.color.sidebar.background': '#000000',
	'agents.color.stage.background': '#000000',
	'agents.color.stage.border': '#6fc3df',
	'agents.color.watermark': '#6fc3df',
	'agents.color.panel.background': '#000000',
	'agents.color.panel.border': '#6fc3df',
	'agents.color.text.primary': '#ffffff',
	'agents.color.text.secondary': '#ffffff',
	'agents.color.text.muted': '#d6d6d6',
	'agents.color.text.subtle': '#bdbdbd',
	'agents.color.text.disabled': '#8a8a8a',
	'agents.color.text.inverse': '#000000',
	'agents.color.link': '#75beff',
	'agents.color.accent': '#f38518',
	'agents.color.accent.foreground': '#000000',
	'agents.color.avatar.background': '#f38518',
	'agents.color.avatar.foreground': '#000000',
	'agents.color.focusBorder': '#f38518',
	'agents.color.badge.background': '#f38518',
	'agents.color.badge.foreground': '#000000',
	'agents.color.input.background': '#000000',
	'agents.color.input.foreground': '#ffffff',
	'agents.color.input.border': '#6fc3df',
	'agents.color.control.background': '#000000',
	'agents.color.control.border': '#6fc3df',
	'agents.color.control.hoverBackground': 'rgba(243, 133, 24, 0.24)',
	'agents.color.selection.background': 'rgba(243, 133, 24, 0.32)',
	'agents.color.activeSession.background': '#000000',
	'agents.color.inactiveSession.background': '#000000',
	'agents.color.success': '#00ff00',
	'agents.color.danger': '#ff0000',
	'agents.color.warning': '#ffff00',
	'agents.color.info': '#75beff',
	'agents.color.scrim': 'rgba(0, 0, 0, 0.72)',
	'agents.color.shadow': 'rgba(0, 0, 0, 0.72)',
	'agents.color.scrollbar.thumb': '#6fc3df',
	'agents.color.scrollbar.thumbHover': '#f38518',
	'agents.color.divider': '#6fc3df',
	'agents.color.modal.background': '#000000',
};

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

function withLegacyAliases(colors: SemanticColorMap): Readonly<Record<SemanticColorTokenId | LegacyColorTokenId, string>> {
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
