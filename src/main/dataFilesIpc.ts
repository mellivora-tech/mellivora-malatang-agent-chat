/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import type { FileTableResult, IPickedDataFile } from '../sessions/services/dataFiles/common/dataFiles.js';
import { parseCsv, toTable } from './dataFiles.js';

/** csv single-sheet placeholder name. */
const CSV_SHEET = '数据';

/**
 * Local data files for the panel's file provider (#7 P1). readTable only ever
 * parses paths the user PICKED this process (or the MELLIVORA_PICK_FILE e2e
 * seam) — the renderer can't point main at arbitrary files.
 */
export function registerDataFilesIpc(dataRoot: string): void {
	const pickedPaths = new Set<string>();
	// Agent-rendered tables live in the app's data dir (session media) — always
	// readable, so a "在数据浏览器打开" chip still works after a restart.
	const insideDataRoot = (path: string): boolean => {
		const resolved = resolve(path);
		const base = resolve(dataRoot);
		return resolved === base || resolved.startsWith(base + sep);
	};

	ipcMain.handle('dataFiles:pick', async (): Promise<IPickedDataFile | undefined> => {
		// E2E seam: dialogs can't be driven headlessly — the env var IS the pick.
		const seeded = process.env['MELLIVORA_PICK_FILE'];
		if (seeded) {
			pickedPaths.add(seeded);
			return { path: seeded, name: basename(seeded) };
		}
		const result = await dialog.showOpenDialog({
			properties: ['openFile'],
			filters: [{ name: '数据文件', extensions: ['csv', 'tsv', 'xlsx', 'xls'] }],
		});
		const path = result.filePaths[0];
		if (result.canceled || !path) {
			return undefined;
		}
		pickedPaths.add(path);
		return { path, name: basename(path) };
	});

	ipcMain.handle('dataFiles:readTable', async (_event, path: string, sheet?: string): Promise<FileTableResult> => {
		if (typeof path !== 'string' || (!pickedPaths.has(path) && !insideDataRoot(path))) {
			return { ok: false, message: '文件未经选择器打开。' };
		}
		try {
			return await readTable(path, sheet);
		} catch (error) {
			return { ok: false, message: `读取失败: ${error instanceof Error ? error.message : String(error)}` };
		}
	});
}

async function readTable(path: string, sheet?: string): Promise<FileTableResult> {
	const extension = extname(path).toLowerCase();
	if (extension === '.csv' || extension === '.tsv') {
		let text = await readFile(path, 'utf8');
		if (text.charCodeAt(0) === 0xfeff) {
			text = text.slice(1);
		}
		const grid = parseCsv(extension === '.tsv' ? text.replaceAll('\t', ',') : text);
		const table = toTable(grid);
		return { ok: true, sheets: [CSV_SHEET], sheet: CSV_SHEET, ...table };
	}
	if (extension === '.xlsx' || extension === '.xls') {
		// Lazy import: SheetJS is sizable and only file-table reads need it.
		const XLSX = await import('xlsx');
		const workbook = XLSX.read(await readFile(path), { type: 'buffer', cellDates: true });
		const sheets = workbook.SheetNames;
		const active = sheet && sheets.includes(sheet) ? sheet : sheets[0];
		if (!active) {
			return { ok: false, message: '这个工作簿里没有工作表。' };
		}
		const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[active]!, { header: 1, defval: null }) as unknown[][];
		const table = toTable(grid);
		return { ok: true, sheets, sheet: active, ...table };
	}
	return { ok: false, message: `不支持的文件格式: ${extension || '(无扩展名)'}` };
}
