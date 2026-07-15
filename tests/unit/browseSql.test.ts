/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { compileBrowseSql, compileQueryBrowseSql, quoteIdentifier } from '../../src/sessions/contrib/data/common/browseSql.js';
import { isReadOnlySql } from '../../src/main/agent/dbQuery.js';

test('quoteIdentifier escapes per driver', () => {
	assert.equal(quoteIdentifier('postgres', 'orders'), '"orders"');
	assert.equal(quoteIdentifier('postgres', 'weird"name'), '"weird""name"');
	assert.equal(quoteIdentifier('mysql', 'orders'), '`orders`');
	assert.equal(quoteIdentifier('mysql', 'weird`name'), '`weird``name`');
});

test('compileBrowseSql: plain first page', () => {
	const sql = compileBrowseSql('postgres', { schema: 'public', name: 'orders' }, { pageSize: 100, page: 0 });
	assert.equal(sql, 'SELECT * FROM "public"."orders" LIMIT 101');
});

test('compileBrowseSql: sort + later page (LIMIT asks one row past the page for has-next)', () => {
	const sql = compileBrowseSql('mysql', { schema: 'shop', name: 'orders' }, { pageSize: 50, page: 2, sort: { column: 'created_at', direction: 'desc' } });
	assert.equal(sql, 'SELECT * FROM `shop`.`orders` ORDER BY `created_at` DESC LIMIT 51 OFFSET 100');
});

test('compileBrowseSql output passes the main-side read-only gate for ordinary names', () => {
	for (const sql of [
		compileBrowseSql('postgres', { schema: 'public', name: 'orders' }, { pageSize: 100, page: 0 }),
		compileBrowseSql('mysql', { schema: 's', name: 't' }, { pageSize: 500, page: 9, sort: { column: 'id', direction: 'asc' } }),
		compileBrowseSql('postgres', { schema: 'public', name: 'Order Items' }, { pageSize: 10, page: 0, sort: { column: 'created_at', direction: 'desc' } }),
	]) {
		assert.ok(isReadOnlySql(sql), `gate must accept: ${sql}`);
	}
});

test('hostile identifiers never slip past the gate as writes — they are rejected whole', () => {
	// isReadOnlySql doesn't parse quoting; a name smuggling `;`/DROP makes the
	// whole statement fail the gate (over-rejection, the safe direction). Such
	// a table simply can't be browsed; nothing mutating ever reaches the driver.
	const sql = compileBrowseSql('postgres', { schema: 'public', name: 'x"; DROP TABLE users; --' }, { pageSize: 10, page: 0 });
	assert.equal(isReadOnlySql(sql), false);
});

test('compileQueryBrowseSql wraps an arbitrary read-only query as a paged derived table', () => {
	const base = 'SELECT id, name FROM shop.orders WHERE amount > 100;';
	assert.equal(
		compileQueryBrowseSql('mysql', base, { pageSize: 100, page: 0 }),
		'SELECT * FROM (SELECT id, name FROM shop.orders WHERE amount > 100) AS `_browse` LIMIT 101',
	);
	assert.equal(
		compileQueryBrowseSql('postgres', 'SELECT 1 AS n', { pageSize: 50, page: 2, sort: { column: 'n', direction: 'desc' } }),
		'SELECT * FROM (SELECT 1 AS n) AS "_browse" ORDER BY "n" DESC LIMIT 51 OFFSET 100',
	);
});

test('the wrapped query passes the read-only gate iff the inner one does', () => {
	assert.ok(isReadOnlySql(compileQueryBrowseSql('mysql', 'SELECT * FROM t WHERE x = 1', { pageSize: 10, page: 0 })));
	// A write smuggled in stays rejected — the wrapper adds no laundering.
	assert.equal(isReadOnlySql(compileQueryBrowseSql('mysql', 'DELETE FROM t', { pageSize: 10, page: 0 })), false);
});
