/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MIGRATION_CAPS,
	applyMappingEdits,
	buildMigrationConfirmTurn,
	buildMigrationReviseTurn,
	buildMigrationSql,
	parseMigrationPreviewProps,
	quoteIdentifier,
	type IMigrationCellEdit,
	type IMigrationMappingEdit,
	type IMigrationPreviewProps,
} from '../../src/sessions/services/sessions/common/uiComponents/migrationPreview.js';
import { isReadOnlySql, isSingleStatement } from '../../src/main/agent/dbQuery.js';

const VALID = {
	sourceLabel: 'mysql:legacy_orders',
	targetLabel: 'pg:orders_v2',
	mappings: [
		{ source: 'orders.cust_name', target: 'customers.name', transform: 'trim + title-case' },
		{ source: 'orders.amount_cents', target: 'orders.amount', transform: '/100,保留两位小数' },
	],
	columns: ['name', 'amount'],
	sampleRows: [
		['张三', 12.5],
		['  李四 ', 99.99],
	],
	validations: [{ row: 1, column: 'name', level: 'warning' as const, message: '首尾空白未去除' }],
	totalRowCount: 12_340,
	note: '金额按 **分→元** 转换。',
};

// --- parseMigrationPreviewProps ---

test('parseMigrationPreviewProps accepts a valid payload and preserves every field', () => {
	const parsed = parseMigrationPreviewProps(VALID);
	assert.ok(parsed);
	assert.equal(parsed.sourceLabel, 'mysql:legacy_orders');
	assert.equal(parsed.mappings.length, 2);
	assert.deepEqual(parsed.columns, ['name', 'amount']);
	assert.deepEqual(parsed.sampleRows[1], ['  李四 ', 99.99]);
	assert.equal(parsed.validations?.[0]?.level, 'warning');
	assert.equal(parsed.totalRowCount, 12_340);
	assert.match(parsed.note ?? '', /分→元/);
});

test('null/boolean cells are legal; sampleRows may be empty (mapping-only proposal)', () => {
	const parsed = parseMigrationPreviewProps({ ...VALID, sampleRows: [[null, true]], validations: undefined });
	assert.ok(parsed, 'null/boolean cells accepted');
	assert.ok(parseMigrationPreviewProps({ ...VALID, sampleRows: [], validations: undefined }), 'empty sample accepted');
});

test('each cap and cross-check refuses: rows, mappings, columns, validations, cell length, ragged rows, out-of-range refs', () => {
	const rows = (count: number) => Array.from({ length: count }, () => ['x', 1]);
	assert.equal(parseMigrationPreviewProps({ ...VALID, sampleRows: rows(MIGRATION_CAPS.sampleRows + 1), validations: undefined }), undefined, '51 sample rows refused');

	const manyMappings = Array.from({ length: MIGRATION_CAPS.mappings + 1 }, (_, index) => ({ source: `s${index}`, target: `t${index}` }));
	assert.equal(parseMigrationPreviewProps({ ...VALID, mappings: manyMappings }), undefined, '101 mappings refused');

	const manyColumns = Array.from({ length: MIGRATION_CAPS.columns + 1 }, (_, index) => `c${index}`);
	assert.equal(parseMigrationPreviewProps({ ...VALID, columns: manyColumns, sampleRows: [], validations: undefined }), undefined, '41 columns refused');

	const manyValidations = Array.from({ length: MIGRATION_CAPS.validations + 1 }, () => ({ row: 0, column: 'name', level: 'error', message: 'x' }));
	assert.equal(parseMigrationPreviewProps({ ...VALID, validations: manyValidations }), undefined, '201 validations refused');

	const longCell = 'x'.repeat(MIGRATION_CAPS.cellChars + 1);
	assert.equal(parseMigrationPreviewProps({ ...VALID, sampleRows: [[longCell, 1]], validations: undefined }), undefined, '501-char cell refused');

	assert.equal(parseMigrationPreviewProps({ ...VALID, sampleRows: [['only-one-cell']], validations: undefined }), undefined, 'ragged row refused');
	assert.equal(parseMigrationPreviewProps({ ...VALID, mappings: [] }), undefined, 'empty mappings refused');
	assert.equal(parseMigrationPreviewProps({ ...VALID, sourceLabel: ' ' }), undefined, 'blank sourceLabel refused');
});

