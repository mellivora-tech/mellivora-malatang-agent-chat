/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDatabaseCoordinates, IDataSourceSecret } from '../../sessions/services/environments/common/environments.js';

export interface IQueryResult {
	readonly columns: readonly string[];
	readonly rows: readonly (readonly unknown[])[];
	readonly truncated: boolean;
}

export type DbQueryRunner = (coordinates: IDatabaseCoordinates, secret: IDataSourceSecret | undefined, sql: string, options: { readonly rowLimit: number; readonly signal: AbortSignal }) => Promise<IQueryResult>;

const READONLY_FIRST = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'table', 'values']);
// Any of these as a whole word makes the statement not-a-pure-read — conservative on purpose.
const WRITE_WORDS = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|replace|merge|call|copy|into|set|begin|commit|rollback|savepoint|execute|lock)\b/i;

/**
 * A conservative read-only gate: the statement must be a single SELECT-family
 * query and contain no data-modifying keyword. Over-rejects some valid reads
 * (e.g. an identifier literally named `set`) — the safe direction for a tool the
 * model drives.
 */
export function isReadOnlySql(sql: string): boolean {
	const trimmed = sql.trim().replace(/;+\s*$/, '');
	if (trimmed === '' || trimmed.includes(';')) {
		return false;
	}
	const first = (trimmed.replace(/^[('"\s]+/, '').split(/\s+/)[0] ?? '').toLowerCase();
	if (!READONLY_FIRST.has(first)) {
		return false;
	}
	return !WRITE_WORDS.test(trimmed);
}

async function runPostgres(coordinates: IDatabaseCoordinates, secret: IDataSourceSecret | undefined, sql: string, rowLimit: number, signal: AbortSignal): Promise<IQueryResult> {
	const { Client } = await import('pg');
	const client = new Client({
		host: coordinates.host,
		port: coordinates.port,
		database: coordinates.database,
		...(secret?.username ? { user: secret.username } : {}),
		...(secret?.password ? { password: secret.password } : {}),
		statement_timeout: 15_000,
		connectionTimeoutMillis: 8_000,
	});
	const onAbort = (): void => void client.end().catch(() => {});
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		await client.connect();
		const result = await client.query({ text: sql, rowMode: 'array' });
		const columns = (result.fields ?? []).map(field => field.name);
		const rows = (result.rows as unknown[][]).slice(0, rowLimit);
		return { columns, rows, truncated: result.rows.length > rowLimit };
	} finally {
		signal.removeEventListener('abort', onAbort);
		await client.end().catch(() => {});
	}
}

async function runMysql(coordinates: IDatabaseCoordinates, secret: IDataSourceSecret | undefined, sql: string, rowLimit: number, signal: AbortSignal): Promise<IQueryResult> {
	const mysql = await import('mysql2/promise');
	const connection = await mysql.createConnection({
		host: coordinates.host,
		port: coordinates.port,
		database: coordinates.database,
		...(secret?.username ? { user: secret.username } : {}),
		...(secret?.password ? { password: secret.password } : {}),
		connectTimeout: 8_000,
		rowsAsArray: true,
	});
	const onAbort = (): void => connection.destroy();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		const [rows, fields] = await connection.query(sql);
		const columns = Array.isArray(fields) ? fields.map(field => field.name) : [];
		const all = Array.isArray(rows) ? (rows as unknown[][]) : [];
		return { columns, rows: all.slice(0, rowLimit), truncated: all.length > rowLimit };
	} finally {
		signal.removeEventListener('abort', onAbort);
		await connection.end().catch(() => {});
	}
}

/** Connect (per query) and run a read-only SQL statement. Callers MUST gate with {@link isReadOnlySql} first. */
export const runDbQuery: DbQueryRunner = (coordinates, secret, sql, { rowLimit, signal }) =>
	coordinates.driver === 'postgres' ? runPostgres(coordinates, secret, sql, rowLimit, signal) : runMysql(coordinates, secret, sql, rowLimit, signal);
