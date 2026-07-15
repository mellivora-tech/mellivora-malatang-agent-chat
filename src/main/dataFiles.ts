/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DataColumnCategory, IDataColumn } from '../sessions/services/environments/common/environments.js';
import { FILE_ROW_CAP } from '../sessions/services/dataFiles/common/dataFiles.js';

/**
 * Pure parsing/typing for local data files (#7 P1). The IPC layer (dataFilesIpc)
 * does dialogs and path gating; everything here is unit-testable.
 */

/** RFC 4180-ish CSV: quoted fields ("" escapes), commas, CR/LF/CRLF newlines. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"') {
			inQuotes = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text[index + 1] === '\n') {
				index++;
			}
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
		} else {
			field += char;
		}
	}
	// Final field/row without a trailing newline.
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	// A trailing empty line is an artifact, not a record.
	while (rows.length > 0 && rows[rows.length - 1]!.every(cell => cell === '')) {
		rows.pop();
	}
	return rows;
}

/** Infer a column's broad category from its first non-empty samples. */
export function inferCategory(samples: readonly unknown[]): DataColumnCategory {
	const values = samples.filter(value => value !== null && value !== undefined && value !== '').slice(0, 50);
	if (values.length === 0) {
		return 'text';
	}
	if (values.every(value => typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())))) {
		return 'number';
	}
	if (values.every(value => typeof value === 'boolean' || (typeof value === 'string' && /^(true|false)$/i.test(value.trim())))) {
		return 'boolean';
	}
	if (values.every(value => value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(value.trim())))) {
		return 'date';
	}
	return 'text';
}

/** Header row + data rows → typed columns. Blank/duplicate headers get positional names. */
export function toTable(grid: readonly (readonly unknown[])[]): { columns: readonly IDataColumn[]; rows: readonly (readonly unknown[])[]; truncated: boolean } {
	const header = grid[0] ?? [];
	const body = grid.slice(1);
	const width = Math.max(header.length, ...body.slice(0, 100).map(row => row.length), 0);
	const seen = new Set<string>();
	const columns: IDataColumn[] = [];
	for (let index = 0; index < width; index++) {
		const raw = header[index];
		let name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : `列${index + 1}`;
		while (seen.has(name)) {
			name = `${name}_${index + 1}`;
		}
		seen.add(name);
		columns.push({ name, category: inferCategory(body.map(row => row[index])) });
	}
	return { columns, rows: body.slice(0, FILE_ROW_CAP), truncated: body.length > FILE_ROW_CAP };
}
