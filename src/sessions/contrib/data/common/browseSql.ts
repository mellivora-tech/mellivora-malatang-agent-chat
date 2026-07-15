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
	const orderBy = state.sort ? ` ORDER BY ${quoteIdentifier(driver, state.sort.column)} ${state.sort.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
	const offset = state.page > 0 ? ` OFFSET ${state.page * state.pageSize}` : '';
	return `SELECT * FROM ${target}${orderBy} LIMIT ${state.pageSize + 1}${offset}`;
}
