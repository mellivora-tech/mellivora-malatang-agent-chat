/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkRenderItems, presentStep, stepError, stepTool, TOOL_VERB_KEYS } from '../../src/sessions/browser/parts/agentUi/components/workRender.js';
import type { ISessionWorkStep } from '../../src/sessions/services/sessions/common/session.js';

function tool(name: string, arg: string | undefined, extra: Partial<ISessionWorkStep> = {}): ISessionWorkStep {
	return {
		kind: 'tool',
		label: arg === undefined ? name : `${name} ${arg}`,
		durationMs: 100,
		tool: name,
		...(arg === undefined ? {} : { arg }),
		outcome: 'ok',
		...extra,
	} as ISessionWorkStep;
}

const narration: ISessionWorkStep = { kind: 'narration', label: '先看下代码。', durationMs: 0 };
const thinking: ISessionWorkStep = { kind: 'thinking', label: 'Thought', durationMs: 2000 };

test('consecutive reads fold into one rollup with class-bucketed counts', () => {
	const items = buildWorkRenderItems([
		tool('read_file', 'src/a.ts'),
		tool('read_file', 'src/b.ts'),
		tool('list_dir', 'src/'),
		tool('grep', 'deduct'),
		tool('glob', '**/*.ts'),
	]);
	assert.equal(items.length, 1);
	const rollup = items[0]!;
	assert.equal(rollup.kind, 'rollup');
	if (rollup.kind === 'rollup') {
		assert.equal(rollup.files, 2);
		assert.equal(rollup.dirs, 1);
		assert.equal(rollup.searches, 2);
		assert.equal(rollup.durationMs, 500);
		assert.equal(rollup.running, false);
	}
});

test('repeated reads of the same file dedupe; searches count occurrences', () => {
	const items = buildWorkRenderItems([tool('read_file', 'src/a.ts'), tool('read_file', 'src/a.ts'), tool('grep', 'x'), tool('grep', 'x')]);
	const rollup = items[0]!;
	assert.equal(rollup.kind, 'rollup');
	if (rollup.kind === 'rollup') {
		assert.equal(rollup.files, 1);
		assert.equal(rollup.searches, 2);
	}
});

test('a lone read stays a plain step — no single-member rollup', () => {
	const items = buildWorkRenderItems([tool('read_file', 'src/a.ts'), tool('edit_file', 'src/a.ts')]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step', 'step']
	);
});

test('writes, narration, and thinking all break a read run', () => {
	const items = buildWorkRenderItems([
		tool('read_file', 'a'),
		tool('read_file', 'b'),
		tool('edit_file', 'a'),
		tool('read_file', 'c'),
		narration,
		tool('read_file', 'd'),
		tool('read_file', 'e'),
		thinking,
	]);
	assert.deepEqual(
		items.map(item => item.kind),
		['rollup', 'step', 'step', 'step', 'rollup', 'step']
	);
});

test('an errored read breaks out of the rollup and renders standalone', () => {
	const items = buildWorkRenderItems([tool('read_file', 'a'), tool('read_file', 'missing.ts', { outcome: 'error' }), tool('read_file', 'b'), tool('read_file', 'c')]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step', 'step', 'rollup']
	);
	assert.equal(stepError((items[1] as { step: ISessionWorkStep }).step), true);
});

test('the running open step joins a live rollup and flags it running', () => {
	// The synthetic open step has no outcome yet — modeled directly, not via the closed-step helper.
	const openStep: ISessionWorkStep = { kind: 'tool', label: 'read_file c', durationMs: 50, running: true, tool: 'read_file', arg: 'c' };
	const items = buildWorkRenderItems([tool('read_file', 'a'), tool('read_file', 'b'), openStep]);
	const rollup = items[0]!;
	assert.equal(rollup.kind, 'rollup');
	if (rollup.kind === 'rollup') {
		assert.equal(rollup.running, true);
		assert.equal(rollup.files, 3);
	}
});

test('legacy steps (no structured facts) recover tool/arg from the label and still roll up', () => {
	const legacy: ISessionWorkStep[] = [
		{ kind: 'tool', label: 'read_file src/a.ts', durationMs: 80 },
		{ kind: 'tool', label: 'list_dir src/', durationMs: 40 },
		{ kind: 'tool', label: 'grep deduct', durationMs: 60 },
	];
	assert.equal(stepTool(legacy[0]!), 'read_file');
	const items = buildWorkRenderItems(legacy);
	assert.equal(items[0]!.kind, 'rollup');
	const presentation = presentStep(legacy[0]!);
	assert.equal(presentation.verbKey, TOOL_VERB_KEYS['read_file']);
	assert.equal(presentation.chip, 'src/a.ts');
});

test('legacy error detection falls back to the [error] detail marker', () => {
	const legacy: ISessionWorkStep = { kind: 'tool', label: 'bash pnpm test', durationMs: 900, detail: '[error]\nexit 1' };
	assert.equal(stepError(legacy), true);
	// And it must not be folded away where a user would miss the failure.
	const items = buildWorkRenderItems([{ kind: 'tool', label: 'read_file a', durationMs: 10 }, legacy, { kind: 'tool', label: 'read_file b', durationMs: 10 }]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step', 'step', 'step']
	);
});

test('unknown tools and progress-overwritten labels render as legacy label rows', () => {
	const unknown: ISessionWorkStep = { kind: 'tool', label: '上传 backup.tar 47% · 4.1 MB/s', durationMs: 5000 };
	assert.equal(stepTool(unknown), undefined);
	assert.equal(presentStep(unknown).verbKey, undefined);
	const items = buildWorkRenderItems([unknown]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step']
	);
});

test('replayability: rendering is a pure function of persisted facts — same input, same items', () => {
	const steps: ISessionWorkStep[] = [
		narration,
		tool('read_file', 'a'),
		tool('read_file', 'b'),
		tool('query_data_source', 'SELECT 1', { outcome: 'ok' }),
		tool('bash', 'pnpm test', { outcome: 'error' }),
	];
	const first = buildWorkRenderItems(steps);
	const second = buildWorkRenderItems(steps.map(step => ({ ...step })));
	assert.deepEqual(second, first);
	// The run's live-only flag is the ONLY field allowed to differ between live
	// and replay — completed persisted steps never carry it.
	assert.ok(steps.every(step => step.running === undefined));
});

test('presentation derives verb + chip for structured steps and flags errors', () => {
	const failed = tool('bash', 'pnpm typecheck', { outcome: 'error' });
	const presentation = presentStep(failed);
	assert.equal(presentation.verbKey, TOOL_VERB_KEYS['bash']);
	assert.equal(presentation.chip, 'pnpm typecheck');
	assert.equal(presentation.error, true);
});
