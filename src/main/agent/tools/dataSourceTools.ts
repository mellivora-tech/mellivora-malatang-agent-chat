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

/**
 * Turn a driver error into a message the model (and the user reading the tool
 * card) can act on: WHERE it failed (source, driver, host:port/db), WHAT the
 * driver said (message + code), and the likely fix. A bare "connect ETIMEDOUT"
 * caused a real failure chain: the model could not tell config typo from
 * network outage, gave up, and later asserted the failure as permanent.
 */
export function explainQueryError(source: Pick<IQueryableSource, 'label' | 'coordinates'>, error: unknown): string {
	const c = source.coordinates;
	const message = error instanceof Error ? error.message : String(error);
	const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined;
	const where = `"${source.label}" (${c.driver} ${c.host}:${c.port}${c.database ? `/${c.database}` : ''})`;
	const probe = `${code ?? ''} ${message}`.toLowerCase();

	let hint: string | undefined;
	if (probe.includes('etimedout') || probe.includes('ehostunreach')) {
		hint = `No response from ${c.host}:${c.port} — wrong host/IP, unreachable network, or VPN required. Verify the host in the data source configuration before retrying; more queries against this source will hang the same way until it is fixed.`;
	} else if (probe.includes('enotfound') || probe.includes('eai_again')) {
		hint = `The hostname "${c.host}" does not resolve — check the host in the data source configuration (and DNS/VPN).`;
	} else if (probe.includes('econnrefused')) {
		hint = `${c.host} is reachable but refused port ${c.port} — the database server may be down or the port wrong.`;
	} else if (probe.includes('access denied') || probe.includes('authentication failed') || probe.includes('28p01')) {
		hint = 'The credentials were rejected — the username/password stored for this data source are wrong or expired.';
	} else if (probe.includes('no database selected') || probe.includes('er_no_db')) {
		hint = `This data source has no default database configured — qualify table names (e.g. \`mydb.my_table\`) or set the database in the data source configuration.`;
	} else if (probe.includes('unknown database') || probe.includes('3d000')) {
		hint = `The configured database "${c.database}" does not exist on this server — check the database name in the data source configuration.`;
	}

	return `Query failed against ${where}: ${message}${code ? ` [${code}]` : ''}${hint ? `\n${hint}` : ''}`;
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
	const header = result.columns.map(column => column.name).join(' | ');
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

	// id → label → environment name, first unique match wins (same contract as
	// the ssh tools): "dev" hits directly when that environment has one database.
	const resolve = (source: string): IQueryableSource | IQueryableSource[] | undefined => {
		const byId = deps.sources.find(candidate => candidate.id === source);
		if (byId) {
			return byId;
		}
		const byLabel = deps.sources.filter(candidate => candidate.label === source);
		if (byLabel.length > 0) {
			return byLabel.length === 1 ? byLabel[0] : byLabel;
		}
		const byEnvironment = deps.sources.filter(candidate => candidate.environmentName === source);
		return byEnvironment.length === 1 ? byEnvironment[0] : byEnvironment.length > 1 ? byEnvironment : undefined;
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
		description:
			'Run a READ-ONLY SQL query (SELECT / WITH / SHOW / EXPLAIN only) against a configured database data source. `source` is its label, id, or environment name (e.g. "dev") — see list_data_sources.',
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
				return { content: explainQueryError(match, error), isError: true };
			}
		},
	});

	return [listTool, queryTool];
}
