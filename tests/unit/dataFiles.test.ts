/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { inferCategory, parseCsv, toTable } from '../../src/main/dataFiles.js';
import { compareCells, matchesColumnFilter, sliceLocalData } from '../../src/sessions/contrib/data/common/localData.js';

test('parseCsv handles quotes, embedded commas/newlines, CRLF, and trailing newline', () => {
	assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
	assert.deepEqual(parseCsv('a,b\r\n"x,y","he said ""hi"""\r\n'), [['a', 'b'], ['x,y', 'he said "hi"']]);
	assert.deepEqual(parseCsv('a\n"line1\nline2"'), [['a'], ['line1\nline2']]);
	assert.deepEqual(parseCsv(''), []);
});

test('inferCategory reads samples: numbers, booleans, dates, text', () => {
	assert.equal(inferCategory(['1', '2.5', '-3']), 'number');
	assert.equal(inferCategory(['true', 'FALSE']), 'boolean');
	assert.equal(inferCategory(['2026-01-01', '2026-07-15 12:00:00']), 'date');
	assert.equal(inferCategory(['abc', '1']), 'text');
	assert.equal(inferCategory([null, '', undefined]), 'text');
});

test('toTable names blank/duplicate headers positionally and types columns', () => {
	const table = toTable([
		['id', '', 'id'],
		['1', 'x', '2026-01-01'],
		['2', 'y', '2026-01-02'],
	]);
	assert.deepEqual(table.columns.map(column => column.name), ['id', '列2', 'id_3']);
	assert.deepEqual(table.columns.map(column => column.category), ['number', 'text', 'date']);
	assert.equal(table.rows.length, 2);
	assert.equal(table.truncated, false);
});

test('matchesColumnFilter mirrors the SQL grammar locally', () => {
	// contains (case-insensitive) / number equality / comparisons / NULL forms / boolean
	assert.equal(matchesColumnFilter('text', 'item', 'Item-001'), true);
	assert.equal(matchesColumnFilter('text', 'zzz', 'Item-001'), false);
	assert.equal(matchesColumnFilter('number', '100', '100'), true);
	assert.equal(matchesColumnFilter('number', '>= 100', 99), false);
	assert.equal(matchesColumnFilter('number', '>= 100', 100), true);
	assert.equal(matchesColumnFilter('text', '!= x', 'y'), true);
	assert.equal(matchesColumnFilter('number', 'NULL', null), true);
	assert.equal(matchesColumnFilter('number', '!null', null), false);
	assert.equal(matchesColumnFilter('boolean', 'true', 'TRUE'), true);
	// empty filter passes everything; comparisons never match NULL (SQL semantics)
	assert.equal(matchesColumnFilter('text', '   ', 'anything'), true);
	assert.equal(matchesColumnFilter('number', '> 1', null), false);
});

test('compareCells: numeric-aware, date-aware, NULLs first', () => {
	assert.ok(compareCells('9', '10') < 0);
	assert.ok(compareCells('b', 'a') > 0);
	assert.ok(compareCells(null, 'a') < 0);
	assert.equal(compareCells('', null), 0);
	assert.ok(compareCells(new Date('2026-01-02'), new Date('2026-01-01')) > 0);
});

test('sliceLocalData: filter → sort → page with has-next', () => {
	const columns = [{ category: 'number' as const }, { category: 'text' as const }];
	const rows = Array.from({ length: 25 }, (_, index) => [index + 1, `item-${index + 1}`]);
	const state = {
		page: 1,
		pageSize: 5,
		sort: { column: 'id', direction: 'desc' as const },
		filters: new Map([[0, '> 5']]),
	};
	const result = sliceLocalData(columns, rows, state, () => 0);
	// 20 match (6..25), sorted desc → page 1 (second page) = 20..16
	assert.equal(result.totalMatched, 20);
	assert.deepEqual(result.rows.map(row => row[0]), [20, 19, 18, 17, 16]);
	assert.equal(result.hasNext, true);
});
