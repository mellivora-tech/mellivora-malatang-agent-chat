/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { codingQuotaUrl, isQuotaExhaustedError, parseCodingQuotaPayload, supportsCodingQuota } from '../../src/main/codingQuota.js';

test('parseCodingQuotaPayload: the real Kimi /usages shape — string numbers, weekly usage + 5h window', () => {
	// Verbatim shape from a live probe (2026-07-20), values anonymized.
	const parsed = parseCodingQuotaPayload({
		user: { userId: 'u', membership: { level: 'LEVEL_INTERMEDIATE' } },
		usage: { limit: '100', used: '26', remaining: '74', resetTime: '2026-07-23T02:55:18.368151Z' },
		limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-07-20T04:55:18.368151Z' } }],
		parallel: { limit: '20' },
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.usage, { used: 26, limit: 100, remaining: 74, resetTime: '2026-07-23T02:55:18.368151Z' });
	assert.equal(parsed.windows.length, 1);
	// The window omits `used` — derived from limit − remaining; duration normalizes to minutes.
	assert.deepEqual(parsed.windows[0], { used: 0, limit: 100, remaining: 100, resetTime: '2026-07-20T04:55:18.368151Z', durationMinutes: 300 });
});

test('parseCodingQuotaPayload: unusable shapes yield undefined, malformed windows are dropped', () => {
	assert.equal(parseCodingQuotaPayload(undefined), undefined);
	assert.equal(parseCodingQuotaPayload('nope'), undefined);
	assert.equal(parseCodingQuotaPayload({}), undefined);
	assert.equal(parseCodingQuotaPayload({ usage: { limit: 'NaN?' } }), undefined);
	const partial = parseCodingQuotaPayload({
		usage: { limit: 100, used: 3 },
		limits: [{ window: {}, detail: { limit: 'x' } }, 'garbage'],
	});
	assert.ok(partial);
	assert.deepEqual(partial.usage, { used: 3, limit: 100, remaining: 97 });
	assert.equal(partial.windows.length, 0);
});

test('codingQuotaUrl mirrors the /v1/messages join for both baseURL styles', () => {
	assert.equal(codingQuotaUrl('https://api.kimi.com/coding/'), 'https://api.kimi.com/coding/v1/usages');
	assert.equal(codingQuotaUrl('https://api.kimi.com/coding/v1'), 'https://api.kimi.com/coding/v1/usages');
});

test('supportsCodingQuota: preset id or the known URL; other providers stay out', () => {
	assert.ok(supportsCodingQuota({ presetId: 'kimi-code', baseURL: 'https://custom.example/' }));
	assert.ok(supportsCodingQuota({ baseURL: 'https://api.kimi.com/coding/' }));
	assert.ok(!supportsCodingQuota({ presetId: 'openai', baseURL: 'https://api.openai.com/v1' }));
});

test('isQuotaExhaustedError: 403 transport failures only', () => {
	assert.ok(isQuotaExhaustedError(new Error('Anthropic request failed: 403 {"error":{"type":"permission_error"}}')));
	assert.ok(!isQuotaExhaustedError(new Error('Anthropic request failed: 429 slow down')));
	assert.ok(!isQuotaExhaustedError(new Error('fetch failed')));
});
