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
