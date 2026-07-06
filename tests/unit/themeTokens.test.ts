import test from 'node:test';
import assert from 'node:assert/strict';

import '../../src/sessions/common/theme.js';
import '../../src/sessions/common/sizes.js';
import { applyThemeTokens, getTheme, getTokenCssVariableName, resolveThemeTokenValue } from '../../src/sessions/platform/theme/theme.js';

class StyleStub {
	readonly values = new Map<string, string>();

	setProperty(name: string, value: string): void {
		this.values.set(name, value);
	}
}

class ElementStub {
	readonly style = new StyleStub();
	readonly dataset: Record<string, string> = {};
}

test('registered themes resolve semantic color tokens', () => {
	assert.equal(resolveThemeTokenValue('agents.color.text.primary', 'dark'), '#cccccc');
	assert.equal(resolveThemeTokenValue('agents.color.text.primary', 'light'), '#1f2328');
	assert.equal(resolveThemeTokenValue('agents.color.focusBorder', 'highContrast'), '#f38518');
});

test('legacy color tokens remain aliases for compatibility', () => {
	assert.equal(resolveThemeTokenValue('agentsPanel.foreground', 'dark'), '#cccccc');
	assert.equal(resolveThemeTokenValue('agentsBadge.background', 'light'), '#0969da');
});

test('applyThemeTokens writes semantic css variables for a selected theme', () => {
	const target = new ElementStub();

	applyThemeTokens(target as unknown as HTMLElement, 'light');

	assert.equal(target.dataset['agentsTheme'], 'light');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.color.panel.background')), '#ffffff');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.color.sidebar.background')), '#edf4f7');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.color.stage.background')), '#ffffff');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.color.avatar.background')), '#9b7b72');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.titlebar.height')), '52px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.sidebar.width')), '270px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.sidebar.header')), '172px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.sidebar.gutter')), '14px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.sidebar.listTitleOffset')), '48px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.conversation.width')), '950px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.composer.width')), '640px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.composer.contextHeight')), '28px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.composer.inputHeight')), '106px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.composer.toolbarHeight')), '42px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.space.composer.contextGap')), '6px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.size.watermark.width')), '390px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.radius.control')), '5px');
	assert.equal(target.style.values.get(getTokenCssVariableName('agents.radius.stage')), '10px');
});

test('unknown theme falls back to dark', () => {
	assert.equal(getTheme('missing').id, 'dark');
});