// --- validations are advisory: malformed entries drop, the card survives ---

test('a malformed validation entry is dropped, never the whole card', () => {
	const hallucinated = parseMigrationPreviewProps({ ...VALID, validations: [{ row: 9, column: 'name', level: 'error', message: 'x' }] });
	assert.ok(hallucinated, 'out-of-range row must not kill the card');
	assert.equal(hallucinated.validations?.length, 0, 'the bad entry itself is dropped');

	const ghostColumn = parseMigrationPreviewProps({ ...VALID, validations: [{ row: 0, column: 'ghost', level: 'error', message: 'x' }] });
	assert.ok(ghostColumn, 'unknown column must not kill the card');
	assert.equal(ghostColumn.validations?.length, 0);
});

test('1-based validation rows (the real-Kimi fingerprint: some row === N, none === 0) are auto-shifted', () => {
	// Regression for the 2026-07-16 smoke test: 3 sample rows, Kimi sent rows
	// 1..3 — the whole card was refused. Now the N tell triggers a shift.
	const threeRows = {
		...VALID,
		sampleRows: [
			['a', 1],
			['b', 2],
			['c', 3],
		],
	};
	const shifted = parseMigrationPreviewProps({
		...threeRows,
		validations: [
			{ row: 1, column: 'name', level: 'warning', message: 'w1' },
			{ row: 3, column: 'name', level: 'warning', message: 'w3' },
		],
	});
	assert.ok(shifted);
	assert.deepEqual(
		shifted.validations?.map(validation => validation.row),
		[0, 2],
		'all rows shift by -1 when the 1-based tell is present',
	);

	// No tell (no row === N) → rows are taken as 0-based as documented.
	const asIs = parseMigrationPreviewProps({ ...threeRows, validations: [{ row: 1, column: 'name', level: 'warning', message: 'w' }] });
	assert.equal(asIs?.validations?.[0]?.row, 1, 'ambiguous rows stay 0-based');

	// row 0 present alongside row N → contradictory; N is dropped, 0 kept.
	const mixed = parseMigrationPreviewProps({
		...threeRows,
		validations: [
			{ row: 0, column: 'name', level: 'warning', message: 'w0' },
			{ row: 3, column: 'name', level: 'warning', message: 'w3' },
		],
	});
	assert.deepEqual(
		mixed?.validations?.map(validation => validation.row),
		[0],
		'no shift when a 0 exists; the impossible row drops',
	);
});

// --- P1a: compile trio + transformSql parse ---

const COMPILABLE = {
	...VALID,
	sourceTable: 'test.legacy_orders',
	targetTable: 'orders_v2',
	dialect: 'mysql' as const,
	mappings: [
		{ source: 'cust_name', target: 'name', transform: 'trim + title-case', transformSql: 'TRIM(cust_name)' },
		{ source: 'amount_cents', target: 'amount', transform: '分→元', transformSql: 'amount_cents / 100' },
		{ source: 'status', target: 'status' },
	],
	columns: ['name', 'amount', 'status'],
	sampleRows: [['张三', 12.5, 1]],
	validations: undefined,
	filterSql: "status <> ''",
};

