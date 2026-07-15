/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'tabulator-tables/dist/css/tabulator.min.css';
import { TabulatorFull, type CellComponent, type ColumnDefinition } from 'tabulator-tables';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IEnvironmentsService } from '../../../services/environments/browser/environmentsService.js';
import type { DbColumnCategory, IDatabaseSource, IDbColumn, IDbTable } from '../../../services/environments/common/environments.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { compileBrowseSql, type IBrowseSort } from '../common/browseSql.js';

export interface IDataBrowserViewOptions {
	readonly environmentsService?: IEnvironmentsService;
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

type BrowsableSource = IDatabaseSource & { readonly hasCredential: boolean };

const PAGE_SIZES = [50, 100, 200, 500];

/**
 * Lightweight DataGrip-style table browser (issue #4 P0): pick a database data
 * source, pick a table, page/sort through it read-only. All SQL is compiled
 * from grid state (browseSql.ts) and gated main-side; heavy interaction costs
 * zero model tokens.
 */
export class DataBrowserView extends Disposable {
	private readonly sourceSelect: HTMLSelectElement;
	private readonly tableSelect: HTMLSelectElement;
	private readonly refreshButton: HTMLButtonElement;
	private readonly pageSizeSelect: HTMLSelectElement;
	private readonly prevButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly pageLabel: HTMLElement;
	private readonly gridHost: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly statusSql: HTMLElement;

	private table: TabulatorFull | undefined;
	private projectId: string | undefined;
	private sources: readonly BrowsableSource[] = [];
	private environmentNames = new Map<string, string>();
	private tables: readonly IDbTable[] = [];
	private sort: IBrowseSort | undefined;
	private page = 0;
	private pageSize = 100;
	private hasNext = false;
	/** Monotonic guard: a response only lands if it's still the newest request. */
	private requestStamp = 0;

	constructor(container: HTMLElement, private readonly options: IDataBrowserViewOptions = {}) {
		super();

		const root = document.createElement('div');
		root.className = 'data-browser';
		container.appendChild(root);

		const toolbar = document.createElement('div');
		toolbar.className = 'data-browser-toolbar';
		root.appendChild(toolbar);

		this.sourceSelect = document.createElement('select');
		this.sourceSelect.className = 'data-browser-select data-browser-source';
		this.sourceSelect.title = '数据源';
		this.sourceSelect.addEventListener('change', () => void this.onSourceChanged());
		toolbar.appendChild(this.sourceSelect);

		this.tableSelect = document.createElement('select');
		this.tableSelect.className = 'data-browser-select data-browser-table';
		this.tableSelect.title = '表 / 视图';
		this.tableSelect.addEventListener('change', () => this.onTableChanged());
		toolbar.appendChild(this.tableSelect);

		this.refreshButton = this.createIconButton(toolbar, 'codicon-refresh', '刷新');
		this.refreshButton.addEventListener('click', () => void this.runQueryNow());

		const spacer = document.createElement('span');
		spacer.className = 'data-browser-spacer';
		toolbar.appendChild(spacer);

		this.pageSizeSelect = document.createElement('select');
		this.pageSizeSelect.className = 'data-browser-select data-browser-page-size';
		this.pageSizeSelect.title = '每页行数';
		for (const size of PAGE_SIZES) {
			const option = document.createElement('option');
			option.value = String(size);
			option.textContent = `${size} 行`;
			this.pageSizeSelect.appendChild(option);
		}
		this.pageSizeSelect.value = String(this.pageSize);
		this.pageSizeSelect.addEventListener('change', () => {
			this.pageSize = Number(this.pageSizeSelect.value) || 100;
			this.page = 0;
			void this.runQueryNow();
		});
		toolbar.appendChild(this.pageSizeSelect);

		this.prevButton = this.createIconButton(toolbar, 'codicon-chevron-left', '上一页');
		this.prevButton.addEventListener('click', () => {
			if (this.page > 0) {
				this.page -= 1;
				void this.runQueryNow();
			}
		});
		this.pageLabel = document.createElement('span');
		this.pageLabel.className = 'data-browser-page';
		toolbar.appendChild(this.pageLabel);
		this.nextButton = this.createIconButton(toolbar, 'codicon-chevron-right', '下一页');
		this.nextButton.addEventListener('click', () => {
			if (this.hasNext) {
				this.page += 1;
				void this.runQueryNow();
			}
		});

		this.gridHost = document.createElement('div');
		this.gridHost.className = 'data-browser-grid';
		root.appendChild(this.gridHost);

		const status = document.createElement('div');
		status.className = 'data-browser-status';
		root.appendChild(status);
		this.statusText = document.createElement('span');
		this.statusText.className = 'data-browser-status-text';
		status.appendChild(this.statusText);
		this.statusSql = document.createElement('code');
		this.statusSql.className = 'data-browser-status-sql';
		this.statusSql.title = '点击复制 SQL';
		this.statusSql.addEventListener('click', () => {
			const sql = this.statusSql.textContent;
			if (sql) {
				void navigator.clipboard.writeText(sql).catch(() => {});
			}
		});
		status.appendChild(this.statusSql);

		// The panel follows the active session's project; switching projects reloads sources.
		const activeSession = this.options.sessionsService?.activeSession ?? this.options.sessionsPartService?.activeSession;
		if (activeSession) {
			this._register(activeSession.subscribe(() => {
				const projectId = activeSession.get()?.projectId;
				if (projectId !== this.projectId) {
					this.projectId = projectId;
					void this.loadSources();
				}
			}));
			this.projectId = activeSession.get()?.projectId;
		}
		this.updatePager();
		void this.loadSources();
	}

