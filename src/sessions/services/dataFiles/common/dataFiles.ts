/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDataColumn } from '../../environments/common/environments.js';

/** The panel pages locally over what arrives — cap what a file may ship across IPC. */
export const FILE_ROW_CAP = 20_000;

/** A picked local data file (csv/xlsx), main-side dialog. */
export interface IPickedDataFile {
	readonly path: string;
	readonly name: string;
}

/** One sheet's tabular content, parsed main-side. Row-capped: the panel's
 *  file provider pages/sorts/filters LOCALLY over what arrived. */
export type FileTableResult =
	| {
			readonly ok: true;
			/** All sheet names (csv: a single synthetic one). */
			readonly sheets: readonly string[];
			/** The sheet this result carries. */
			readonly sheet: string;
			readonly columns: readonly IDataColumn[];
			readonly rows: readonly (readonly unknown[])[];
			/** True when the file had more rows than the cap. */
			readonly truncated: boolean;
	  }
	| { readonly ok: false; readonly message: string };

/** The shape exposed on `agentWindow.dataFiles` by the preload script. */
export interface IDataFilesBridge {
	/** OS file picker (csv/xlsx). Resolves undefined when cancelled. */
	pick(): Promise<IPickedDataFile | undefined>;
	/** Parse one sheet of a previously PICKED file (main enforces that). */
	readTable(path: string, sheet?: string): Promise<FileTableResult>;
}
