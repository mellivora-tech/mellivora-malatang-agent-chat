/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IElasticsearchCoordinates, IDataSourceSecret } from '../../../sessions/services/environments/common/environments.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, requireString, valid } from './workspace.js';

/**
 * The `query_elasticsearch` tool (#21 W3): a READ-ONLY window onto configured
 * Elasticsearch data sources, filling the gap that sent the run-6 diagnosis
 * hand-rolling curl/python (an ES index was a first-class `kind` in config but
 * had no agent query path, unlike SQL's query_data_source). The tool only ever
 * issues `_search` — it cannot write, delete, or reindex, so it is read-only by
 * construction, not by inspecting a query string.
 */

const DEFAULT_SIZE = 20;
const MAX_SIZE = 200;
const MAX_HITS_CHARS = 12_000;

/** An Elasticsearch data source the agent may query (secret fetched per call). */
export interface IElasticsearchQueryableSource {
	readonly id: string;
	readonly label: string;
	readonly environmentName: string;
	readonly coordinates: IElasticsearchCoordinates;
}

export interface IEsSearchParams {
	/** Index to search; defaults to the source's configured index, or all indices when both are empty. */
	readonly index?: string;
	/** The ES query DSL body ({ query, aggs, sort, _source, … }); empty = match_all. */
	readonly body?: Record<string, unknown>;
	readonly size: number;
}

export interface IEsSearchResult {
	readonly total: number;
	readonly hits: readonly { readonly id: string; readonly source: unknown }[];
	/** aggregations passthrough, when the body asked for them. */
	readonly aggregations?: unknown;
}

export type EsSearchRunner = (
	coordinates: IElasticsearchCoordinates,
	secret: IDataSourceSecret | undefined,
	params: IEsSearchParams,
	options: { signal: AbortSignal },
) => Promise<IEsSearchResult>;

export interface IElasticsearchToolDeps {
	readonly sources: readonly IElasticsearchQueryableSource[];
	getSecret(dataSourceId: string): Promise<IDataSourceSecret | undefined>;
	/** Injectable for tests; defaults to the real fetch-backed runner. */
	readonly runSearch?: EsSearchRunner;
}

function describe(source: IElasticsearchQueryableSource): string {
	const c = source.coordinates;
	return `- ${source.label} (env: ${source.environmentName}, ${c.host}:${c.port}${c.index ? `/${c.index}` : ' [no default index]'}, id: ${source.id})`;
}

/** id → label → environment name, first unique match wins (same contract as the SQL tools). */
export function resolveEsSource(sources: readonly IElasticsearchQueryableSource[], source: string): IElasticsearchQueryableSource | IElasticsearchQueryableSource[] | undefined {
	const byId = sources.find(candidate => candidate.id === source);
	if (byId) {
		return byId;
	}
	const byLabel = sources.filter(candidate => candidate.label === source);
	if (byLabel.length > 0) {
		return byLabel.length === 1 ? byLabel[0] : byLabel;
	}
	const byEnvironment = sources.filter(candidate => candidate.environmentName === source);
	return byEnvironment.length === 1 ? byEnvironment[0] : byEnvironment.length > 1 ? byEnvironment : undefined;
}