	override dispose(): void {
		this.table?.destroy();
		this.table = undefined;
		super.dispose();
	}

	private createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = 'data-browser-button';
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		const glyph = document.createElement('span');
		glyph.className = `codicon ${icon}`;
		glyph.setAttribute('aria-hidden', 'true');
		button.appendChild(glyph);
		parent.appendChild(button);
		return button;
	}

	private get selectedSource(): BrowsableSource | undefined {
		return this.sources.find(source => source.id === this.sourceSelect.value);
	}

	private get selectedTable(): IDbTable | undefined {
		const index = Number(this.tableSelect.value);
		return Number.isInteger(index) ? this.tables[index] : undefined;
	}

	private async loadSources(): Promise<void> {
		const stamp = ++this.requestStamp;
		this.sources = [];
		this.tables = [];
		this.resetGrid();
		if (!this.projectId || !this.options.environmentsService?.available) {
			this.renderSelects();
			this.setStatus(this.projectId ? '环境服务不可用。' : '当前会话没有关联项目 — 打开一个项目会话后这里会列出它的数据库。', '');
			return;
		}
		this.setStatus('加载数据源…', '');
		const view = await this.options.environmentsService.get(this.projectId);
		if (stamp !== this.requestStamp) {
			return;
		}
		this.environmentNames = new Map(view.environments.map(environment => [environment.id, environment.name]));
		this.sources = view.dataSources.filter((source): source is BrowsableSource => source.kind === 'database');
		this.renderSelects();
		if (this.sources.length === 0) {
			this.setStatus('项目还没有数据库数据源 — 在项目配置里添加一个。', '');
			return;
		}
		await this.onSourceChanged();
	}

	private async onSourceChanged(): Promise<void> {
		const stamp = ++this.requestStamp;
		const source = this.selectedSource;
		this.tables = [];
		this.sort = undefined;
		this.page = 0;
		this.resetGrid();
		this.renderTableOptions();
		if (!this.projectId || !source || !this.options.environmentsService) {
			return;
		}
		this.setStatus('加载表清单…', '');
		const result = await this.options.environmentsService.listTables(this.projectId, source.id);
		if (stamp !== this.requestStamp) {
			return;
		}
		if (!result.ok) {
			this.setStatus(result.message, '');
			return;
		}
		this.tables = result.tables;
		this.renderTableOptions();
		if (this.tables.length === 0) {
			this.setStatus('这个数据源里没有可见的表。', '');
			return;
		}
		await this.runQueryNow();
	}

	private onTableChanged(): void {
		this.sort = undefined;
		this.page = 0;
		void this.runQueryNow();
	}

