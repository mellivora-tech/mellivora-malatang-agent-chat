/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'tabulator-tables/dist/css/tabulator.min.css';
import { TabulatorFull, type CellComponent, type ColumnDefinition } from 'tabulator-tables';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IEnvironmentsService } from '../../../services/environments/browser/environmentsService.js';
import type { DataColumnCategory, IDatabaseSource, IDataColumn, IDbTable } from '../../../services/environments/common/environments.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ISessionDataBrowse } from '../../../services/sessions/common/session.js';
import type { IDataFilesBridge, IPickedDataFile } from '../../../services/dataFiles/common/dataFiles.js';
import type { IDataProvider, IDataSort, IDataViewState } from '../common/dataProvider.js';
import { FileDataProvider } from './fileDataProvider.js';
import { SqlDataProvider } from './sqlDataProvider.js';

export interface IDataBrowserViewOptions {
	readonly environmentsService?: IEnvironmentsService;
	readonly dataFiles?: IDataFilesBridge;
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	/** Reports the current browse context (e.g. `dev·orders`) — the host renames the tab chip with it. */
	readonly onContextChange?: (label: string) => void;
}

type BrowsableSource = IDatabaseSource & { readonly hasCredential: boolean };

const PAGE_SIZES = [50, 100, 200, 500];

/** The table dropdown's synthetic value while browsing a hand-off query. */
const QUERY_OPTION = 'query';

