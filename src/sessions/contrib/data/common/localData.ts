/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DataColumnCategory } from '../../../services/environments/common/environments.js';
import type { IDataSort, IDataViewState } from './dataProvider.js';

/**
 * Local (in-renderer) evaluation of the SAME header-filter grammar that the SQL
 * provider compiles to WHERE — one grammar everywhere, so a filter box behaves
 * identically over a table, a query, or a csv:
 *
 *   `>= 100` / `!= x` — comparison  ·  `NULL` / `!NULL`  ·  bare number on a
 *   number column → equality  ·  anything else → contains (case-insensitive)
 */
export function matchesColumnFilter(category: DataColumnCategory, raw: string, cell: unknown): boolean {
	const value = raw.trim();
	if (value === '') {
		return true;
	}
	if (/^!?null$/i.test(value)) {
		const isNull = cell === null || cell === undefined || cell === '';
		return value.startsWith('!') ? !isNull : isNull;
	}
	const comparison = /^(>=|<=|!=|<>|=|>|<)\s*(.+)$/.exec(value);
	if (comparison) {
		return compare(cell, comparison[1]!, comparison[2]!.trim());
	}
	if (category === 'number' && /^-?\d+(\.\d+)?$/.test(value)) {
		return Number(cell) === Number(value);
	}
	if (category === 'boolean' && /^(true|false)$/i.test(value)) {
		return String(cell).toLowerCase() === value.toLowerCase();
	}
	return cell !== null && cell !== undefined && String(cell).toLowerCase().includes(value.toLowerCase());
}

function compare(cell: unknown, operator: string, operand: string): boolean {
	if (cell === null || cell === undefined) {
		return false;
	}
	const numeric = /^-?\d+(\.\d+)?$/.test(operand);
	const left: number | string = numeric ? Number(cell) : String(cell instanceof Date ? cell.toISOString() : cell);
	const right: number | string = numeric ? Number(operand) : operand;
	if (numeric && Number.isNaN(left)) {
		return false;
	}
	switch (operator) {
		case '=':
			return left === right;
		case '!=':
		case '<>':
			return left !== right;
		case '>':
			return left > right;
		case '>=':
			return left >= right;
		case '<':
			return left < right;
		case '<=':
			return left <= right;
		default:
			return false;
	}
}

/** NULLs first ascending (last descending) — mirrors the SQL providers' feel. */
export function compareCells(a: unknown, b: unknown): number {
	const aNull = a === null || a === undefined || a === '';
	const bNull = b === null || b === undefined || b === '';
	if (aNull || bNull) {
		return aNull === bNull ? 0 : aNull ? -1 : 1;
	}
	const aNum = typeof a === 'number' ? a : Number(a);
	const bNum = typeof b === 'number' ? b : Number(b);
	if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
		return aNum - bNum;
	}
	const aText = a instanceof Date ? a.toISOString() : String(a);
	const bText = b instanceof Date ? b.toISOString() : String(b);
	return aText < bText ? -1 : aText > bText ? 1 : 0;
}

/**
 * The whole local pipeline for an in-memory dataset: filter → sort → page.
 * Exactly the semantics the SQL provider gets from the database, evaluated here.
 */
export function sliceLocalData(
	columns: readonly { readonly category: DataColumnCategory }[],
	rows: readonly (readonly unknown[])[],
	state: IDataViewState,
	sortColumnIndex: (sort: IDataSort) => number,
): { readonly rows: readonly (readonly unknown[])[]; readonly hasNext: boolean; readonly totalMatched: number } {
	let matched = rows;
	for (const [index, raw] of state.filters) {
		const category = columns[index]?.category ?? 'text';
		matched = matched.filter(row => matchesColumnFilter(category, raw, row[index]));
	}
	if (state.sort) {
		const index = sortColumnIndex(state.sort);
		if (index >= 0) {
			const direction = state.sort.direction === 'desc' ? -1 : 1;
			matched = [...matched].sort((a, b) => direction * compareCells(a[index], b[index]));
		}
	}
	const start = state.page * state.pageSize;
	return { rows: matched.slice(start, start + state.pageSize), hasNext: matched.length > start + state.pageSize, totalMatched: matched.length };
}
