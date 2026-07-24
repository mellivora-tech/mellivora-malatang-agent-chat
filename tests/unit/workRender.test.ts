/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkRenderItems, buildWorkSections, presentStep, stepError, stepTool, TOOL_VERB_KEYS } from '../../src/sessions/browser/parts/agentUi/components/workRender.js';
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

const thinking: ISessionWorkStep = { kind: 'thinking', label: 'Thought', durationMs: 2000 };

test('consecutive reads fold into one rollup with class-bucketed counts', () => {
	const items = buildWorkRenderItems([tool('read_file', 'src/a.ts'), tool('read_file', 'src/b.ts'), tool('list_dir', 'src/'), tool('grep', 'deduct'), tool('glob', '**/*.ts')]);
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
		['step', 'step'],
	);
});

test('writes break a read run; thinking does NOT (2a) — it re-emits after the fold', () => {
	const items = buildWorkRenderItems([tool('read_file', 'a'), tool('read_file', 'b'), thinking, tool('read_file', 'c'), tool('edit_file', 'a'), tool('read_file', 'd')]);
	// a+b+c fold as ONE rollup despite the thinking between b and c; the
	// thinking row lands right after the fold; the edit still breaks.
	assert.deepEqual(
		items.map(item => (item.kind === 'rollup' ? `rollup:${item.steps.length}` : ((item as { step: ISessionWorkStep }).step?.kind ?? item.kind))),
		['rollup:3', 'thinking', 'tool', 'tool'],
	);
});

test('an errored read breaks out of the rollup and renders standalone', () => {
	const items = buildWorkRenderItems([tool('read_file', 'a'), tool('read_file', 'missing.ts', { outcome: 'error' }), tool('read_file', 'b'), tool('read_file', 'c')]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step', 'step', 'rollup'],
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
		['step', 'step', 'step'],
	);
});

test('unknown tools and progress-overwritten labels render as legacy label rows', () => {
	const unknown: ISessionWorkStep = { kind: 'tool', label: '上传 backup.tar 47% · 4.1 MB/s', durationMs: 5000 };
	assert.equal(stepTool(unknown), undefined);
	assert.equal(presentStep(unknown).verbKey, undefined);
	const items = buildWorkRenderItems([unknown]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step'],
	);
});

