/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDataColumn } from '../../../services/environments/common/environments.js';

/**
 * The data panel's provider seam (#7): the panel shell (grid, pager, header
 * filters, status bar, 问 AI) is source-agnostic — everything源-specific
 * (SQL today; files/Redis/ES next) lives behind this contract. Capabilities
 * are declared, not assumed: a provider without server-side sort simply
 * doesn't get sort clicks, instead of pretending.
 */

export interface IDataSort {
	readonly column: string;
	readonly direction: 'asc' | 'desc';
}

/** Grid interaction state, provider-agnostic. Filters carry the RAW header-box
 *  text keyed by column INDEX — each provider compiles them its own way
 *  (SQL → WHERE; a local provider evaluates the same grammar in JS). */
export interface IDataViewState {
	/** Zero-based. */
	readonly page: number;
	readonly pageSize: number;
	readonly sort?: IDataSort;
	readonly filters: ReadonlyMap<number, string>;
}

export type DataFetchResult =
	| {
			readonly ok: true;
			readonly columns: readonly IDataColumn[];
			readonly rows: readonly (readonly unknown[])[];
			readonly hasNext: boolean;
			readonly durationMs: number;
			/** Provider-worded extra for the status line (e.g. `约 120 行`). */
			readonly note?: string;
	  }
	| { readonly ok: false; readonly message: string };

export interface IDataProviderCapabilities {
	/** Header clicks cycle a server-side sort. */
	readonly sort: boolean;
	/** Header filter boxes appear and re-query. */
	readonly filter: boolean;
	/** Random page access (a Redis SCAN cursor would say false and only step forward). */
	readonly pager: boolean;
}

export interface IDataProvider {
	readonly capabilities: IDataProviderCapabilities;
	/** One page of data for the given state. Errors return as messages, never throw. */
	fetch(state: IDataViewState): Promise<DataFetchResult>;
	/** Copyable description of what fetch would run (the SQL text today) — status bar. */
	describeQuery(state: IDataViewState): string;
	/** Short identity for the tab chip (`dev·orders`). */
	contextLabel(): string;
	/** Identity lines for the 问 AI reference (source/table/query); the panel
	 *  appends the renderer-side lines (page position, selected cell) itself. */
	referenceLines(state: IDataViewState): readonly string[];
}
