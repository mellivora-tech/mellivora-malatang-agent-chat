/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DataColumnCategory, IDatabaseCoordinates, IDataSourceSecret, IDataColumn, IDbTable } from '../../sessions/services/environments/common/environments.js';

export interface IQueryResult {
	readonly columns: readonly IDataColumn[];
	readonly rows: readonly (readonly unknown[])[];
	readonly truncated: boolean;
}

export type DbQueryRunner = (
	coordinates: IDatabaseCoordinates,
	secret: IDataSourceSecret | undefined,
	sql: string,
	options: { readonly rowLimit: number; readonly signal: AbortSignal },
) => Promise<IQueryResult>;

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

/** Exactly one statement (a trailing semicolon is fine) — scripts are refused so each approved write is one auditable statement. */
export function isSingleStatement(sql: string): boolean {
	const trimmed = sql.trim().replace(/;+\s*$/, '');
	return trimmed !== '' && !trimmed.includes(';');
}

// Postgres type OIDs → broad category. Anything unlisted renders as text — safe default.
const PG_NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const PG_DATE_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);
const PG_JSON_OIDS = new Set([114, 3802]);

/** Broad category for a Postgres `dataTypeID` (exported for tests). */
export function pgColumnCategory(dataTypeID: number): DataColumnCategory {
	if (PG_NUMBER_OIDS.has(dataTypeID)) {
		return 'number';
	}
	if (dataTypeID === 16) {
		return 'boolean';
	}
	if (PG_DATE_OIDS.has(dataTypeID)) {
		return 'date';
	}
	if (PG_JSON_OIDS.has(dataTypeID)) {
		return 'json';
	}
	return 'text';
}

// mysql2 field type codes (protocol enum) → broad category. BIT and TINY stay
// number: TINY(1) is often a de-facto boolean but the display length isn't
// reliably present, and a misrendered number beats a misrendered boolean.
const MYSQL_NUMBER_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 16, 246]);
const MYSQL_DATE_TYPES = new Set([7, 10, 11, 12, 14]);

/** Broad category for a mysql2 field type code (exported for tests). */
export function mysqlColumnCategory(type: number): DataColumnCategory {
	if (MYSQL_NUMBER_TYPES.has(type)) {
		return 'number';
	}
	if (MYSQL_DATE_TYPES.has(type)) {
		return 'date';
	}
	if (type === 245) {
		return 'json';
	}
	return 'text';
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
		const columns = (result.fields ?? []).map(field => ({ name: field.name, category: pgColumnCategory(field.dataTypeID) }));
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
		const columns = Array.isArray(fields) ? fields.map(field => ({ name: field.name, category: mysqlColumnCategory(field.type ?? -1) })) : [];
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

export interface IWriteResult {
	/** Rows the statement reported as affected (0 for DDL). */
	readonly affectedRows: number;
}

export type DbWriteRunner = (
	coordinates: IDatabaseCoordinates,
	secret: IDataSourceSecret | undefined,
	sql: string,
	options: { readonly signal: AbortSignal },
) => Promise<IWriteResult>;

async function writePostgres(coordinates: IDatabaseCoordinates, secret: IDataSourceSecret | undefined, sql: string, signal: AbortSignal): Promise<IWriteResult> {
	const { Client } = await import('pg');
	const client = new Client({
		host: coordinates.host,
		port: coordinates.port,
		database: coordinates.database,
		...(secret?.username ? { user: secret.username } : {}),
		...(secret?.password ? { password: secret.password } : {}),
		statement_timeout: 60_000,
		connectionTimeoutMillis: 8_000,
	});
	const onAbort = (): void => void client.end().catch(() => {});
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		await client.connect();
		const result = await client.query(sql);
		return { affectedRows: result.rowCount ?? 0 };
	} finally {
		signal.removeEventListener('abort', onAbort);
		await client.end().catch(() => {});
	}
}

async function writeMysql(coordinates: IDatabaseCoordinates, secret: IDataSourceSecret | undefined, sql: string, signal: AbortSignal): Promise<IWriteResult> {
	const mysql = await import('mysql2/promise');
	const connection = await mysql.createConnection({
		host: coordinates.host,
		port: coordinates.port,
		database: coordinates.database,
		...(secret?.username ? { user: secret.username } : {}),
		...(secret?.password ? { password: secret.password } : {}),
		connectTimeout: 8_000,
	});
	const onAbort = (): void => connection.destroy();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		const [result] = await connection.query(sql);
		const affected = (result as { affectedRows?: number }).affectedRows;
		return { affectedRows: typeof affected === 'number' ? affected : 0 };
	} finally {
		signal.removeEventListener('abort', onAbort);
		await connection.end().catch(() => {});
	}
}

/**
 * The app's ONLY write path to a database. Sole caller: the
 * `execute_data_source` tool, which (a) is approval-gated per statement —
 * deriveGrant has no entry for it, so it can never be "always allowed" — and
 * (b) refuses sources that are not effectively writable (env writable ∧
 * account read-write). Everything else in the app stays behind
 * {@link isReadOnlySql}; do not add callers.
 */
export const runDbWrite: DbWriteRunner = (coordinates, secret, sql, { signal }) =>
	coordinates.driver === 'postgres' ? writePostgres(coordinates, secret, sql, signal) : writeMysql(coordinates, secret, sql, signal);

// Catalog queries are composed HERE (never from user input) — they bypass the
// isReadOnlySql gate by construction. reltuples/table_rows are planner estimates;
// negative/absent means the engine hasn't analyzed the table.
const PG_TABLES_SQL = `
	SELECT n.nspname, c.relname, CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END
	FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
	ORDER BY n.nspname, c.relname`;
const MYSQL_TABLES_SQL = `
	SELECT table_schema, table_name, table_rows
	FROM information_schema.tables WHERE table_schema = DATABASE()
	ORDER BY table_name`;

const TABLE_LIST_LIMIT = 2000;

function asEstimatedRows(value: unknown): number | undefined {
	const parsed = typeof value === 'string' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** List tables and views of a database data source, with row estimates where the engine knows them. */
export async function listDbTables(
	coordinates: IDatabaseCoordinates,
	secret: IDataSourceSecret | undefined,
	options: { readonly signal: AbortSignal; readonly runQuery?: DbQueryRunner },
): Promise<readonly IDbTable[]> {
	const run = options.runQuery ?? runDbQuery;
	const sql = coordinates.driver === 'postgres' ? PG_TABLES_SQL : MYSQL_TABLES_SQL;
	const result = await run(coordinates, secret, sql, { rowLimit: TABLE_LIST_LIMIT, signal: options.signal });
	return result.rows.map(row => {
		const estimatedRows = asEstimatedRows(row[2]);
		return {
			schema: String(row[0] ?? ''),
			name: String(row[1] ?? ''),
			...(estimatedRows !== undefined ? { estimatedRows } : {}),
		};
	});
}
