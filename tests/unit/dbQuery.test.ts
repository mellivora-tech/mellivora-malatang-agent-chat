/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { isReadOnlySql, listDbTables, mysqlColumnCategory, pgColumnCategory, type DbQueryRunner } from '../../src/main/agent/dbQuery.js';
import type { IDatabaseCoordinates } from '../../src/sessions/services/environments/common/environments.js';

test('isReadOnlySql allows read-only statements', () => {
	for (const ok of ['SELECT 1', '  select * from orders where id = 1', 'WITH a AS (SELECT 1) SELECT * FROM a', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'SELECT count(*) FROM t;']) {
		assert.ok(isReadOnlySql(ok), `should allow: ${ok}`);
	}
});

test('isReadOnlySql rejects writes, multi-statements, and empties', () => {
	for (const bad of [
		'UPDATE t SET x = 1',
		'DELETE FROM t',
		'DROP TABLE t',
		'INSERT INTO t VALUES (1)',
		'TRUNCATE t',
		'SELECT 1; DROP TABLE t',
		'WITH x AS (DELETE FROM t RETURNING *) SELECT 1',
		'SELECT * INTO backup FROM orders',
		'SELECT * FROM t FOR UPDATE',
		'',
		'   ',
	]) {
		assert.equal(isReadOnlySql(bad), false, `should reject: ${bad}`);
	}
});

test('pg / mysql type codes normalize to broad column categories', () => {
	// pg OIDs: int4 / numeric / bool / timestamptz / jsonb / varchar-ish fallback
	assert.equal(pgColumnCategory(23), 'number');
	assert.equal(pgColumnCategory(1700), 'number');
	assert.equal(pgColumnCategory(16), 'boolean');
	assert.equal(pgColumnCategory(1184), 'date');
	assert.equal(pgColumnCategory(3802), 'json');
	assert.equal(pgColumnCategory(1043), 'text');
	// mysql codes: LONG / NEWDECIMAL / DATETIME / JSON / VARCHAR fallback / unknown
	assert.equal(mysqlColumnCategory(3), 'number');
	assert.equal(mysqlColumnCategory(246), 'number');
	assert.equal(mysqlColumnCategory(12), 'date');
	assert.equal(mysqlColumnCategory(245), 'json');
	assert.equal(mysqlColumnCategory(253), 'text');
	assert.equal(mysqlColumnCategory(-1), 'text');
});

const PG_COORDS: IDatabaseCoordinates = { driver: 'postgres', host: 'h', port: 5432, database: 'db' };
const MYSQL_COORDS: IDatabaseCoordinates = { driver: 'mysql', host: 'h', port: 3306, database: 'db' };

test('listDbTables maps catalog rows to tables with optional row estimates', async () => {
	let seenSql = '';
	const runQuery: DbQueryRunner = async (_c, _s, sql) => {
		seenSql = sql;
		return {
			columns: [],
			rows: [['public', 'orders', '1523'], ['public', 'users', null], ['sales', 'q1_view', 0]],
			truncated: false,
		};
	};
	const tables = await listDbTables(PG_COORDS, undefined, { signal: new AbortController().signal, runQuery });
	assert.match(seenSql, /pg_class/);
	assert.deepEqual(tables, [
		{ schema: 'public', name: 'orders', estimatedRows: 1523 },
		{ schema: 'public', name: 'users' },
		{ schema: 'sales', name: 'q1_view', estimatedRows: 0 },
	]);
});

test('listDbTables picks the information_schema query for mysql', async () => {
	let seenSql = '';
	const runQuery: DbQueryRunner = async (_c, _s, sql) => {
		seenSql = sql;
		return { columns: [], rows: [], truncated: false };
	};
	await listDbTables(MYSQL_COORDS, undefined, { signal: new AbortController().signal, runQuery });
	assert.match(seenSql, /information_schema\.tables/);
	assert.match(seenSql, /DATABASE\(\)/);
});