test('replayability: rendering is a pure function of persisted facts — same input, same items', () => {
	const steps: ISessionWorkStep[] = [
		thinking,
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

test('child-loop read sweeps fold into rollups; spawn and end steps break the group', () => {
	const child = (name: string, arg: string): ISessionWorkStep => ({ kind: 'tool', label: `⑃ ${name} ${arg}`, durationMs: 50, tool: name, arg, via: 'subagent' });
	const items = buildWorkRenderItems([
		{ kind: 'tool', label: '子代理 ⑃ 梳理 src', durationMs: 10, tool: 'spawn_agent', arg: '梳理 src' },
		child('read_file', 'a.ts'),
		child('read_file', 'b.ts'),
		child('list_dir', 'src/'),
		{ kind: 'tool', label: '⑃ bash pnpm test', durationMs: 900, tool: 'bash', arg: 'pnpm test', via: 'subagent' },
		child('read_file', 'c.ts'),
		child('grep', 'foo'),
		{ kind: 'tool', label: '子代理结束 · done', durationMs: 5, tool: 'subagent', outcome: 'ok' },
	]);
	assert.deepEqual(
		items.map(item => item.kind),
		['step', 'rollup', 'step', 'rollup', 'step'],
	);
	const presentation = presentStep(child('read_file', 'a.ts'));
	assert.equal(presentation.sub, true);
	assert.equal(presentation.verbKey, TOOL_VERB_KEYS['read_file']);
});

test('parallel children never fold into one rollup — groups break on agent change (#15)', () => {
	const child = (agent: string, arg: string): ISessionWorkStep => ({ kind: 'tool', label: `⑃ read_file ${arg}`, durationMs: 50, tool: 'read_file', arg, via: 'subagent', agent });
	const items = buildWorkRenderItems([
		child('a1', 'x.ts'),
		child('a1', 'y.ts'),
		child('a2', 'p.ts'),
		child('a2', 'q.ts'),
		child('a1', 'z.ts'),
		{ kind: 'tool', label: 'read_file main.ts', durationMs: 10, tool: 'read_file', arg: 'main.ts' },
		{ kind: 'tool', label: 'read_file other.ts', durationMs: 10, tool: 'read_file', arg: 'other.ts' },
	]);
	// a1 run, a2 run, lone a1 step, then the main loop's own pair — no cross-agent merges.
	assert.deepEqual(
		items.map(item => (item.kind === 'rollup' ? `rollup:${item.steps.length}` : 'step')),
		['rollup:2', 'rollup:2', 'step', 'rollup:2'],
	);
});

test('sections: with no narration concept, the whole work block is one untitled section', () => {
	const sections = buildWorkSections([thinking, tool('read_file', 'a.ts'), tool('read_file', 'b.ts'), tool('read_file', 'c.ts'), tool('edit_file', 'b.ts')]);
	assert.equal(sections.length, 1);
	assert.deepEqual(
		sections[0]!.items.map(item => item.kind),
		['step', 'rollup', 'step'],
	);
	// The three reads folded into one rollup.
	assert.equal((sections[0]!.items[1] as { steps: readonly unknown[] }).steps.length, 3);
});

test('agent groups de-interleave parallel children: one group per agent, anchored at first appearance, sweeps fold whole again', () => {
	const child = (agent: string, arg: string): ISessionWorkStep => ({ kind: 'tool', label: `⑃ read_file ${arg}`, durationMs: 50, tool: 'read_file', arg, via: 'subagent', agent });
	const sections = buildWorkSections([
		{ kind: 'tool', label: '子代理 ⑃ 探索主进程', durationMs: 10, tool: 'spawn_agent', arg: '探索主进程', agent: 'a1' },
		{ kind: 'tool', label: '子代理 ⑃ 探索渲染端', durationMs: 10, tool: 'spawn_agent', arg: '探索渲染端', agent: 'a2' },
		child('a1', 'x.ts'),
		child('a2', 'p.ts'),
		child('a1', 'y.ts'),
		child('a2', 'q.ts'),
		child('a1', 'z.ts'),
		{ kind: 'tool', label: '子代理结束 · done', durationMs: 5, tool: 'subagent', arg: '结束 · done', outcome: 'ok', agent: 'a1', detail: '12 turns · 47 tool calls' },
		{ kind: 'tool', label: 'spawn_agent 探索主进程', durationMs: 208_000, tool: 'spawn_agent', arg: '探索主进程', outcome: 'ok', agent: 'a1' },
		{ kind: 'tool', label: '子代理结束 · done', durationMs: 5, tool: 'subagent', arg: '结束 · done', outcome: 'ok', agent: 'a2' },
		{ kind: 'tool', label: 'spawn_agent 探索渲染端', durationMs: 283_000, tool: 'spawn_agent', arg: '探索渲染端', outcome: 'ok', agent: 'a2' },
	]);
	assert.equal(sections.length, 1);
	const groups = sections[0]!.items.filter(item => item.kind === 'agentGroup');
	assert.equal(groups.length, 2);
	const [g1, g2] = groups as [Extract<(typeof groups)[0], { kind: 'agentGroup' }>, Extract<(typeof groups)[0], { kind: 'agentGroup' }>];
	// Two siblings → ordinal labels; the 2-char shared prefix ('探索') is semantic and stays.
	assert.equal(g1.label, '子代理 1 · 探索主进程');
	assert.equal(g1.fullLabel, '探索主进程');
	assert.equal(g1.durationMs, 208_000);
	assert.equal(g1.endDetail, '12 turns · 47 tool calls');
	// De-interleaved: a1's three reads fold into ONE rollup despite a2 interleaving.
	assert.deepEqual(
		g1.items.map(item => item.kind),
		['rollup'],
	);
	assert.equal(g2.durationMs, 283_000);
	assert.equal(g1.running, false);
});

test('a running spawn synthetic keeps its group live; a failed spawn marks the group error', () => {
	const sections = buildWorkSections([
		{ kind: 'tool', label: '子代理 ⑃ 巡查', durationMs: 10, tool: 'spawn_agent', arg: '巡查', agent: 'a1' },
		{ kind: 'tool', label: '⑃ read_file a.ts', durationMs: 30_000, tool: 'read_file', arg: 'a.ts', via: 'subagent', agent: 'a1' },
		{ kind: 'tool', label: '⑃ grep foo', durationMs: 4000, running: true, tool: 'grep', arg: 'foo', via: 'subagent', agent: 'a1' } as ISessionWorkStep,
		{ kind: 'tool', label: '子代理 ⑃ 失败的', durationMs: 10, tool: 'spawn_agent', arg: '失败的', agent: 'a2' },
		{ kind: 'tool', label: 'spawn_agent 失败的', durationMs: 9000, tool: 'spawn_agent', arg: '失败的', outcome: 'error', agent: 'a2' },
	]);
	const groups = sections[0]!.items.filter(item => item.kind === 'agentGroup') as Extract<(typeof sections)[0]['items'][0], { kind: 'agentGroup' }>[];
	assert.equal(groups[0]!.running, true);
	assert.equal(groups[1]!.error, true);
});

test('sections and groups are pure functions of the steps — replay equals live', () => {
	const steps: ISessionWorkStep[] = [
		thinking,
		tool('read_file', 'a'),
		{ kind: 'tool', label: '子代理 ⑃ t', durationMs: 5, tool: 'spawn_agent', arg: 't', agent: 'x' },
		{ kind: 'tool', label: '⑃ list_dir d/', durationMs: 40, tool: 'list_dir', arg: 'd/', via: 'subagent', agent: 'x' },
	];
	assert.deepEqual(buildWorkSections(steps.map(step => ({ ...step }))), buildWorkSections(steps));
});

test('presentation derives verb + chip for structured steps and flags errors', () => {
	const failed = tool('bash', 'pnpm typecheck', { outcome: 'error' });
	const presentation = presentStep(failed);
	assert.equal(presentation.verbKey, TOOL_VERB_KEYS['bash']);
	assert.equal(presentation.chip, 'pnpm typecheck');
	assert.equal(presentation.error, true);
});

test('sibling agent groups with a shared task prefix get ordinal short labels; the full task moves to fullLabel (#12 polish)', async () => {
	const { buildWorkSections } = await import('../../src/sessions/browser/parts/agentUi/components/workRender.js');
	const task = (suffix: string): string => `你在梳理一个 Java 17 / Spring Boot 3 多模块 Maven 后端项目,负责${suffix}`;
	const steps = [
		{ kind: 'tool', label: 'x', durationMs: 1, tool: 'spawn_agent', arg: task('system 模块'), agent: 'a1' },
		{ kind: 'tool', label: 'x', durationMs: 1, tool: 'spawn_agent', arg: task('monitor 模块'), agent: 'a2' },
		{ kind: 'tool', label: 'read_file pom.xml', durationMs: 1, tool: 'read_file', arg: 'pom.xml', via: 'subagent', agent: 'a1' },
	] as never[];
	const sections = buildWorkSections(steps);
	const groups = sections[0]!.items.filter(item => item.kind === 'agentGroup') as { label: string; fullLabel?: string }[];
	assert.equal(groups.length, 2);
	assert.match(groups[0]!.label, /子代理 1 · system 模块/);
	assert.match(groups[1]!.label, /子代理 2 · monitor 模块/);
	assert.equal(groups[0]!.fullLabel, task('system 模块'));
});

test('a single agent group keeps its task label; a running spawn synthetic echoing the raw task is dropped, a live-activity one stays (#12 polish)', async () => {
	const { buildWorkSections } = await import('../../src/sessions/browser/parts/agentUi/components/workRender.js');
	const task = '梳理 services 层';
	const base = { kind: 'tool', durationMs: 1, tool: 'spawn_agent', arg: task, agent: 'a1' };
	// Echo phase: synthetic label is still the raw tool label — must not render.
	const echo = buildWorkSections([
		{ ...base, label: `子代理 ⑃ ${task}` },
		{ ...base, label: `spawn_agent ${task}`, running: true },
	] as never[]);
	const echoGroup = echo[0]!.items.find(item => item.kind === 'agentGroup') as { label: string; items: readonly unknown[]; running: boolean };
	assert.equal(echoGroup.items.length, 0, 'the raw-task echo row is noise under the header');
	assert.equal(echoGroup.running, true, 'the group still spins');
	assert.match(echoGroup.label, /梳理 services 层/, 'a lone group keeps the task text');
	// Live phase: the label moved on to real child activity — that row renders.
	const live = buildWorkSections([
		{ ...base, label: `子代理 ⑃ ${task}` },
		{ ...base, label: '⑃ 撰写结论中 · 3.4k 字', running: true },
	] as never[]);
	const liveGroup = live[0]!.items.find(item => item.kind === 'agentGroup') as { items: readonly { kind: string }[] };
	assert.equal(liveGroup.items.length, 1, 'live activity rows stay');
});
