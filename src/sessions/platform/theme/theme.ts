/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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

const colorTokens = new Map<string, IColorToken>();
const sizeTokens = new Map<string, ISizeToken>();

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

export function applyThemeTokens(target: HTMLElement): void {
	for (const token of colorTokens.values()) {
		target.style.setProperty(toCssVariableName(token.id), token.value);
	}

	for (const token of sizeTokens.values()) {
		target.style.setProperty(toCssVariableName(token.id), token.value);
	}
}

function toCssVariableName(id: string): string {
	return `--vscode-${id.replace(/\./g, '-')}`;
}
