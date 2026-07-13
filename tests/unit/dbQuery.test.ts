/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { isReadOnlySql } from '../../src/main/agent/dbQuery.js';

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
