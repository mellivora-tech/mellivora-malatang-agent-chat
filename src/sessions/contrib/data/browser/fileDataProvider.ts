/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../common/i18n/i18n.js';
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
			return { ok: false, message: localize('data.noFileBridge') };
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
			return Promise.resolve({ ok: false, message: localize('data.noFile') });
		}
		const started = Date.now();
		const { rows, hasNext, totalMatched } = sliceLocalData(this.columns, this.allRows, state, sort => this.columns.findIndex(column => column.name === sort.column));
		return Promise.resolve({
			ok: true,
			columns: this.columns,
			rows,
			hasNext,
			durationMs: Date.now() - started,
			note: localize('data.fileRows', totalMatched, this.truncated ? localize('data.fileRowsCapNote', FILE_ROW_CAP) : ''),
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
			return localize('data.tabFallback');
		}
		return this.sheets.length > 1 ? `${this.file.name}·${this.sheet}` : this.file.name;
	}

	referenceLines(): readonly string[] {
		if (!this.file) {
			return [];
		}
		const lines = [localize('data.ref.file', this.file.path)];
		if (this.sheets.length > 1) {
			lines.push(localize('data.ref.sheet', this.sheet ?? ''));
		}
		lines.push(localize('data.ref.fileRows', this.allRows.length, this.truncated ? localize('data.fileLongerNote', FILE_ROW_CAP) : ''));
		return lines;
	}
}
