/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MIGRATION_CAPS,
	buildMigrationConfirmTurn,
	buildMigrationReviseTurn,
	parseMigrationPreviewProps,
	type IMigrationCellEdit,
	type IMigrationPreviewProps,
} from '../../src/sessions/services/sessions/common/uiComponents/migrationPreview.js';

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
