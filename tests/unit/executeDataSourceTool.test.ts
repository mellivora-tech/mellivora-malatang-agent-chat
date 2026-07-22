/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecuteDataSourceTool } from '../../src/main/agent/tools/executeDataSourceTool.js';
import type { IQueryableSource } from '../../src/main/agent/tools/dataSourceTools.js';
import type { DbWriteRunner } from '../../src/main/agent/dbQuery.js';
import { isSingleStatement } from '../../src/main/agent/dbQuery.js';
import { createGateForMode } from '../../src/main/agent/permission.js';

const SOURCES: IQueryableSource[] = [
	{ id: 'ds-dev', label: 'orders', environmentName: 'dev', coordinates: { driver: 'mysql', host: 'h1', port: 3306, database: 'orders' }, writable: true },
	{ id: 'ds-prod', label: 'orders-prod', environmentName: 'prod', coordinates: { driver: 'mysql', host: 'h2', port: 3306, database: 'orders' }, writable: false },
];

const context = { toolUseId: 't', signal: new AbortController().signal };

test('execute_data_source writes to a writable source and reports affected rows', async () => {
	let seen: { host: string; sql: string } | undefined;
	const runWrite: DbWriteRunner = async (coordinates, _secret, sql) => {
		seen = { host: coordinates.host, sql };
		return { affectedRows: 42 };
	};
	const tool = createExecuteDataSourceTool({ sources: SOURCES, getSecret: async () => ({ username: 'rw' }), runWrite });

	const validation = tool.validateInput({ source: 'orders', sql: "INSERT INTO t (a) SELECT b FROM s WHERE b <> '';" });
	assert.ok(validation.ok);
	const result = await tool.call(validation.value, context);
	assert.equal(result.isError ?? false, false);
	assert.equal(seen?.host, 'h1');
	assert.match(result.content, /42 row\(s\) affected/);
});

test('execute_data_source is mutation-class: not read-only, denied by the plan gate, asks in ask mode', async () => {
	const runWrite: DbWriteRunner = async () => ({ affectedRows: 0 });
	const tool = createExecuteDataSourceTool({ sources: SOURCES, getSecret: async () => undefined, runWrite });
	assert.equal(tool.isReadOnly({}), false, 'must never claim read-only — approval hinges on this');

	const planGate = createGateForMode('plan', async () => ({ approved: true }));
	const denied = await planGate.check(tool, { source: 'orders', sql: 'DELETE FROM t' }, context);
	assert.equal(denied.behavior, 'deny', 'plan gate denies even if approval would say yes');

	let asked = 0;
	const askGate = createGateForMode('ask', async () => {
		asked += 1;
		return { approved: true };
	});
	const allowed = await askGate.check(tool, { source: 'orders', sql: 'DELETE FROM t' }, context);
	assert.equal(allowed.behavior, 'allow');
	assert.equal(asked, 1, 'ask mode routes through user approval');

	const autoEditGate = createGateForMode('auto-edit', async () => {
		asked += 1;
		return { approved: true };
	});
	await autoEditGate.check(tool, { source: 'orders', sql: 'DELETE FROM t' }, context);
	assert.equal(asked, 2, 'auto-edit still asks — writes are not in AUTO_EDIT_TOOLS');
});

test('execute_data_source refuses protected sources unconditionally — approval cannot override', async () => {
	let writes = 0;
	const runWrite: DbWriteRunner = async () => {
		writes += 1;
		return { affectedRows: 1 };
	};
	const tool = createExecuteDataSourceTool({ sources: SOURCES, getSecret: async () => undefined, runWrite });

	const validation = tool.validateInput({ source: 'orders-prod', sql: 'UPDATE t SET a = 1' });
	assert.ok(validation.ok);
	const result = await tool.call(validation.value, context);
	assert.equal(result.isError, true);
	assert.match(result.content, /read-only/);
	assert.equal(writes, 0, 'the runner is never reached');
});

test('execute_data_source refuses scripts, read-only statements, and unknown sources', async () => {
	const runWrite: DbWriteRunner = async () => ({ affectedRows: 0 });
	const tool = createExecuteDataSourceTool({ sources: SOURCES, getSecret: async () => undefined, runWrite });

	const script = tool.validateInput({ source: 'orders', sql: 'DELETE FROM a; DELETE FROM b' });
	assert.equal(script.ok, false, 'multi-statement scripts refused at validation');
	assert.match(!script.ok ? script.error : '', /one SQL statement/);

	const readValidation = tool.validateInput({ source: 'orders', sql: 'SELECT 1' });
	assert.ok(readValidation.ok);
	const read = await tool.call(readValidation.value, context);
	assert.equal(read.isError, true);
	assert.match(read.content, /query_data_source/, 'reads are redirected to the read tool');

	const unknownValidation = tool.validateInput({ source: 'ghost', sql: 'DELETE FROM t' });
	assert.ok(unknownValidation.ok);
	const unknown = await tool.call(unknownValidation.value, context);
	assert.equal(unknown.isError, true);
	assert.match(unknown.content, /list_data_sources/);
});

test('isSingleStatement: trailing semicolon fine, embedded one refused, blank refused', () => {
	assert.equal(isSingleStatement('UPDATE t SET a = 1;'), true);
	assert.equal(isSingleStatement('UPDATE t SET a = 1;;  '), true);
	assert.equal(isSingleStatement('UPDATE a; UPDATE b'), false);
	assert.equal(isSingleStatement('   '), false);
});