	private async runQueryNow(): Promise<void> {
		const stamp = ++this.requestStamp;
		const source = this.selectedSource;
		const table = this.selectedTable;
		if (!this.projectId || !source || !table || !this.options.environmentsService) {
			return;
		}
		const sql = compileBrowseSql(source.coordinates.driver, table, { pageSize: this.pageSize, page: this.page, ...(this.sort ? { sort: this.sort } : {}) });
		this.setStatus('查询中…', sql);
		const result = await this.options.environmentsService.runQuery(this.projectId, source.id, sql, { rowLimit: this.pageSize });
		if (stamp !== this.requestStamp) {
			return;
		}
		if (!result.ok) {
			this.hasNext = false;
			this.resetGrid();
			this.setStatus(result.message, sql);
			this.updatePager();
			return;
		}
		this.hasNext = result.truncated;
		this.buildGrid(result.columns, result.rows);
		const estimate = table.estimatedRows !== undefined ? ` / 约 ${table.estimatedRows} 行` : '';
		this.setStatus(`${result.rows.length} 行${result.truncated ? '+' : ''}${estimate} · ${result.durationMs}ms`, sql);
		this.updatePager();
	}

	private renderSelects(): void {
		this.sourceSelect.textContent = '';
		for (const source of this.sources) {
			const option = document.createElement('option');
			option.value = source.id;
			const environmentName = this.environmentNames.get(source.environmentId);
			option.textContent = environmentName ? `${environmentName} · ${source.label}` : source.label;
			this.sourceSelect.appendChild(option);
		}
		this.sourceSelect.disabled = this.sources.length === 0;
		this.renderTableOptions();
	}

	private renderTableOptions(): void {
		this.tableSelect.textContent = '';
		this.tables.forEach((table, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
			option.textContent = table.estimatedRows !== undefined ? `${qualified}（约 ${table.estimatedRows} 行）` : qualified;
			this.tableSelect.appendChild(option);
		});
		this.tableSelect.disabled = this.tables.length === 0;
	}

	private cycleSort(column: string): void {
		if (this.sort?.column !== column) {
			this.sort = { column, direction: 'asc' };
		} else if (this.sort.direction === 'asc') {
			this.sort = { column, direction: 'desc' };
		} else {
			this.sort = undefined;
		}
		this.page = 0;
		void this.runQueryNow();
	}

	private buildGrid(columns: readonly IDbColumn[], rows: readonly (readonly unknown[])[]): void {
		this.table?.destroy();
		this.gridHost.textContent = '';
		const definitions: ColumnDefinition[] = columns.map((column, index) => ({
			title: this.columnTitle(column.name),
			field: `c${index}`,
			headerSort: false,
			headerClick: () => this.cycleSort(column.name),
			...(column.category === 'number' ? { hozAlign: 'right' as const } : {}),
			formatter: (cell: CellComponent) => formatCellValue(cell.getValue(), column.category),
		}));
		const data = rows.map(row => Object.fromEntries(row.map((value, index) => [`c${index}`, value])));
		this.table = new TabulatorFull(this.gridHost, {
			data,
			columns: definitions,
			layout: 'fitDataFill',
			height: '100%',
			placeholder: '0 行',
		});
	}

	/** Column header text with the server-side sort direction stitched in. */
	private columnTitle(name: string): string {
		if (this.sort?.column !== name) {
			return name;
		}
		return `${name} ${this.sort.direction === 'asc' ? '▲' : '▼'}`;
	}

	private resetGrid(): void {
		this.table?.destroy();
		this.table = undefined;
		this.gridHost.textContent = '';
		this.hasNext = false;
		this.updatePager();
	}

	private updatePager(): void {
		this.pageLabel.textContent = `第 ${this.page + 1} 页`;
		this.prevButton.disabled = this.page === 0;
		this.nextButton.disabled = !this.hasNext;
	}

	private setStatus(text: string, sql: string): void {
		this.statusText.textContent = text;
		this.statusSql.textContent = sql;
		this.statusSql.hidden = sql === '';
	}
}

/** Render a cell value safely (always textContent, never innerHTML). */
export function formatCellValue(value: unknown, category: DbColumnCategory): HTMLElement {
	const span = document.createElement('span');
	if (value === null || value === undefined) {
		span.className = 'data-browser-null';
		span.textContent = 'NULL';
		return span;
	}
	if (value instanceof Date) {
		span.textContent = formatDate(value);
		return span;
	}
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		span.className = 'data-browser-null';
		span.textContent = `[${value instanceof Uint8Array ? value.byteLength : value.byteLength} bytes]`;
		return span;
	}
	if (typeof value === 'object') {
		span.textContent = safeJson(value);
		return span;
	}
	if (category === 'json' && typeof value === 'string') {
		span.textContent = value;
		return span;
	}
	span.textContent = String(value);
	return span;
}

function safeJson(value: object): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatDate(value: Date): string {
	const pad = (part: number): string => String(part).padStart(2, '0');
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