test('the compile trio and transformSql parse, cap, and degrade correctly', () => {
	const parsed = parseMigrationPreviewProps(COMPILABLE);
	assert.ok(parsed);
	assert.equal(parsed.sourceTable, 'test.legacy_orders');
	assert.equal(parsed.dialect, 'mysql');
	assert.equal(parsed.mappings[0]?.transformSql, 'TRIM(cust_name)');
	assert.equal(parsed.mappings[2]?.transformSql, undefined, 'carry-over mapping has no expression');
	assert.equal(parsed.filterSql, "status <> ''");

	// A bad dialect value degrades to review-only, never a refusal.
	const badDialect = parseMigrationPreviewProps({ ...COMPILABLE, dialect: 'oracle' });
	assert.ok(badDialect);
	assert.equal(badDialect.dialect, undefined);

	const overCap = 'x'.repeat(MIGRATION_CAPS.sqlChars + 1);
	assert.equal(parseMigrationPreviewProps({ ...COMPILABLE, mappings: [{ source: 's', target: 't', transformSql: overCap }] }), undefined, 'over-cap expression refused');
	assert.equal(parseMigrationPreviewProps({ ...COMPILABLE, sourceTable: overCap }), undefined, 'over-cap table identifier refused');
	assert.equal(parseMigrationPreviewProps({ ...COMPILABLE, filterSql: overCap }), undefined, 'over-cap filter refused');
});

// --- P1a: buildMigrationSql goldens ---

test('buildMigrationSql compiles the mysql golden and satisfies the execute_data_source contract', () => {
	const props = parseMigrationPreviewProps(COMPILABLE)!;
	const sql = buildMigrationSql(props);
	assert.equal(sql, "INSERT INTO `orders_v2` (`name`, `amount`, `status`)\nSELECT TRIM(cust_name), amount_cents / 100, `status`\nFROM `test`.`legacy_orders`\nWHERE status <> '';");
	// Contract lock: exactly one statement, and NOT a read (execute_data_source
	// refuses reads and scripts — the export must be feedable as-is).
	assert.equal(isSingleStatement(sql!), true);
	assert.equal(isReadOnlySql(sql!), false);
});

test('buildMigrationSql compiles the postgres golden with double-quoted identifiers', () => {
	const props = parseMigrationPreviewProps({ ...COMPILABLE, dialect: 'postgres', filterSql: undefined })!;
	const sql = buildMigrationSql(props);
	assert.equal(sql, 'INSERT INTO "orders_v2" ("name", "amount", "status")\nSELECT TRIM(cust_name), amount_cents / 100, "status"\nFROM "test"."legacy_orders";');
});

test('buildMigrationSql returns undefined without the compile trio — the card is review-only', () => {
	assert.equal(buildMigrationSql(parseMigrationPreviewProps(VALID)!), undefined, 'no tables/dialect → no compile');
	assert.equal(buildMigrationSql(parseMigrationPreviewProps({ ...COMPILABLE, targetTable: undefined })!), undefined, 'missing one leg → no compile');
});

test('quoteIdentifier escapes embedded quotes so a hostile identifier cannot break out', () => {
	assert.equal(quoteIdentifier('user`s', 'mysql'), '`user``s`');
	assert.equal(quoteIdentifier('user"s', 'postgres'), '"user""s"');
	assert.equal(quoteIdentifier('a.b', 'mysql'), '`a`.`b`');
});

// --- P1b: in-card mapping edits ---

test('applyMappingEdits: overrides replace, blanks fall back, cleared transformSql reverts to carry-over, dropped rows vanish', () => {
	const base = parseMigrationPreviewProps(COMPILABLE)!.mappings;
	const edits: IMigrationMappingEdit[] = [
		{ index: 0, target: 'full_name' },
		{ index: 1, transformSql: '' },
		{ index: 2, dropped: true },
	];
	const effective = applyMappingEdits(base, edits);
	assert.equal(effective.length, 2, 'dropped mapping excluded');
	assert.equal(effective[0]?.target, 'full_name', 'target override applied');
	assert.equal(effective[0]?.transformSql, 'TRIM(cust_name)', 'untouched expression survives');
	assert.equal(effective[1]?.transformSql, undefined, 'cleared expression reverts to carry-over');
	assert.equal(applyMappingEdits(base, []).length, 3, 'no edits = identity');
});

