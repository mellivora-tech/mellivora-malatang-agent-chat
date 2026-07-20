/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCountdown, formatResetTime, quotaSeverityColor } from '../../src/sessions/browser/parts/quotaIndicator.js';

test('quotaSeverityColor: silent below 70%, then a linear warning→danger ramp (#19 requirement 2)', () => {
	assert.equal(quotaSeverityColor(0), undefined);
	assert.equal(quotaSeverityColor(69), undefined);
	// Threshold entry is pure warning; the danger share grows linearly to 100%.
	assert.equal(quotaSeverityColor(70), 'color-mix(in srgb, var(--vscode-agents-color-danger) 0%, var(--vscode-agents-color-warning))');
	assert.equal(quotaSeverityColor(85), 'color-mix(in srgb, var(--vscode-agents-color-danger) 50%, var(--vscode-agents-color-warning))');
	assert.equal(quotaSeverityColor(100), 'color-mix(in srgb, var(--vscode-agents-color-danger) 100%, var(--vscode-agents-color-warning))');
	// Over-100 readings clamp instead of producing an out-of-range mix.
	assert.equal(quotaSeverityColor(140), 'color-mix(in srgb, var(--vscode-agents-color-danger) 100%, var(--vscode-agents-color-warning))');
	assert.equal(quotaSeverityColor(Number.NaN), undefined);
});

test('formatResetTime: ISO → local MM-DD HH:mm; garbage → undefined', () => {
	const formatted = formatResetTime('2026-07-23T02:55:18.368151Z');
	assert.ok(formatted);
	assert.match(formatted, /^\d{2}-\d{2} \d{2}:\d{2}$/);
	assert.equal(formatResetTime('not-a-date'), undefined);
	assert.equal(formatResetTime(undefined), undefined);
});

test('formatCountdown: d/h/m compaction by horizon; past or garbage → undefined', () => {
	const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
	assert.equal(formatCountdown(at(3 * 86400_000 + 5 * 3600_000)), '3d5h');
	assert.equal(formatCountdown(at(3 * 3600_000 + 34 * 60_000)), '3h34m');
	assert.equal(formatCountdown(at(34 * 60_000)), '34m');
	assert.equal(formatCountdown(at(-60_000)), undefined);
	assert.equal(formatCountdown('not-a-date'), undefined);
	assert.equal(formatCountdown(undefined), undefined);
});