/** The default runner: an HTTP POST to `<host>:<port>/<index>/_search` with optional basic auth. */
export const runEsSearch: EsSearchRunner = async (coordinates, secret, params, options) => {
	const index = (params.index ?? coordinates.index ?? '').trim();
	// ES coordinates carry no scheme; default http (matches the common on-prem setup).
	const path = index ? `/${encodeURIComponent(index)}/_search` : '/_search';
	const url = `http://${coordinates.host}:${coordinates.port}${path}`;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (secret?.username || secret?.password) {
		headers['authorization'] = `Basic ${Buffer.from(`${secret.username ?? ''}:${secret.password ?? ''}`).toString('base64')}`;
	}
	const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...(params.body ?? {}), size: params.size }), signal: options.signal });
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Elasticsearch returned ${response.status}: ${text.slice(0, 400)}`);
	}
	const json = JSON.parse(text) as { hits?: { total?: { value?: number } | number; hits?: { _id: string; _source: unknown }[] }; aggregations?: unknown };
	const rawTotal = json.hits?.total;
	const total = typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0);
	const hits = (json.hits?.hits ?? []).map(hit => ({ id: hit._id, source: hit._source }));
	return { total, hits, ...(json.aggregations !== undefined ? { aggregations: json.aggregations } : {}) };
};

function explainEsError(source: Pick<IElasticsearchQueryableSource, 'label' | 'coordinates'>, error: unknown): string {
	const c = source.coordinates;
	const message = error instanceof Error ? error.message : String(error);
	const probe = message.toLowerCase();
	let hint: string | undefined;
	if (probe.includes('etimedout') || probe.includes('ehostunreach')) {
		hint = `No response from ${c.host}:${c.port} — wrong host/IP, unreachable network, or VPN required. Fix the host in the data source configuration before retrying.`;
	} else if (probe.includes('enotfound') || probe.includes('eai_again')) {
		hint = `The hostname "${c.host}" does not resolve — check the host (and DNS/VPN).`;
	} else if (probe.includes('econnrefused')) {
		hint = `${c.host} refused port ${c.port} — Elasticsearch may be down or the port wrong.`;
	} else if (probe.includes('401') || probe.includes('403')) {
		hint = 'The credentials were rejected — the username/password stored for this data source are wrong or missing.';
	} else if (probe.includes('index_not_found') || probe.includes('404')) {
		hint = 'The index does not exist — pass an existing `index`, or omit it to search all indices.';
	}
	return `Elasticsearch query failed against "${source.label}" (${c.host}:${c.port}): ${message}${hint ? `\n${hint}` : ''}`;
}

function formatResult(source: IElasticsearchQueryableSource, params: IEsSearchParams, result: IEsSearchResult): string {
	const index = (params.index ?? source.coordinates.index ?? '').trim() || '(all indices)';
	const head = `index: ${index} · total hits: ${result.total} · returned: ${result.hits.length}`;
	let body = result.hits.map(hit => `_id=${hit.id}  ${JSON.stringify(hit.source)}`).join('\n');
	let truncated = false;
	if (body.length > MAX_HITS_CHARS) {
		body = body.slice(0, MAX_HITS_CHARS);
		truncated = true;
	}
	const agg = result.aggregations !== undefined ? `\n\naggregations: ${JSON.stringify(result.aggregations).slice(0, 2000)}` : '';
	return `${head}\n${result.hits.length > 0 ? body : '(no hits)'}${truncated ? '\n\n[hits truncated — narrow the query or lower size]' : ''}${agg}`;
}

/**
 * Build the read-only Elasticsearch tool for a run. Enumerates the configured
 * sources in its own description (no separate list tool), and only ever runs
 * `_search` — writes are impossible through this seam.
 */
export function createElasticsearchTools(deps: IElasticsearchToolDeps): readonly IAgentTool[] {
	if (deps.sources.length === 0) {
		return [];
	}
	const run = deps.runSearch ?? runEsSearch;
	const sourceList = deps.sources.map(describe).join('\n');

	const queryTool = defineTool({
		name: 'query_elasticsearch',
		description:
			'Run a READ-ONLY Elasticsearch `_search` against a configured ES data source. Pass the ES query DSL as `body` (e.g. {"query":{"match_all":{}}}); use size:0 with aggregations for counts. `source` is the label, id, or environment name.\n' +
			`Configured Elasticsearch sources:\n${sourceList}`,
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'The ES data source label, id, or environment name.' },
				body: { type: 'object', description: 'The ES query DSL body (query/aggs/sort/_source). Omit for match_all.' },
				index: { type: 'string', description: 'Override the source’s configured index; omit to use it, or "" to search all indices.' },
				size: { type: 'number', description: `Max hits to return (default ${DEFAULT_SIZE}, capped at ${MAX_SIZE}).` },
			},
			required: ['source'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'source');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			if (record['body'] !== undefined && (typeof record['body'] !== 'object' || record['body'] === null || Array.isArray(record['body']))) {
				return invalid('`body` must be an ES query DSL object');
			}
			if (record['index'] !== undefined && typeof record['index'] !== 'string') {
				return invalid('`index` must be a string');
			}
			if (record['size'] !== undefined && (typeof record['size'] !== 'number' || !Number.isFinite(record['size']) || record['size'] < 0)) {
				return invalid('`size` must be a non-negative number');
			}
			return valid(record);
		},
		call: async (input, context) => {
			const record = input as { source: string; body?: Record<string, unknown>; index?: string; size?: number };
			const match = resolveEsSource(deps.sources, record.source);
			if (!match) {
				return { content: `No Elasticsearch source named "${record.source}". Configured: ${deps.sources.map(s => s.label).join(', ') || '(none)'}.`, isError: true };
			}
			if (Array.isArray(match)) {
				return { content: `"${record.source}" is ambiguous — pass one of these ids: ${match.map(candidate => candidate.id).join(', ')}.`, isError: true };
			}
			const size = Math.min(record.size ?? DEFAULT_SIZE, MAX_SIZE);
			const params: IEsSearchParams = { size, ...(record.index !== undefined ? { index: record.index } : {}), ...(record.body !== undefined ? { body: record.body } : {}) };
			const secret = await deps.getSecret(match.id);
			try {
				const result = await run(match.coordinates, secret, params, { signal: context.signal });
				return { content: formatResult(match, params, result) };
			} catch (error) {
				return { content: explainEsError(match, error), isError: true };
			}
		},
	});

	return [queryTool];
}