test('edited mappings compile: the exported SQL reflects renames and drops', () => {
	const props = parseMigrationPreviewProps(COMPILABLE)!;
	const effective = applyMappingEdits(props.mappings, [
		{ index: 0, target: 'full_name' },
		{ index: 2, dropped: true },
	]);
	const sql = buildMigrationSql({ ...props, mappings: effective });
	assert.ok(sql);
	assert.match(sql, /`full_name`/, 'renamed column lands in the INSERT list');
	assert.doesNotMatch(sql, /`status`/, 'dropped field is gone from the statement');
	assert.equal(isSingleStatement(sql), true);
});

test('buildMigrationConfirmTurn carries edited mappings, dropped fields, and the exact compiled SQL', () => {
	const props = parseMigrationPreviewProps(COMPILABLE)!;
	const mappingEdits: IMigrationMappingEdit[] = [
		{ index: 0, target: 'full_name' },
		{ index: 2, dropped: true },
	];
	const compiledSql = buildMigrationSql({ ...props, mappings: applyMappingEdits(props.mappings, mappingEdits) })!;
	const turn = buildMigrationConfirmTurn(props, [], { mappingEdits, compiledSql });

	assert.match(turn, /我在卡片中做过调整/);
	assert.match(turn, /cust_name → full_name/, 'effective (edited) mapping listed');
	assert.match(turn, /丢弃了这些源字段（不迁移）：status/);
	assert.match(turn, /原样执行这一条语句，不要重新生成/);
	assert.ok(turn.includes(compiledSql), 'the exact compiled statement rides the turn');
	assert.doesNotMatch(turn, /请先展示将要执行的迁移 SQL/, 'the regenerate instruction is replaced');

	// Without the compile trio the turn keeps the old show-me-the-SQL flow.
	const reviewOnly = buildMigrationConfirmTurn(parseMigrationPreviewProps(VALID)!, []);
	assert.match(reviewOnly, /请先展示将要执行的迁移 SQL/);
});

// --- turn builders ---

const PROPS: IMigrationPreviewProps = parseMigrationPreviewProps(VALID)!;
const EDITS: readonly IMigrationCellEdit[] = [{ row: 1, column: 'name', before: '  李四 ', after: '李四' }];

test('buildMigrationConfirmTurn quotes mappings, includes edits as generalizable rules, and points at execute_data_source', () => {
	const turn = buildMigrationConfirmTurn(PROPS, EDITS);
	assert.match(turn, /mysql:legacy_orders → pg:orders_v2/);
	assert.match(turn, /- orders\.cust_name → customers\.name（transform: trim \+ title-case）/);
	assert.match(turn, /共 1 处/);
	assert.match(turn, /第 2 行 \[name\]: " {2}李四 " → "李四"/, 'row numbers are 1-based');
	assert.match(turn, /推广到全量数据/);
	assert.match(turn, /execute_data_source/);

	const noEdits = buildMigrationConfirmTurn(PROPS, []);
	assert.doesNotMatch(noEdits, /人工修正/, 'edit block omitted when there are none');
});

test('buildMigrationReviseTurn: undefined with nothing to say; formats edits and the user note otherwise', () => {
	assert.equal(buildMigrationReviseTurn(PROPS, []), undefined);
	assert.equal(buildMigrationReviseTurn(PROPS, [], '   '), undefined);

	const turn = buildMigrationReviseTurn(PROPS, EDITS, '金额字段应该四舍五入');
	assert.ok(turn);
	assert.match(turn, /需要调整/);
	assert.match(turn, /第 2 行 \[name\]/);
	assert.match(turn, /金额字段应该四舍五入/);
	assert.match(turn, /重新调用 render_ui（component=migration_preview）/);
});
