/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IColorToken {
	readonly id: string;
	readonly value: string;
}

export interface ISizeToken {
	readonly id: string;
	readonly value: string;
}

export type ThemeId = 'dark' | 'light' | 'highContrast';

export interface IThemeDefinition {
	readonly id: ThemeId;
	readonly label: string;
	readonly values: Readonly<Record<string, string>>;
}

const colorTokens = new Map<string, IColorToken>();
const sizeTokens = new Map<string, ISizeToken>();
const themes = new Map<string, IThemeDefinition>();
let defaultThemeId: ThemeId = 'dark';

export function registerColor(id: string, value: string): IColorToken {
	const token = { id, value };
	colorTokens.set(id, token);
	return token;
}

export function registerSize(id: string, value: string): ISizeToken {
	const token = { id, value };
	sizeTokens.set(id, token);
	return token;
}

export function registerTheme(theme: IThemeDefinition): IThemeDefinition {
	themes.set(theme.id, theme);
	return theme;
}

export function setDefaultTheme(id: ThemeId): void {
	defaultThemeId = id;
}

export function getTheme(id: string | undefined = defaultThemeId): IThemeDefinition {
	return (
		themes.get(id) ??
		themes.get(defaultThemeId) ?? {
			id: 'dark',
			label: 'Dark',
			values: {},
		}
	);
}

export function resolveThemeTokenValue(id: string, themeId: string | undefined = defaultThemeId): string | undefined {
	const theme = getTheme(themeId);
	const themeValue = theme.values[id];
	if (themeValue !== undefined) {
		return themeValue;
	}

	return colorTokens.get(id)?.value ?? sizeTokens.get(id)?.value;
}

export function getTokenCssVariableName(id: string): string {
	return toCssVariableName(id);
}

export function applyThemeTokens(target: HTMLElement, themeId: string = defaultThemeId): void {
	const theme = getTheme(themeId);
	target.dataset['agentsTheme'] = theme.id;

	for (const token of colorTokens.values()) {
		target.style.setProperty(toCssVariableName(token.id), resolveThemeTokenValue(token.id, theme.id) ?? token.value);
	}

	for (const token of sizeTokens.values()) {
		target.style.setProperty(toCssVariableName(token.id), resolveThemeTokenValue(token.id, theme.id) ?? token.value);
	}
}

function toCssVariableName(id: string): string {
	return `--vscode-${id.replace(/\./g, '-')}`;
}
