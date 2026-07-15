/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseDriver, IDbTable } from '../../../services/environments/common/environments.js';

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
	const orderBy = state.sort ? ` ORDER BY ${quoteIdentifier(driver, state.sort.column)} ${state.sort.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
	const offset = state.page > 0 ? ` OFFSET ${state.page * state.pageSize}` : '';
	return `${orderBy} LIMIT ${state.pageSize + 1}${offset}`;
}