/** The source dropdown's synthetic value while a local file is open. */
const FILE_OPTION = 'file';

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
	private readonly sqlConsole: HTMLElement;
	private readonly sqlInput: HTMLTextAreaElement;

	private table: TabulatorFull | undefined;
	private readonly resizeObserver: ResizeObserver;
	/** The source-specific brains (#7): the panel switches between them by mode. */
	private readonly sqlProvider: IDataProvider | undefined;
	private readonly fileProvider: FileDataProvider;
	/** True while a local file is open — the file provider drives the grid. */
	private fileMode = false;
	private sqlToggle: HTMLButtonElement | undefined;
	private projectId: string | undefined;
	private sources: readonly BrowsableSource[] = [];
	private environmentNames = new Map<string, string>();
	private tables: readonly IDbTable[] = [];
	private sort: IDataSort | undefined;
	private page = 0;
	private pageSize = 100;
	private hasNext = false;
	/** Monotonic guard: a response only lands if it's still the newest request. */
	private requestStamp = 0;
	/** Query mode (chat → panel hand-off): page/sort wrap THIS statement instead of a table. */
	private baseQuery: string | undefined;
	/** The last clicked cell — precise coordinates for the "问 AI" reference. */
	private lastCell: { column: string; value: unknown; anchor?: { column: string; value: unknown } } | undefined;
	/** Resolves when the initial source list has loaded (browse requests await it). */
	private sourcesReady: Promise<void>;
	/** Header-filter values by field (`c0`…): raw user text, compiled to WHERE per query. */
	private columnFilters = new Map<string, string>();
	/** Columns behind the current grid — filter fields translate through it. */
	private gridColumns: readonly IDataColumn[] = [];
	/** Column signature of the live Tabulator: matching results only replace data, keeping filter focus. */
	private gridSignature: string | undefined;
	private filterDebounce: ReturnType<typeof setTimeout> | undefined;

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
		this.refreshButton.addEventListener('click', () => {
			// File mode re-parses from disk; SQL mode re-runs the query.
			const target = this.fileMode ? this.fileProvider.target : undefined;
			void (target ? this.openFile(target, this.fileProvider.activeSheet) : this.runQueryNow());
		});

		this.sqlToggle = this.createIconButton(toolbar, 'codicon-code', 'SQL 控制台');
		this.sqlToggle.addEventListener('click', () => this.toggleSqlConsole());

		if (this.options.dataFiles) {
			const openFile = this.createIconButton(toolbar, 'codicon-folder-opened', '打开数据文件（csv / xlsx）');
			openFile.addEventListener('click', () => void this.pickFile());
		}

		const spacer = document.createElement('span');
		spacer.className = 'data-browser-spacer';
		toolbar.appendChild(spacer);

		// Panel → composer: the current view (source, table/query, SQL, selected
		// cell) lands in the chat input as a structured reference.
		if (this.options.sessionsPartService) {
			const ask = document.createElement('button');
			ask.className = 'data-browser-button data-browser-ask';
			ask.type = 'button';
			ask.title = '把当前视图作为引用发给 AI';
			ask.setAttribute('aria-label', '问 AI');
			const glyph = document.createElement('span');
			glyph.className = 'codicon codicon-comment-discussion';
			glyph.setAttribute('aria-hidden', 'true');
			ask.appendChild(glyph);
			const label = document.createElement('span');
			label.textContent = '问 AI';
			ask.appendChild(label);
			ask.addEventListener('click', () => {
				const reference = this.composeAskReference();
				if (reference) {
					this.options.sessionsPartService?.insertIntoComposer(reference);
				}
			});
			toolbar.appendChild(ask);
		}

		// The SQL console (P2): an editable strip between toolbar and grid. Runs
		// enter query mode — the same derived-table paging/sorting/filtering as a
		// chat hand-off, behind the same main-side read-only gate.
		this.sqlConsole = document.createElement('div');
		this.sqlConsole.className = 'data-browser-sql';
		this.sqlConsole.hidden = true;
		root.appendChild(this.sqlConsole);
		this.sqlInput = document.createElement('textarea');
		this.sqlInput.className = 'data-browser-sql-input';
		this.sqlInput.rows = 3;
		this.sqlInput.spellcheck = false;
		this.sqlInput.placeholder = '只读 SQL（SELECT …）· ⌘⏎ / Ctrl+Enter 运行';
		this.sqlInput.addEventListener('keydown', event => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				this.runConsoleSql();
			}
		});
		this.sqlConsole.appendChild(this.sqlInput);
		const runSql = document.createElement('button');
		runSql.className = 'data-browser-button data-browser-sql-run';
		runSql.type = 'button';
		runSql.title = '运行（⌘⏎）';
		runSql.setAttribute('aria-label', '运行 SQL');
		const runIcon = document.createElement('span');
		runIcon.className = 'codicon codicon-play';
		runIcon.setAttribute('aria-hidden', 'true');
		runSql.appendChild(runIcon);
		const runLabel = document.createElement('span');
		runLabel.textContent = '运行';
		runSql.appendChild(runLabel);
		runSql.addEventListener('click', () => this.runConsoleSql());
		this.sqlConsole.appendChild(runSql);

		this.gridHost = document.createElement('div');
		this.gridHost.className = 'data-browser-grid';
		root.appendChild(this.gridHost);

		// Result info AND result navigation share the bottom bar (DataGrip-style);
		// the top toolbar stays "what am I looking at + actions" only.
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
		status.appendChild(this.pageSizeSelect);

		this.prevButton = this.createIconButton(status, 'codicon-chevron-left', '上一页');
		this.prevButton.addEventListener('click', () => {
			if (this.page > 0) {
				this.page -= 1;
				void this.runQueryNow();
			}
		});
		this.pageLabel = document.createElement('span');
		this.pageLabel.className = 'data-browser-page';
		status.appendChild(this.pageLabel);
		this.nextButton = this.createIconButton(status, 'codicon-chevron-right', '下一页');
		this.nextButton.addEventListener('click', () => {
			if (this.hasNext) {
				this.page += 1;
				void this.runQueryNow();
			}
		});

		// The panel follows the active session's project; switching projects reloads sources.
		const activeSession = this.options.sessionsService?.activeSession ?? this.options.sessionsPartService?.activeSession;
		if (activeSession) {
			this._register(activeSession.subscribe(() => {
				const projectId = activeSession.get()?.projectId;
				if (projectId !== this.projectId) {
					this.projectId = projectId;
					this.sourcesReady = this.loadSources();
				}
			}));
			this.projectId = activeSession.get()?.projectId;
		}
		// The tab host keeps this view mounted but display:none while another tab
		// is active. Tabulator can't measure a hidden host, so rows built (or kept)
		// while hidden render blank — redraw whenever the host regains real size.
		this.resizeObserver = new ResizeObserver(() => {
			if (this.table && this.gridHost.clientHeight > 0) {
				this.table.redraw(true);
			}
		});
		this.resizeObserver.observe(this.gridHost);

		this.fileProvider = new FileDataProvider(this.options.dataFiles);
		this.sqlProvider = this.options.environmentsService
			? new SqlDataProvider({
					service: this.options.environmentsService,
					getProjectId: () => this.projectId,
					getSource: () => this.selectedSource,
					getTable: () => this.selectedTable,
					getBaseQuery: () => this.baseQuery,
					getEnvironmentName: environmentId => this.environmentNames.get(environmentId),
				})
			: undefined;

		this.updatePager();
		this.sourcesReady = this.loadSources();
	}

	/** Whichever brain currently drives the grid. */
	private get provider(): IDataProvider | undefined {
		return this.fileMode ? this.fileProvider : this.sqlProvider;
	}

	/** The grid's interaction state, in the provider contract's terms. */
	private viewState(): IDataViewState {
		const filters = new Map<number, string>();
		for (const [field, value] of this.columnFilters) {
			filters.set(Number(field.slice(1)), value);
		}
		return { page: this.page, pageSize: this.pageSize, ...(this.sort ? { sort: this.sort } : {}), filters };
	}

	/** Chat → panel hand-off: run the agent's query here and keep exploring it. */
	async applyBrowseRequest(request: ISessionDataBrowse): Promise<void> {
		await this.sourcesReady;
		if (this.fileMode) {
			this.exitFileMode();
			this.renderSelects();
		}
		const source = this.resolveSourceRef(request.source);
		if (!source) {
			this.baseQuery = undefined;
			this.setStatus(`找不到数据源 “${request.source}” — 可能已被删除或不属于当前项目。`, '');
			return;
		}
		this.sourceSelect.value = source.id;
		this.baseQuery = request.sql;
		// The console (opened or not) picks up the hand-off so it's editable.
		this.sqlInput.value = request.sql;
		this.sort = undefined;
		this.page = 0;
		this.columnFilters.clear();
		await this.loadTables(source);
	}

	/** id → label → environment name, first unique match (the agent tools' contract). */
	private resolveSourceRef(ref: string): BrowsableSource | undefined {
		const byId = this.sources.find(source => source.id === ref);
		if (byId) {
			return byId;
		}
		const byLabel = this.sources.filter(source => source.label === ref);
		if (byLabel.length === 1) {
			return byLabel[0];
		}
		const byEnvironment = this.sources.filter(source => this.environmentNames.get(source.environmentId) === ref);
		return byEnvironment.length === 1 ? byEnvironment[0] : undefined;
	}

	override dispose(): void {
		clearTimeout(this.filterDebounce);
		this.resizeObserver.disconnect();
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

	/** Tell the host what we're looking at (`dev·orders`) so the tab chip can say so. */
	private reportContext(): void {
		this.options.onContextChange?.(this.provider?.contextLabel() ?? '数据');
	}

	/** The current view as precise, structured reference text for the composer:
	 *  identity lines come from the provider; position and cell selection are
	 *  renderer-side and appended here. */
	private composeAskReference(): string | undefined {
		if (!this.provider || !this.selectedSource) {
			return undefined;
		}
		const lines = ['引用数据浏览器当前视图：', ...this.provider.referenceLines(this.viewState())];
		lines.push(`- 位置: 第 ${this.page + 1} 页 · 每页 ${this.pageSize} 行`);
		if (this.lastCell) {
			const anchor = this.lastCell.anchor ? `（该行 ${this.lastCell.anchor.column}=${formatReferenceValue(this.lastCell.anchor.value)}）` : '';
			lines.push(`- 选中单元格: ${this.lastCell.column} = ${formatReferenceValue(this.lastCell.value)}${anchor}`);
		}
		return `${lines.join('\n')}\n`;
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
			this.reportContext();
			return;
		}
		await this.onSourceChanged();
	}

	/** User picked a source: table mode, from scratch. */
	private async onSourceChanged(): Promise<void> {
		if (this.sourceSelect.value === FILE_OPTION) {
			return;
		}
		if (this.fileMode) {
			this.exitFileMode();
			this.renderSelects();
			this.sourceSelect.value = this.sourceSelect.value || (this.sources[0]?.id ?? '');
		}
		this.baseQuery = undefined;
		this.sort = undefined;
		this.page = 0;
		this.columnFilters.clear();
		await this.loadTables(this.selectedSource);
	}

	private async loadTables(source: BrowsableSource | undefined): Promise<void> {
		const stamp = ++this.requestStamp;
		this.tables = [];
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
			// Query mode still works without a catalog (e.g. permission-limited
			// information_schema) — only table mode is dead in the water.
			if (this.baseQuery === undefined) {
				this.setStatus(result.message, '');
				return;
			}
		} else {
			this.tables = result.tables;
		}
		this.renderTableOptions();
		this.reportContext();
		if (this.baseQuery === undefined && this.tables.length === 0) {
			this.setStatus('这个数据源里没有可见的表。', '');
			return;
		}
		await this.runQueryNow();
	}

	private onTableChanged(): void {
		if (this.fileMode) {
			const target = this.fileProvider.target;
			if (target && this.tableSelect.value !== this.fileProvider.activeSheet) {
				this.sort = undefined;
				this.page = 0;
				this.columnFilters.clear();
				void this.openFile(target, this.tableSelect.value);
			}
			return;
		}
		if (this.tableSelect.value === QUERY_OPTION) {
			return;
		}
		if (this.baseQuery !== undefined) {
			// Leaving query mode: drop the synthetic option, keep the chosen table.
			const chosen = this.tableSelect.value;
			this.baseQuery = undefined;
			this.renderTableOptions();
			this.tableSelect.value = chosen;
		}
		this.sort = undefined;
		this.page = 0;
		this.columnFilters.clear();
		void this.runQueryNow();
	}

	/** Whether the ACTIVE provider has something to fetch. */
	private hasTarget(): boolean {
		if (this.fileMode) {
			return this.fileProvider.target !== undefined;
		}
		return Boolean(this.projectId && this.selectedSource && (this.baseQuery !== undefined || this.selectedTable));
	}

	/** OS picker → file mode. Re-picking while in file mode just swaps the file. */
	private async pickFile(): Promise<void> {
		const picked = await this.options.dataFiles?.pick();
		if (!picked) {
			return;
		}
		await this.openFile(picked);
	}

	private async openFile(file: IPickedDataFile, sheet?: string): Promise<void> {
		const stamp = ++this.requestStamp;
		this.setStatus('读取文件…', '');
		const result = await this.fileProvider.open(file, sheet);
		if (stamp !== this.requestStamp) {
			return;
		}
		if (!result.ok) {
			this.setStatus(result.message, '');
			return;
		}
		this.enterFileMode();
		await this.runQueryNow();
	}

	/** File mode: the file rides the source dropdown as a synthetic entry, the
	 *  sheet list rides the table dropdown, and the SQL console stands down. */
	private enterFileMode(): void {
		this.fileMode = true;
		this.baseQuery = undefined;
		this.sort = undefined;
		this.page = 0;
		this.columnFilters.clear();
		this.sqlConsole.hidden = true;
		if (this.sqlToggle) {
			this.sqlToggle.disabled = true;
		}
		this.renderSelects();
	}

	private exitFileMode(): void {
		this.fileMode = false;
		this.fileProvider.clear();
		if (this.sqlToggle) {
			this.sqlToggle.disabled = false;
		}
	}

	private async runQueryNow(): Promise<void> {
		const stamp = ++this.requestStamp;
		if (!this.provider || !this.hasTarget()) {
			return;
		}
		this.reportContext();
		const state = this.viewState();
		const description = this.provider.describeQuery(state);
		this.setStatus('查询中…', description);
		const result = await this.provider.fetch(state);
		if (stamp !== this.requestStamp) {
			return;
		}
		if (!result.ok) {
			this.hasNext = false;
			this.resetGrid();
			this.setStatus(result.message, description);
			this.updatePager();
			return;
		}
		this.hasNext = result.hasNext;
		this.buildGrid(result.columns, result.rows);
		this.setStatus(`${result.rows.length} 行${result.hasNext ? '+' : ''}${result.note ? ` / ${result.note}` : ''} · ${result.durationMs}ms`, description);
		this.updatePager();
	}

	private renderSelects(): void {
		this.sourceSelect.textContent = '';
		// An open file rides the source dropdown as a synthetic entry; picking a
		// real database source below leaves file mode.
		if (this.fileMode && this.fileProvider.target) {
			const option = document.createElement('option');
			option.value = FILE_OPTION;
			option.textContent = this.fileProvider.target.name;
			this.sourceSelect.appendChild(option);
		}
		for (const source of this.sources) {
			const option = document.createElement('option');
			option.value = source.id;
			const environmentName = this.environmentNames.get(source.environmentId);
			option.textContent = environmentName ? `${environmentName} · ${source.label}` : source.label;
			this.sourceSelect.appendChild(option);
		}
		this.sourceSelect.disabled = this.sources.length === 0 && !this.fileMode;
		if (this.fileMode) {
			this.sourceSelect.value = FILE_OPTION;
		}
		this.renderTableOptions();
	}

	private renderTableOptions(): void {
		this.tableSelect.textContent = '';
		// File mode: the table dropdown lists the workbook's sheets.
		if (this.fileMode) {
			for (const sheet of this.fileProvider.sheetNames) {
				const option = document.createElement('option');
				option.value = sheet;
				option.textContent = sheet;
				this.tableSelect.appendChild(option);
			}
			this.tableSelect.disabled = this.fileProvider.sheetNames.length <= 1;
			if (this.fileProvider.activeSheet) {
				this.tableSelect.value = this.fileProvider.activeSheet;
			}
			return;
		}
		// Query mode gets a synthetic entry; picking a real table leaves it.
		if (this.baseQuery !== undefined) {
			const option = document.createElement('option');
			option.value = QUERY_OPTION;
			option.textContent = '查询结果';
			this.tableSelect.appendChild(option);
		}
		this.tables.forEach((table, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
			option.textContent = table.estimatedRows !== undefined ? `${qualified}（约 ${table.estimatedRows} 行）` : qualified;
			this.tableSelect.appendChild(option);
		});
		this.tableSelect.disabled = this.tables.length === 0 && this.baseQuery === undefined;
		if (this.baseQuery !== undefined) {
			this.tableSelect.value = QUERY_OPTION;
		}
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

	private buildGrid(columns: readonly IDataColumn[], rows: readonly (readonly unknown[])[]): void {
		this.lastCell = undefined;
		this.gridColumns = columns;
		const data = rows.map(row => Object.fromEntries(row.map((value, index) => [`c${index}`, value])));
		const signature = JSON.stringify(columns);

		// Same column set → replace the data in place: the header (and the filter
		// box the user is typing into) survives, focus intact.
		if (this.table && signature === this.gridSignature) {
			void this.table.replaceData(data).then(() => this.syncSortIndicators());
			return;
		}

		this.gridSignature = signature;
		this.table?.destroy();
		this.gridHost.textContent = '';
		const anchorColumn = columns[0];
		// Capabilities gate the interactions: a provider without server-side sort
		// gets no sort cycling, one without filter gets no filter boxes.
		const canSort = this.provider?.capabilities.sort ?? false;
		const canFilter = this.provider?.capabilities.filter ?? false;
		const definitions: ColumnDefinition[] = columns.map((column, index) => ({
			title: column.name,
			field: `c${index}`,
			headerSort: false,
			// Filter boxes live inside the header — a click there must not cycle the sort.
			headerClick: (event: UIEvent) => {
				if (canSort && (!(event.target instanceof HTMLElement) || !event.target.closest('.tabulator-header-filter'))) {
					this.cycleSort(column.name);
				}
			},
			// The filter UI is Tabulator's; the FILTERING is ours (provider-compiled).
			...(canFilter ? { headerFilter: 'input' as const } : {}),
			headerFilterFunc: () => true,
			...(column.category === 'number' ? { hozAlign: 'right' as const } : {}),
			formatter: (cell: CellComponent) => formatCellValue(cell.getValue(), column.category),
			// Precise coordinates for "问 AI": the clicked cell, anchored by the
			// row's first column so the model can find the exact row.
			cellClick: (_event: UIEvent, cell: CellComponent) => {
				const data = cell.getRow().getData() as Record<string, unknown>;
				this.lastCell = {
					column: column.name,
					value: cell.getValue(),
					...(anchorColumn && index !== 0 ? { anchor: { column: anchorColumn.name, value: data['c0'] } } : {}),
				};
			},
		}));
		this.table = new TabulatorFull(this.gridHost, {
			data,
			columns: definitions,
			layout: 'fitDataFill',
			height: '100%',
			placeholder: '0 行',
		});
		this.table.on('dataFiltering', () => this.scheduleFilterSync());
		this.table.on('tableBuilt', () => {
			// A rebuild (new column set after sort/table change) restores the values
			// the user had typed — they still apply to the query being shown.
			for (const [field, value] of this.columnFilters) {
				this.table?.setHeaderFilterValue(field, value);
			}
			this.syncSortIndicators();
		});
	}

	private toggleSqlConsole(): void {
		this.sqlConsole.hidden = !this.sqlConsole.hidden;
		if (!this.sqlConsole.hidden) {
			// Something editable to start from: the active hand-off query, or the
			// selected table's SELECT.
			if (this.sqlInput.value.trim() === '') {
				const table = this.selectedTable;
				this.sqlInput.value = this.baseQuery ?? (table ? compileSelectAll(table) : '');
			}
			this.sqlInput.focus();
		}
	}

	private runConsoleSql(): void {
		const sql = this.sqlInput.value.trim();
		if (sql === '' || !this.selectedSource) {
			return;
		}
		this.baseQuery = sql;
		this.sort = undefined;
		this.page = 0;
		this.columnFilters.clear();
		this.renderTableOptions();
		void this.runQueryNow();
	}

	/** Debounce typing, then re-query iff the filter set actually changed. */
	private scheduleFilterSync(): void {
		clearTimeout(this.filterDebounce);
		this.filterDebounce = setTimeout(() => {
			if (!this.table) {
				return;
			}
			const next = new Map<string, string>();
			for (const filter of this.table.getHeaderFilters()) {
				const value = typeof filter.value === 'string' ? filter.value.trim() : '';
				if (value !== '' && typeof filter.field === 'string') {
					next.set(filter.field, value);
				}
			}
			const changed = next.size !== this.columnFilters.size || [...next].some(([field, value]) => this.columnFilters.get(field) !== value);
			if (changed) {
				this.columnFilters = next;
				this.page = 0;
				void this.runQueryNow();
			}
		}, 350);
	}

	/** Server-side sort direction, painted onto the live header titles. */
	private syncSortIndicators(): void {
		this.gridColumns.forEach((column, index) => {
			const title = this.gridHost.querySelector<HTMLElement>(`.tabulator-col[tabulator-field="c${index}"] .tabulator-col-title`);
			if (title) {
				title.textContent = this.sort?.column === column.name ? `${column.name} ${this.sort.direction === 'asc' ? '▲' : '▼'}` : column.name;
			}
		});
	}

	private resetGrid(): void {
		this.table?.destroy();
		this.table = undefined;
		this.gridSignature = undefined;
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
export function formatCellValue(value: unknown, category: DataColumnCategory): HTMLElement {
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

/** The console's starting point for a table: its plain SELECT (identifiers unquoted for editability). */
function compileSelectAll(table: IDbTable): string {
	return `SELECT * FROM ${table.schema ? `${table.schema}.` : ''}${table.name}`;
}

/** Cell value → inline reference text (bounded; NULL/dates/objects readable). */
function formatReferenceValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	const text = value instanceof Date ? formatDate(value) : typeof value === 'object' ? safeJson(value) : String(value);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
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
