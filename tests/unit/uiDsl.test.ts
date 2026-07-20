/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SMOKE_CATALOG, generateDslPrompt } from '../../src/sessions/common/uiDsl/catalog.js';
import { formatErrors, parseProgram, splitStatements, statementYield } from '../../src/sessions/common/uiDsl/parser.js';

const parse = (source: string) => parseProgram(source, SMOKE_CATALOG);

test('a well-formed program parses clean: forward refs, state, action, table cells', () => {
	const program = parse(
		[
			'root = Stack([title, tbl, range, apply])',
			'title = Text("订单迁移预览", "title")',
			'tbl = Table(["源字段", "目标字段"], [["order_no", "order_id"], ["amt", 42], ["ok", true], ["gone", null]])',
			'$days = "7"',
			'range = Select("时间范围", ["7", "30"], $days)',
			'apply = Button("应用", Action([@Set($days, "30"), @ToAssistant("重新查询")]))',
		].join('\n'),
	);
	assert.deepEqual(program.errors, []);
	assert.equal(program.attempts, 6);
	assert.equal(statementYield(program).valid, 6);
	const apply = program.statements.get('apply')!;
	assert.equal(apply.value.kind, 'component');
});

test('multi-line statements join while brackets stay open', () => {
	const program = parse(['root = Stack([', '  a,', '  b', '])', 'a = Text("x")', 'b = Text("y")'].join('\n'));
	assert.deepEqual(program.errors, []);
	assert.equal(program.attempts, 3, 'the wrapped Stack is ONE statement');
});

test('last assignment wins — the incremental-edit merge', () => {
	const program = parse(['root = Stack([a])', 'a = Text("v1")', 'a = Text("v2")'].join('\n'));
	assert.deepEqual(program.errors, []);
	const a = program.statements.get('a')!;
	assert.equal((a.value as { args: readonly { value?: unknown }[] }).args[0]!.value, 'v2');
});

test('violations produce structured, attributed errors; healthy statements still land', () => {
	const program = parse(
		[
			'root = Stack([good, bad, ghost])',
			'good = Text("fine")',
			'bad = Text("x", "shouting")', // enum violation
			'weird = Chart([1, 2])', // unknown component
			'orphan = Select("l", ["a"], $missing)', // undeclared state
		].join('\n'),
	);
	const messages = program.errors.map(error => error.message).join('\n');
	assert.match(messages, /variant.*one of "title" \/ "body" \/ "caption"|argument 1 \(variant\)/);
	assert.match(messages, /unknown component "Chart"/);
	assert.match(messages, /state "\$missing" is never declared/);
	assert.match(messages, /reference "bad" is never defined|reference "ghost" is never defined/);
	assert.ok(program.statements.has('good'));
	assert.ok(!program.statements.has('bad'), 'the enum violation dropped its statement');
	const { valid, attempts } = statementYield(program);
	assert.equal(attempts, 5);
	assert.ok(valid < attempts);
	// The feedback text carries hints — it is what the self-correction turn sends.
	assert.match(formatErrors(program.errors), /hint:/);
});

test('arity errors carry the positional signature as the hint', () => {
	const program = parse(['root = Stack([t])', 't = Table(["a"])'].join('\n'));
	assert.match(program.errors[0]!.message, /Table takes 2 argument\(s\), got 1/);
	assert.match(program.errors[0]!.hint ?? '', /Table\(columns, rows\)/);
});

test('a program without root is flagged; junk lines and unterminated strings fail atomically', () => {
	// The unterminated string comes LAST: an open quote legitimately continues
	// the statement across lines (Autocloser's premise), so anything after it
	// would be swallowed into the same statement — that is by design.
	const program = parse(['a = Text("fine")', 'not a statement at all', 'b = Text("unterminated)'].join('\n'));
	const messages = program.errors.map(error => error.message).join('\n');
	assert.match(messages, /unterminated string/);
	assert.match(messages, /expected "="/);
	assert.match(messages, /no `root = ...` statement/);
	assert.ok(program.statements.has('a'), 'the healthy line still parsed');
});

test('splitStatements never merges balanced lines and survives brackets inside strings', () => {
	const raw = splitStatements(['a = Text("has ) and ] inside")', 'b = Text("plain")'].join('\n'));
	assert.equal(raw.length, 2);
});

test('the generated prompt documents every catalog component with its positional signature (same-source guarantee)', () => {
	const prompt = generateDslPrompt();
	for (const component of SMOKE_CATALOG) {
		assert.ok(prompt.includes(`${component.name}(${component.args.map(arg => arg.name + (arg.optional ? '?' : '')).join(', ')})`), component.name);
	}
	assert.match(prompt, /0-BASED/);
	assert.match(prompt, /@ToAssistant/);
});

// --- M3: Autocloser / incremental / fold ----------------------------------------

