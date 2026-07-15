/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseDriver, DataColumnCategory, IDbTable } from '../../../services/environments/common/environments.js';

/**
 * Grid state → SQL, compiled renderer-side. The main process stays a pure
 * gatekeeper (isReadOnlySql + row cap); everything the panel knows — table,
 * sort, page — is expressed here as a plain SELECT.
 */

export interface IBrowseSort {
	readonly column: string;
	readonly direction: 'asc' | 'desc';
}

export interface IBrowseState {
	readonly sort?: IBrowseSort;
	/** Pre-compiled WHERE clauses ({@link compileColumnFilter}), ANDed together. */
	readonly filters?: readonly string[];
	readonly pageSize: number;
	/** Zero-based. */
	readonly page: number;
}

/** Quote an identifier for the driver, doubling embedded quote characters. */
export function quoteIdentifier(driver: DatabaseDriver, name: string): string {
	return driver === 'postgres' ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll('`', '``')}\``;
}

/**
 * The page query. LIMIT asks for one row beyond the page so the caller can pass
 * `rowLimit: pageSize` and read the runner's `truncated` flag as "has a next page".
 */
export function compileBrowseSql(driver: DatabaseDriver, table: IDbTable, state: IBrowseState): string {
	const target = table.schema
		? `${quoteIdentifier(driver, table.schema)}.${quoteIdentifier(driver, table.name)}`
		: quoteIdentifier(driver, table.name);
	return `SELECT * FROM ${target}${compilePageClauses(driver, state)}`;
}

/**
 * Page an arbitrary read-only query (the chat → panel hand-off) by wrapping it
 * as a derived table: sorting and paging apply to the ORIGINAL result set, so
 * the panel can keep exploring what the agent queried without re-parsing SQL.
 * The wrapped statement still passes the main-side isReadOnlySql gate iff the
 * inner one does.
 */
export function compileQueryBrowseSql(driver: DatabaseDriver, baseSql: string, state: IBrowseState): string {
	const inner = baseSql.trim().replace(/;+\s*$/, '');
	return `SELECT * FROM (${inner}) AS ${quoteIdentifier(driver, '_browse')}${compilePageClauses(driver, state)}`;
}

function compilePageClauses(driver: DatabaseDriver, state: IBrowseState): string {
	const where = state.filters && state.filters.length > 0 ? ` WHERE ${state.filters.map(clause => `(${clause})`).join(' AND ')}` : '';
	const orderBy = state.sort ? ` ORDER BY ${quoteIdentifier(driver, state.sort.column)} ${state.sort.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
	const offset = state.page > 0 ? ` OFFSET ${state.page * state.pageSize}` : '';
	return `${where}${orderBy} LIMIT ${state.pageSize + 1}${offset}`;
}

/**
 * One header-filter box → one WHERE clause. The tiny grammar mirrors what a
 * DataGrip filter row does:
 *
 *   `>= 100` / `< 2026-01-01` / `!= x` — comparison, quoted unless numeric
 *   `NULL` / `!NULL`                   — IS NULL / IS NOT NULL
 *   `100` on a number column           — equality
 *   anything else                      — contains (LIKE %…%)
 *
 * Literals ride single quotes with '' escaping (plus \\ for mysql); anything
 * still hostile is over-rejected downstream by isReadOnlySql — the clause never
 * reaches a driver unless the WHOLE statement stays a pure read.
 */
export function compileColumnFilter(driver: DatabaseDriver, column: { readonly name: string; readonly category: DataColumnCategory }, raw: string): string | undefined {
	const value = raw.trim();
	if (value === '') {
		return undefined;
	}
	const ident = quoteIdentifier(driver, column.name);
	if (/^!?null$/i.test(value)) {
		return `${ident} IS${value.startsWith('!') ? ' NOT' : ''} NULL`;
	}
	const comparison = /^(>=|<=|!=|<>|=|>|<)\s*(.+)$/.exec(value);
	if (comparison) {
		const operator = comparison[1] === '!=' ? '<>' : comparison[1]!;
		return `${ident} ${operator} ${literal(driver, comparison[2]!.trim())}`;
	}
	if (column.category === 'number' && isNumericLiteral(value)) {
		return `${ident} = ${value}`;
	}
	if (column.category === 'boolean' && /^(true|false)$/i.test(value)) {
		return `${ident} = ${value.toUpperCase()}`;
	}
	return `${ident} LIKE ${quoteLiteral(driver, `%${value}%`)}`;
}

function literal(driver: DatabaseDriver, operand: string): string {
	return isNumericLiteral(operand) ? operand : quoteLiteral(driver, operand);
}

function isNumericLiteral(value: string): boolean {
	return /^-?\d+(\.\d+)?$/.test(value);
}

function quoteLiteral(driver: DatabaseDriver, text: string): string {
	const escaped = driver === 'mysql' ? text.replaceAll('\\', '\\\\').replaceAll("'", "''") : text.replaceAll("'", "''");
	return `'${escaped}'`;
}
