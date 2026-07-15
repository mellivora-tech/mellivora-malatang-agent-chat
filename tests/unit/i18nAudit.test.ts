/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { enUS } from '../../src/sessions/common/i18n/messages.enUS.js';
import { zhCN, type MessageKey } from '../../src/sessions/common/i18n/messages.zhCN.js';

/**
 * i18n enforcement (#9 P0), mirroring tokenAudit.test.ts's "audit as a unit
 * test" pattern. Two rules:
 *
 *   1. the swept high-frequency UI surfaces carry no bare Chinese string
 *      literals — every user-visible string routes through localize();
 *   2. the en-US catalog translates every zh-CN source key (a missing
 *      translation silently falls back to zh-CN in production — this test
 *      is what stops that from happening by accident).
 *
 * Files NOT in the whitelist are out of #9 P0 scope on purpose: main-process
 * strings (P1), and newSessionGreetings.ts (satirical flavor copy — a
 * creative-translation task, not a mechanical string swap; see the comment
 * at the top of that file for the full reasoning).
 */

const repoRoot = process.cwd();

// The exact surfaces swept in #9 P0 — bare Chinese literals here are regressions.
const SWEPT_FILES: readonly string[] = [
	'src/sessions/browser/parts/conversationView.ts',
	'src/sessions/browser/parts/auxiliaryBarPart.ts',
	'src/sessions/browser/parts/newSessionView.ts',
	'src/sessions/browser/parts/conversationContext.ts',
	'src/sessions/browser/parts/modelPicker.ts',
	'src/sessions/services/agent/browser/permissionModeService.ts',
	'src/sessions/contrib/sessions/browser/sessionsList.ts',
	'src/sessions/contrib/data/browser/dataBrowserView.ts',
	'src/sessions/contrib/data/browser/sqlDataProvider.ts',
	'src/sessions/contrib/data/browser/fileDataProvider.ts',
];

// Universal terms that are not translatable content (SQL NULL, a keycap glyph)
// — matched whole-string so they can't mask a real violation on the same line.
const ALLOWED_BARE_STRINGS = new Set(["'NULL'", "'Esc'", "'C'", "'Chao Wang'"]);

test('audit corpus resolves (the swept file list still exists)', () => {
	for (const relative of SWEPT_FILES) {
		assert.doesNotThrow(() => readFileSync(join(repoRoot, relative), 'utf8'), relative);
	}
});

test('swept UI surfaces carry no bare Chinese string literals', () => {
	const offenders: string[] = [];
	for (const relative of SWEPT_FILES) {
		const text = readFileSync(join(repoRoot, relative), 'utf8');
		text.split('\n').forEach((line, index) => {
			const code = line.trim();
			// Comments may legitimately quote Chinese UI copy for context — only
			// CODE lines (not // or /** */ prose) are runtime string literals.
			if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/**')) {
				return;
			}
			const matches = line.match(/'[^']*[一-龥][^']*'|"[^"]*[一-龥][^"]*"|`[^`]*[一-龥][^`]*`/g);
			if (!matches) {
				return;
			}
			for (const match of matches) {
				if (!ALLOWED_BARE_STRINGS.has(match)) {
					offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
					break;
				}
			}
		});
	}
	assert.deepEqual(offenders, []);
});

test('en-US catalog translates every zh-CN source key', () => {
	const sourceKeys = Object.keys(zhCN) as MessageKey[];
	const missing = sourceKeys.filter(key => enUS[key] === undefined || enUS[key] === '');
	assert.deepEqual(missing, []);
});

test('en-US catalog has no orphan keys beyond the source', () => {
	const sourceKeys = new Set(Object.keys(zhCN));
	const orphans = Object.keys(enUS).filter(key => !sourceKeys.has(key));
	assert.deepEqual(orphans, []);
});
