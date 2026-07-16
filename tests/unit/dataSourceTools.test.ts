/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IAgentTool } from '../../src/main/agent/agentTypes.js';
import { createDataSourceTools, type IQueryableSource } from '../../src/main/agent/tools/dataSourceTools.js';
import type { DbQueryRunner } from '../../src/main/agent/dbQuery.js';

const SOURCES: IQueryableSource[] = [
	{ id: 'ds-1', label: 'orders', environmentName: 'dev', coordinates: { driver: 'mysql', host: 'h1', port: 3306, database: 'orders' }, writable: true },
	{ id: 'ds-2', label: 'orders', environmentName: 'prod', coordinates: { driver: 'mysql', host: 'h2', port: 3306, database: 'orders' }, writable: false },
	{ id: 'ds-3', label: 'billing', environmentName: 'dev', coordinates: { driver: 'postgres', host: 'h3', port: 5432, database: 'billing' }, writable: true },
];

const context = { toolUseId: 't', signal: new AbortController().signal };

function byName(tools: readonly IAgentTool[], name: string): IAgentTool {
	const tool = tools.find(candidate => candidate.name === name);
	assert.ok(tool, `${name} registered`);
	return tool;
}

async function run(tool: IAgentTool, input: unknown): Promise<{ content: string; isError: boolean }> {
	const validation = tool.validateInput(input);
	assert.ok(validation.ok, `validation failed: ${validation.ok ? '' : validation.error}`);
	const result = await tool.call(validation.value, context);
	return { content: result.content, isError: result.isError ?? false };
}

test('list_data_sources lists the configured databases', async () => {
	const tools = createDataSourceTools({ sources: SOURCES, getSecret: async () => undefined });
	const result = await run(byName(tools, 'list_data_sources'), {});
	assert.match(result.content, /billing/);
	assert.match(result.content, /ds-1/);
	assert.match(result.content, /env: prod/);
});

test('query_data_source resolves a unique label, runs the query, and formats rows', async () => {
	let seen: { host: string; sql: string } | undefined;
	const runQuery: DbQueryRunner = async (coordinates, _secret, sql) => {
		seen = { host: coordinates.host, sql };
		return {
			columns: [
				{ name: 'id', category: 'number' as const },
				{ name: 'name', category: 'text' as const },
			],
			rows: [
				[1, 'a'],
				[2, null],
			],
			truncated: false,
		};
	};
	const tools = createDataSourceTools({ sources: SOURCES, getSecret: async () => ({ username: 'ro' }), runQuery });
	const result = await run(byName(tools, 'query_data_source'), { source: 'billing', sql: 'SELECT id, name FROM t' });
	assert.equal(result.isError, false);
	assert.equal(seen?.host, 'h3');
	assert.match(result.content, /id \| name/);
	assert.match(result.content, /1 \| a/);
	assert.match(result.content, /2 \| NULL/, 'null renders as NULL');
});

test('query_data_source refuses writes, unknown and ambiguous sources', async () => {
	const runQuery: DbQueryRunner = async () => ({ columns: [], rows: [], truncated: false });
	const tools = createDataSourceTools({ sources: SOURCES, getSecret: async () => undefined, runQuery });
	const query = byName(tools, 'query_data_source');

	const write = await run(query, { source: 'billing', sql: 'DELETE FROM t' });
	assert.equal(write.isError, true);
	assert.match(write.content, /read-only/);

	const ambiguous = await run(query, { source: 'orders', sql: 'SELECT 1' });
	assert.equal(ambiguous.isError, true);
	assert.match(ambiguous.content, /ds-1, ds-2/);

	const unknown = await run(query, { source: 'nope', sql: 'SELECT 1' });
	assert.equal(unknown.isError, true);

	// An id disambiguates the duplicate label.
	const byId = await run(query, { source: 'ds-2', sql: 'SELECT 1' });
	assert.equal(byId.isError, false);
});
