/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FILE_ROW_CAP, type FileTableResult, type IDataFilesBridge, type IPickedDataFile } from '../../../services/dataFiles/common/dataFiles.js';
import type { IDataColumn } from '../../../services/environments/common/environments.js';
import type { DataFetchResult, IDataProvider, IDataViewState } from '../common/dataProvider.js';
import { sliceLocalData } from '../common/localData.js';

/**
 * Provider #2 (#7 P1): local csv/xlsx files. Main parses the file once (row-
 * capped); paging, sorting, and the SAME header-filter grammar all evaluate
 * locally over the in-memory dataset — no round-trips per interaction.
 */
export class FileDataProvider implements IDataProvider {
	readonly capabilities = { sort: true, filter: true, pager: true } as const;

	private file: IPickedDataFile | undefined;
	private sheets: readonly string[] = [];
	private sheet: string | undefined;
	private columns: readonly IDataColumn[] = [];
	private allRows: readonly (readonly unknown[])[] = [];
	private truncated = false;

	constructor(private readonly bridge: IDataFilesBridge | undefined) {}

	/** The open file, if any — the panel keys its mode off this. */
	get target(): IPickedDataFile | undefined {
		return this.file;
	}

	get sheetNames(): readonly string[] {
		return this.sheets;
	}

	get activeSheet(): string | undefined {
		return this.sheet;
	}

	/** Parse (or re-parse) a sheet; on success the provider holds the dataset. */
	async open(file: IPickedDataFile, sheet?: string): Promise<FileTableResult> {
		if (!this.bridge) {
			return { ok: false, message: '文件桥不可用。' };
		}
		const result = await this.bridge.readTable(file.path, sheet);
		if (result.ok) {
			this.file = file;
			this.sheets = result.sheets;
			this.sheet = result.sheet;
			this.columns = result.columns;
			this.allRows = result.rows;
			this.truncated = result.truncated;
		}
		return result;
	}

	clear(): void {
		this.file = undefined;
		this.sheets = [];
		this.sheet = undefined;
		this.columns = [];
		this.allRows = [];
		this.truncated = false;
	}

	fetch(state: IDataViewState): Promise<DataFetchResult> {
		if (!this.file) {
			return Promise.resolve({ ok: false, message: '没有打开的文件。' });
		}
		const started = Date.now();
		const { rows, hasNext, totalMatched } = sliceLocalData(this.columns, this.allRows, state, sort => this.columns.findIndex(column => column.name === sort.column));
		return Promise.resolve({
			ok: true,
			columns: this.columns,
			rows,
			hasNext,
			durationMs: Date.now() - started,
			note: `共 ${totalMatched} 行${this.truncated ? `（仅加载前 ${FILE_ROW_CAP} 行）` : ''}`,
		});
	}

	describeQuery(): string {
		if (!this.file) {
			return '';
		}
		return this.sheets.length > 1 ? `${this.file.path} · ${this.sheet}` : this.file.path;
	}

	contextLabel(): string {
		if (!this.file) {
			return '数据';
		}
		return this.sheets.length > 1 ? `${this.file.name}·${this.sheet}` : this.file.name;
	}

	referenceLines(): readonly string[] {
		if (!this.file) {
			return [];
		}
		const lines = [`- 文件: ${this.file.path}`];
		if (this.sheets.length > 1) {
			lines.push(`- 工作表: ${this.sheet}`);
		}
		lines.push(`- 共 ${this.allRows.length} 行${this.truncated ? `（文件更长，仅加载前 ${FILE_ROW_CAP} 行）` : ''}`);
		return lines;
	}
}
