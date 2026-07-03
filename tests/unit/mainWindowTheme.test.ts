import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getInitialWindowBackgroundColor,
	initialWindowThemeId
} from '../../src/main/windowTheme.js';

test('main window initial background color comes from the default theme', () => {
	assert.equal(initialWindowThemeId, 'dark');
	assert.equal(getInitialWindowBackgroundColor(), '#111111');
});

test('main window background color can be resolved for another registered theme', () => {
	assert.equal(getInitialWindowBackgroundColor('light'), '#f6f8fa');
});
