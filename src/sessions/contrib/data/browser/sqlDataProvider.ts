/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IEnvironmentsService } from '../../../services/environments/browser/environmentsService.js';
import type { IDataColumn, IDatabaseSource, IDbTable } from '../../../services/environments/common/environments.js';
import { compileBrowseSql, compileColumnFilter, compileQueryBrowseSql, type IBrowseState } from '../common/browseSql.js';
import type { DataFetchResult, IDataProvider, IDataViewState } from '../common/dataProvider.js';

/** What the SQL provider needs from its host — the current target is READ
 *  through thunks so the panel's toolbar stays the single source of truth. */
export interface ISqlDataProviderDeps {
	readonly service: IEnvironmentsService;
	getProjectId(): string | undefined;
	getSource(): (IDatabaseSource & { readonly hasCredential: boolean }) | undefined;
	getTable(): IDbTable | undefined;
	/** Query mode (chat hand-off / SQL console): page/sort/filter wrap THIS statement. */
	getBaseQuery(): string | undefined;
	getEnvironmentName(environmentId: string): string | undefined;
}

/**
 * Provider #1 (#7 P0): the original database browser, verbatim, behind the
 * provider contract. Grid state compiles to SQL renderer-side; the main
 * process stays a pure gatekeeper (isReadOnlySql + row cap).
 */
export class SqlDataProvider implements IDataProvider {
	readonly capabilities = { sort: true, filter: true, pager: true } as const;

	/** Columns of the last result — header-filter text compiles against them. */
	private lastColumns: readonly IDataColumn[] = [];

	constructor(private readonly deps: ISqlDataProviderDeps) {}

	describeQuery(state: IDataViewState): string {
		return this.compile(state) ?? '';
	}

	async fetch(state: IDataViewState): Promise<DataFetchResult> {
		const projectId = this.deps.getProjectId();
		const source = this.deps.getSource();
		const sql = this.compile(state);
		if (!projectId || !source || sql === undefined) {
			return { ok: false, message: '没有可查询的目标。' };
		}
		const result = await this.deps.service.runQuery(projectId, source.id, sql, { rowLimit: state.pageSize });
		if (!result.ok) {
			return { ok: false, message: result.message };
		}
		this.lastColumns = result.columns;
		const table = this.deps.getTable();
		const estimate = this.deps.getBaseQuery() === undefined && table?.estimatedRows !== undefined ? { note: `约 ${table.estimatedRows} 行` } : {};
		return { ok: true, columns: result.columns, rows: result.rows, hasNext: result.truncated, durationMs: result.durationMs, ...estimate };
	}

	contextLabel(): string {
		const source = this.deps.getSource();
		if (!source) {
			return '数据';
		}
		const scope = this.deps.getEnvironmentName(source.environmentId) ?? source.label;
		if (this.deps.getBaseQuery() !== undefined) {
			return `${scope}·查询`;
		}
		const table = this.deps.getTable();
		return table ? `${scope}·${table.name}` : scope;
	}

	referenceLines(state: IDataViewState): readonly string[] {
		const source = this.deps.getSource();
		if (!source) {
			return [];
		}
		const scope = this.deps.getEnvironmentName(source.environmentId);
		const lines: string[] = [];
		lines.push(`- 数据源: ${scope ? `${scope} · ` : ''}${source.label}（${source.coordinates.driver} ${source.coordinates.database}）`);
		const baseQuery = this.deps.getBaseQuery();
		const table = this.deps.getTable();
		if (baseQuery !== undefined) {
			lines.push(`- 查询: ${baseQuery}`);
		} else if (table) {
			lines.push(`- 表: ${table.schema ? `${table.schema}.` : ''}${table.name}${table.estimatedRows !== undefined ? `（约 ${table.estimatedRows} 行）` : ''}`);
		}
		const sql = this.describeQuery(state);
		if (sql) {
			lines.push(`- 当前 SQL: ${sql}`);
		}
		return lines;
	}

	/** Grid state → the statement fetch runs; undefined when there is no target. */
	private compile(state: IDataViewState): string | undefined {
		const source = this.deps.getSource();
		if (!source) {
			return undefined;
		}
		const baseQuery = this.deps.getBaseQuery();
		const table = this.deps.getTable();
		if (baseQuery === undefined && !table) {
			return undefined;
		}
		const filters: string[] = [];
		for (const [index, value] of state.filters) {
			const column = this.lastColumns[index];
			const clause = column ? compileColumnFilter(source.coordinates.driver, column, value) : undefined;
			if (clause) {
				filters.push(clause);
			}
		}
		const browseState: IBrowseState = {
			pageSize: state.pageSize,
			page: state.page,
			...(state.sort ? { sort: state.sort } : {}),
			...(filters.length > 0 ? { filters } : {}),
		};
		return baseQuery !== undefined
			? compileQueryBrowseSql(source.coordinates.driver, baseQuery, browseState)
			: compileBrowseSql(source.coordinates.driver, table!, browseState);
	}
}
