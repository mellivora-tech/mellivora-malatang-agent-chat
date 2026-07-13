/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDatabaseCoordinates, IDataSourceSecret } from '../../../sessions/services/environments/common/environments.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { isReadOnlySql, runDbQuery, type DbQueryRunner, type IQueryResult } from '../dbQuery.js';
import { asRecord, invalid, requireString, valid } from './workspace.js';

const ROW_LIMIT = 100;
const MAX_CELL = 200;

/** A database data source the agent may query, with resolved coordinates (secret fetched per query). */
export interface IQueryableSource {
	readonly id: string;
	readonly label: string;
	readonly environmentName: string;
	readonly coordinates: IDatabaseCoordinates;
}

export interface IDataSourceToolDeps {
	readonly sources: readonly IQueryableSource[];
	getSecret(dataSourceId: string): Promise<IDataSourceSecret | undefined>;
	/** Injectable for tests; defaults to the real driver-backed runner. */
	readonly runQuery?: DbQueryRunner;
}

function describe(source: IQueryableSource): string {
	const c = source.coordinates;
	return `- ${source.label} (env: ${source.environmentName}, ${c.driver} ${c.host}:${c.port}/${c.database}, id: ${source.id})`;
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
	return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

function formatResult(result: IQueryResult): string {
	if (result.columns.length === 0) {
		return '(query returned no columns)';
	}
	const header = result.columns.join(' | ');
	if (result.rows.length === 0) {
		return `${header}\n(0 rows)`;
	}
	const body = result.rows.map(row => row.map(formatCell).join(' | ')).join('\n');
	return `${header}\n${body}${result.truncated ? `\n\n[truncated at ${ROW_LIMIT} rows]` : ''}`;
}

/**
 * Build the read-only data-source tools for a run: `list_data_sources` (what's
 * configured) and `query_data_source` (run a SELECT). Queries connect per call
 * using the stored credential; writes are refused by {@link isReadOnlySql}.
 */
export function createDataSourceTools(deps: IDataSourceToolDeps): readonly IAgentTool[] {
	const run = deps.runQuery ?? runDbQuery;

	const resolve = (source: string): IQueryableSource | IQueryableSource[] | undefined => {
		const byId = deps.sources.find(candidate => candidate.id === source);
		if (byId) {
			return byId;
		}
		const byLabel = deps.sources.filter(candidate => candidate.label === source);
		return byLabel.length === 1 ? byLabel[0] : byLabel.length > 1 ? byLabel : undefined;
	};

	const listTool = defineTool({
		name: 'list_data_sources',
		description: "List the project's configured database data sources (label, environment, driver/host). Use query_data_source with a label or id to run a read-only query.",
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: () => valid({}),
		call: async () => ({ content: deps.sources.length > 0 ? deps.sources.map(describe).join('\n') : 'No database data sources are configured for this project.' }),
	});

	const queryTool = defineTool({
		name: 'query_data_source',
		description: 'Run a READ-ONLY SQL query (SELECT / WITH / SHOW / EXPLAIN only) against a configured database data source. `source` is its label or id — see list_data_sources.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'The data source label or id.' },
				sql: { type: 'string', description: 'A single read-only SQL statement.' },
			},
			required: ['source', 'sql'],
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
				requireString(record, 'sql');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { source, sql } = input as { source: string; sql: string };
			const match = resolve(source);
			if (!match) {
				return { content: `No data source named "${source}". Call list_data_sources to see the options.`, isError: true };
			}
			if (Array.isArray(match)) {
				return { content: `"${source}" is ambiguous across environments — pass one of these ids: ${match.map(candidate => candidate.id).join(', ')}.`, isError: true };
			}
			if (!isReadOnlySql(sql)) {
				return { content: 'Only read-only queries are allowed (SELECT / WITH / SHOW / EXPLAIN, a single statement).', isError: true };
			}
			const secret = await deps.getSecret(match.id);
			try {
				const result = await run(match.coordinates, secret, sql, { rowLimit: ROW_LIMIT, signal: context.signal });
				return { content: formatResult(result) };
			} catch (error) {
				return { content: `Query failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	});

	return [listTool, queryTool];
}