test('autocloseFragment: open string and bracket stack close in order; dangling names drop (M3)', async () => {
	const { autocloseFragment } = await import('../../src/sessions/common/uiDsl/incremental.js');
	assert.equal(autocloseFragment('a = Text("half'), 'a = Text("half")');
	assert.equal(autocloseFragment('root = Stack([a, b'), 'root = Stack([a, b])');
	assert.equal(autocloseFragment('a = Text("x")\nb'), 'a = Text("x")');
	assert.equal(autocloseFragment('a = Text("x")\nb ='), 'a = Text("x")');
	assert.equal(autocloseFragment('a = Text("x")'), 'a = Text("x")', 'balanced text passes through');
});

test('incremental parser: chunked pushes render the streamed prefix and converge to the one-shot parse (M3)', async () => {
	const { createIncrementalParser } = await import('../../src/sessions/common/uiDsl/incremental.js');
	const full = ['root = Stack([title, tbl])', 'title = Text("报告", "title")', 'tbl = Table(["k"], [["v"]])'].join('\n');
	const inc = createIncrementalParser(SMOKE_CATALOG);

	// Mid-stream: truncated inside the Table call — earlier statements render,
	// no missing-root/unresolved-forward-ref noise while streaming.
	const mid = inc.push(full.slice(0, 58));
	assert.ok(mid.statements.has('root'));
	assert.ok(mid.statements.has('title'));
	assert.equal(mid.errors.filter(error => /never defined|no `root/.test(error.message)).length, 0);

	// Final: identical to a one-shot parse, and the memo actually reused work.
	const final = inc.push(full, { final: true });
	const oneShot = parse(full);
	assert.deepEqual([...final.statements.keys()], [...oneShot.statements.keys()]);
	assert.deepEqual(final.errors, oneShot.errors);
	assert.ok(inc.stats.hits > 0, `memo hits: ${inc.stats.hits}`);
});

test('foldSurface: later batches override by name, cross-batch refs resolve, tree materializes (M3)', async () => {
	const { foldSurface } = await import('../../src/sessions/common/uiDsl/fold.js');
	const folded = foldSurface(
		[
			['$days = "7"', 'root = Stack([title, range])', 'title = Text("日志", "title")', 'range = Select("范围", ["7", "30"], $days)'].join('\n').replace('$days)', '$days)'),
			// Turn 2: incremental edit — retitle and add a row via override + new statement.
			['title = Text("日志(已筛选)", "title")', 'root = Stack([title, range, hint])', 'hint = Text("已应用 30 天", "caption")'].join('\n'),
		],
		SMOKE_CATALOG,
	);
	assert.equal(folded.errors.length, 0, JSON.stringify(folded.errors));
	assert.equal(folded.states.get('$days'), '7');
	assert.ok(folded.root);
	assert.equal(folded.root.component, 'Stack');
	const children = folded.root.args[0]!;
	assert.equal(children.kind, 'array');
	const names = (children as { items: readonly { kind: string; node?: { name: string } }[] }).items.map(item => item.node?.name);
	assert.deepEqual(names, ['title', 'range', 'hint'], 'batch-2 root override wins; range resolves ACROSS batches');
	const title = (children as { items: readonly { node?: { args: readonly { value?: unknown }[] } }[] }).items[0]!.node!;
	assert.equal(title.args[0]!.value, '日志(已筛选)', 'the batch-2 title override won');
});

test('foldSurface: circular references render a hole with an attributed error, never hang (M3)', async () => {
	const { foldSurface } = await import('../../src/sessions/common/uiDsl/fold.js');
	const folded = foldSurface([['root = Stack([a])', 'a = Stack([root])'].join('\n')], SMOKE_CATALOG);
	assert.match(folded.errors.map(error => error.message).join('\n'), /circular reference/);
	assert.ok(folded.root, 'the tree still materializes around the hole');
});

// --- M4: surface_patch component gate -------------------------------------------

test('parseSurfacePatchProps: clean batches pass (default surface), lint violations reject with a structured explainer (M4)', async () => {
	const { parseSurfacePatchProps, explainSurfacePatchProps } = await import('../../src/sessions/services/sessions/common/uiComponents/surfacePatch.js');
	const clean = parseSurfacePatchProps({ statements: 'title = Text("hi")' });
	assert.deepEqual(clean, { surface: 'main', statements: 'title = Text("hi")' });
	// A later batch never re-declares root and may reference earlier skeletons —
	// batch lint must NOT punish either.
	const patch = parseSurfacePatchProps({ surface: 'main', statements: 'hint = Text("已应用")' });
	assert.ok(patch);
	// Statement-level violations reject, and the explainer carries parser hints.
	assert.equal(parseSurfacePatchProps({ statements: 'x = Chart([1])' }), undefined);
	assert.match(explainSurfacePatchProps({ statements: 'x = Chart([1])' }) ?? '', /unknown component "Chart"/);
	assert.equal(parseSurfacePatchProps({ statements: '' }), undefined);
	assert.equal(parseSurfacePatchProps({ surface: 'bad id!', statements: 'a = Text("x")' }), undefined);
});
