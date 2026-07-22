/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
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

// The exact surfaces swept in #9 P0 (+ the P1 renderer sweep) — bare Chinese
// literals here are regressions.
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
	// --- #9 P1 sweep ---
	'src/sessions/browser/parts/projectConfigView.ts',
	'src/sessions/contrib/fileProvider/browser/fileSessionsProvider.ts',
	'src/sessions/services/sessions/common/planArtifact.ts',
	'src/sessions/browser/parts/agentUi/components/workRender.ts',
	'src/sessions/services/sessions/common/session.ts',
	'src/sessions/browser/parts/quotaIndicator.ts',
	// --- #13 P1 ---
	'src/sessions/browser/parts/artifactsView.ts',
	'src/sessions/services/environments/common/environments.ts',
	'src/sessions/contrib/data/common/dataProvider.ts',
	'src/sessions/browser/workbench.ts',
	// --- 运行日志 (observability) ---
	'src/sessions/browser/parts/runLogView.ts',
	'src/sessions/browser/parts/runLogTimeline.ts',
];

// Universal terms that are not translatable content (SQL NULL, a keycap glyph)
// — matched whole-string so they can't mask a real violation on the same line.
// '结束' is SUBAGENT_END_ARG_PREFIX (session.ts): a PERSISTED step-fact marker
// shared by writer and reader — locale-independent by necessity, never
// localized. '中文（简体）' is a language endonym: language names are shown in
// their own language by convention, not translated.
// '完整梳理文档' is DOCUMENT_SPLIT_MARKER_PREFIX (session.ts): the split
// answer's persisted transcript marker — locale-independent like '结束'.
const ALLOWED_BARE_STRINGS = new Set(["'NULL'", "'Esc'", "'C'", "'Chao Wang'", "'结束'", "'中文（简体）'", "'完整梳理文档'"]);

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

test('main-process [i18n:key] markers all resolve to catalog keys (#9 P1b)', () => {
	// Main cannot localize (the locale preference lives in renderer storage),
	// so it names causes as `[i18n:key|arg]` markers that display sites
	// resolve via localizeIpcMarker. A typo'd key would silently fall through
	// to the raw marker text — this scan is what makes that impossible.
	const grep = execSync("grep -rhoE '\\[i18n:[A-Za-z0-9_.]+' src/main --include='*.ts' || true", { cwd: repoRoot, encoding: 'utf8' });
	const keys = [...new Set(grep.split('\n').filter(Boolean).map(line => line.replace('[i18n:', '')))];
	assert.ok(keys.length >= 12, `expected the known marker set, found ${keys.length}`);
	const unknown = keys.filter(key => zhCN[key as MessageKey] === undefined);
	assert.deepEqual(unknown, []);
});
