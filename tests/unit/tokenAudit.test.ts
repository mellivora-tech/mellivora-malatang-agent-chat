/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import '../../src/sessions/common/theme.js';
import '../../src/sessions/common/sizes.js';
import { getRegisteredTokenIds, getTokenCssVariableName } from '../../src/sessions/platform/theme/theme.js';

/**
 * Design-token enforcement (#8 P0). Three rules over every stylesheet:
 *
 *   1. no raw hex colors — every color routes through a token (or a
 *      color-mix of tokens);
 *   2. every `--vscode-agents-*` variable is REGISTERED — an unregistered
 *      one silently falls back and never follows the theme;
 *   3. no `var(--x, fallback)` on agents variables — the fallback is a
 *      second source of truth that drifts (tokens are always injected).
 */

// Tests execute from dist/ — resolve the SOURCE tree from the package root
// (npm always runs scripts with cwd = repo root).
const sessionsRoot = join(process.cwd(), 'src', 'sessions');

function cssFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...cssFiles(path));
		} else if (entry.name.endsWith('.css')) {
			files.push(path);
		}
	}
	return files;
}

const stylesheets = cssFiles(sessionsRoot).map(path => ({ path: path.slice(sessionsRoot.length + 1), text: readFileSync(path, 'utf8') }));

test('audit corpus is non-empty (the walker actually finds the stylesheets)', () => {
	assert.ok(stylesheets.length >= 10, `only ${stylesheets.length} css files found`);
});

test('no raw hex colors in stylesheets', () => {
	const offenders: string[] = [];
	for (const sheet of stylesheets) {
		sheet.text.split('\n').forEach((line, index) => {
			if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
				offenders.push(`${sheet.path}:${index + 1}: ${line.trim()}`);
			}
		});
	}
	assert.deepEqual(offenders, []);
});

test('every --vscode-agents-* variable used in css is a registered token', () => {
	const registered = new Set(getRegisteredTokenIds().map(getTokenCssVariableName));
	const offenders = new Set<string>();
	for (const sheet of stylesheets) {
		for (const match of sheet.text.matchAll(/--vscode-agents-[a-zA-Z0-9-]+/g)) {
			if (!registered.has(match[0])) {
				offenders.add(`${sheet.path}: ${match[0]}`);
			}
		}
	}
	assert.deepEqual([...offenders], []);
});

test('agents variables carry no fallbacks — tokens are always injected', () => {
	const offenders: string[] = [];
	for (const sheet of stylesheets) {
		sheet.text.split('\n').forEach((line, index) => {
			if (/var\(--vscode-agents-[a-zA-Z0-9-]+\s*,/.test(line)) {
				offenders.push(`${sheet.path}:${index + 1}: ${line.trim()}`);
			}
		});
	}
	assert.deepEqual(offenders, []);
});

test('z-index values route through the z scale — no bare numbers', () => {
	const offenders: string[] = [];
	for (const sheet of stylesheets) {
		sheet.text.split('\n').forEach((line, index) => {
			if (/z-index:\s*-?\d/.test(line)) {
				offenders.push(`${sheet.path}:${index + 1}: ${line.trim()}`);
			}
		});
	}
	assert.deepEqual(offenders, []);
});

test('transition timings route through the motion tokens — no literal durations', () => {
	const offenders: string[] = [];
	for (const sheet of stylesheets) {
		// Whole-declaration scan: multi-line transitions carry the duration on
		// continuation lines, so a line-based check would miss them.
		for (const match of sheet.text.matchAll(/transition[a-z-]*\s*:[^;{}]*/g)) {
			if (/\d+\s*m?s\b/.test(match[0])) {
				offenders.push(`${sheet.path}: ${match[0].replaceAll('\n', ' ').trim()}`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});
