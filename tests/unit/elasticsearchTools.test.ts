/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createElasticsearchTools, runEsSearch, type EsSearchRunner, type IElasticsearchQueryableSource } from '../../src/main/agent/tools/elasticsearchTools.js';

const source: IElasticsearchQueryableSource = {
	id: 'es-1',
	label: 'orders-es',
	environmentName: 'dev',
	coordinates: { host: '192.168.100.8', port: 9200, index: 'dv_use_location' },
};

function buildTool(runSearch: EsSearchRunner, sources: readonly IElasticsearchQueryableSource[] = [source]) {
	const tools = createElasticsearchTools({ sources, getSecret: async () => ({ username: 'es', password: 'pw' }), runSearch });
	return tools[0];
}

const ctx = { toolUseId: 't', signal: new AbortController().signal };

test('createElasticsearchTools: no ES sources → no tool', () => {
	assert.deepEqual(createElasticsearchTools({ sources: [], getSecret: async () => undefined }), []);
});

test('query_elasticsearch: is read-only and lists its sources in the description', () => {
	const tool = buildTool(async () => ({ total: 0, hits: [] }))!;
	assert.equal(tool.name, 'query_elasticsearch');
	assert.equal(tool.isReadOnly({}), true);
	assert.match(tool.description, /orders-es/);
});

test('query_elasticsearch: a search formats total + hits; size is capped and passed through', async () => {
	let seen: { size: number; index?: string; body?: unknown } | undefined;
	const tool = buildTool(async (_c, _s, params) => {
		seen = params;
		return { total: 9896, hits: [{ id: '000003', source: { locationName: 'x' } }] };
	})!;

	const parsed = tool.validateInput({ source: 'orders-es', body: { query: { match_all: {} } }, size: 999 });
	assert.ok(parsed.ok);
	const result = await tool.call(parsed.value, ctx);
	assert.match(result.content, /total hits: 9896/);
	assert.match(result.content, /_id=000003/);
	assert.equal(seen?.size, 200, 'size is capped at MAX_SIZE');
	assert.deepEqual(seen?.body, { query: { match_all: {} } });
});

test('query_elasticsearch: resolve by id/label/env; unknown and ambiguous are errors', async () => {
	const two: IElasticsearchQueryableSource[] = [source, { ...source, id: 'es-2', label: 'other', environmentName: 'dev' }];
	const tool = buildTool(async () => ({ total: 0, hits: [] }), two)!;

	const unknown = await tool.call({ source: 'nope' }, ctx);
	assert.equal(unknown.isError, true);
	assert.match(unknown.content, /No Elasticsearch source/);

	const ambiguous = await tool.call({ source: 'dev' }, ctx); // two sources share env 'dev'
	assert.equal(ambiguous.isError, true);
	assert.match(ambiguous.content, /ambiguous/);

	const byId = await tool.call({ source: 'es-2' }, ctx);
	assert.equal(byId.isError, undefined, 'a unique id resolves');
});

test('query_elasticsearch: input validation rejects bad body/index/size', () => {
	const tool = buildTool(async () => ({ total: 0, hits: [] }))!;
	assert.equal(tool.validateInput({}).ok, false, 'missing source');
	assert.equal(tool.validateInput({ source: 'x', body: [1, 2] }).ok, false, 'array body');
	assert.equal(tool.validateInput({ source: 'x', body: 'q' }).ok, false, 'string body');
	assert.equal(tool.validateInput({ source: 'x', size: -1 }).ok, false, 'negative size');
	assert.equal(tool.validateInput({ source: 'x' }).ok, true, 'source alone is valid (match_all)');
});

test('query_elasticsearch: a runner failure becomes an explained error result', async () => {
	const tool = buildTool(async () => {
		throw new Error('connect ECONNREFUSED 192.168.100.8:9200');
	})!;
	const result = await tool.call({ source: 'orders-es' }, ctx);
	assert.equal(result.isError, true);
	assert.match(result.content, /query failed/i);
	assert.match(result.content, /refused port 9200/);
});

test('runEsSearch: POSTs to <host>:<port>/<index>/_search with basic auth and the body+size', async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify({ hits: { total: { value: 3 }, hits: [{ _id: 'x', _source: { a: 1 } }] } }), { status: 200 });
	}) as typeof fetch;
	try {
		const result = await runEsSearch(source.coordinates, { username: 'es', password: 'pw' }, { size: 5, body: { query: { term: { id: '1' } } } }, { signal: ctx.signal });
		assert.equal(result.total, 3);
		assert.deepEqual(result.hits, [{ id: 'x', source: { a: 1 } }]);
		assert.equal(calls[0]!.url, 'http://192.168.100.8:9200/dv_use_location/_search');
		assert.match(String((calls[0]!.init.headers as Record<string, string>)['authorization']), /^Basic /);
		assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { query: { term: { id: '1' } }, size: 5 });
	} finally {
		globalThis.fetch = original;
	}
});

test('runEsSearch: a non-2xx response throws with the status and body', async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response('{"error":"index_not_found_exception"}', { status: 404 })) as typeof fetch;
	try {
		await assert.rejects(() => runEsSearch(source.coordinates, undefined, { size: 1 }, { signal: ctx.signal }), /404.*index_not_found/);
	} finally {
		globalThis.fetch = original;
	}
});
