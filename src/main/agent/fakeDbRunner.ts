/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DbQueryRunner, IQueryResult } from './dbQuery.js';

/**
 * E2E-only stand-in for the real database drivers, active only when the app is
 * launched with MELLIVORA_FAKE_DB=1 (see environmentsIpc.ts). Everything above
 * this seam — preload bridge, IPC, read-only gate, row caps, the browse panel —
 * runs for real; only the TCP connection to a database is skipped. It answers
 * the two catalog queries and any browse SELECT with a deterministic dataset.
 */

const TOTAL_ROWS = 120;

const DATASET = Array.from({ length: TOTAL_ROWS }, (_, index) => [
	index + 1,
	`item-${String(index + 1).padStart(3, '0')}`,
	index % 3 === 0 ? null : (index + 1) * 10,
	new Date(Date.UTC(2026, 0, 1 + (index % 28), 12)),
] as const);

export const fakeDbRunner: DbQueryRunner = async (_coordinates, _secret, sql, { rowLimit }) => {
	if (sql.includes('pg_class') || sql.includes('information_schema.tables')) {
		return {
			columns: [
				{ name: 'schema', category: 'text' },
				{ name: 'name', category: 'text' },
				{ name: 'rows', category: 'number' },
			],
			rows: [
				['shop', 'orders', TOTAL_ROWS],
				['shop', 'users', 7],
			],
			truncated: false,
		} satisfies IQueryResult;
	}

	const descending = /ORDER BY .*DESC/i.test(sql);
	const sortColumn = /ORDER BY [`"](\w+)[`"]/i.exec(sql)?.[1];
	const offset = Number(/OFFSET (\d+)/i.exec(sql)?.[1] ?? 0);
	let rows: (readonly unknown[])[] = [...DATASET];
	if (sortColumn) {
		const index = ['id', 'name', 'amount', 'created_at'].indexOf(sortColumn);
		if (index >= 0) {
			rows.sort((a, b) => {
				const left = a[index] ?? null;
				const right = b[index] ?? null;
				if (left === null || right === null) {
					return left === right ? 0 : left === null ? -1 : 1;
				}
				return left < right ? -1 : left > right ? 1 : 0;
			});
		}
	}
	if (descending) {
		rows.reverse();
	}
	rows = rows.slice(offset);
	return {
		columns: [
			{ name: 'id', category: 'number' },
			{ name: 'name', category: 'text' },
			{ name: 'amount', category: 'number' },
			{ name: 'created_at', category: 'date' },
		],
		rows: rows.slice(0, rowLimit),
		truncated: rows.length > rowLimit,
	};
};
