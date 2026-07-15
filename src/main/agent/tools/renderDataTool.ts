/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, valid } from './workspace.js';
export { RENDERED_TABLE_MARKER } from '../../../sessions/services/sessions/common/session.js';

/**
 * `render_data` (#7 P3): the agent pushes ANY tabular data — parsed files,
 * computed aggregations, cross-source joins — into the user-facing data panel.
 * The rows land as a csv in the session's media dir (bytes beside the
 * transcript, never inside it) and the step gets an "在数据浏览器打开" chip;
 * the model's context carries only a confirmation, not the rows.
 */

const ROW_CAP = 5000;
const COLUMN_CAP = 100;

export interface IRenderDataDeps {
	/** Persist the csv beside the transcript; resolves to its absolute path and display name. */
	storeCsv(title: string, csv: string): Promise<{ readonly path: string; readonly name: string }>;
}

export function createRenderDataTool(deps: IRenderDataDeps): IAgentTool {
	return defineTool({
		name: 'render_data',
		description:
			'Render tabular data in the user-facing data panel (a grid with paging, sorting and filtering). Use it whenever rows are worth SHOWING the user — parsed files, computed tables, aggregated results from any source. After rendering, do NOT repeat the rows in your reply: give the takeaway and point at the panel.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short table name shown to the user (e.g. "订单汇总").' },
				columns: { type: 'array', items: { type: 'string' }, description: 'Column names, in order.' },
				rows: { type: 'array', items: { type: 'array' }, description: 'Row-major cell values matching the columns.' },
			},
			required: ['columns', 'rows'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			const columns = record['columns'];
			const rows = record['rows'];
			if (!Array.isArray(columns) || columns.length === 0 || !columns.every(name => typeof name === 'string' && name.trim() !== '')) {
				return invalid('columns must be a non-empty array of names');
			}
			if (columns.length > COLUMN_CAP) {
				return invalid(`too many columns (max ${COLUMN_CAP})`);
			}
			if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row))) {
				return invalid('rows must be an array of arrays');
			}
			if (rows.length > ROW_CAP) {
				return invalid(`too many rows (max ${ROW_CAP}) — aggregate or filter before rendering`);
			}
			return valid({ title: typeof record['title'] === 'string' && record['title'].trim() !== '' ? record['title'].trim() : undefined, columns, rows });
		},
		call: async input => {
			const { title, columns, rows } = input as { title?: string; columns: string[]; rows: unknown[][] };
			const csv = toCsv(columns, rows);
			const stored = await deps.storeCsv(title ?? 'table', csv);
			return {
				content: `已渲染 ${rows.length} 行 × ${columns.length} 列到数据面板（${stored.name}）。用户可以在面板中翻页、排序、过滤——不要在回复中重复这些数据行。\n[table:${stored.path}]`,
			};
		},
	});
}

/** RFC 4180 serialization — the exact inverse of parseCsv. */
export function toCsv(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
	const line = (cells: readonly unknown[]): string => cells.map(formatCsvCell).join(',');
	return [line(columns), ...rows.map(line)].join('\n');
}

function formatCsvCell(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
