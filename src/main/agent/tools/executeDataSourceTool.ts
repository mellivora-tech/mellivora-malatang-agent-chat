/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDataSourceSecret } from '../../../sessions/services/environments/common/environments.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { isReadOnlySql, isSingleStatement, runDbWrite, type DbWriteRunner } from '../dbQuery.js';
import { explainQueryError, resolveDataSource, type IQueryableSource } from './dataSourceTools.js';
import { asRecord, invalid, requireString, valid } from './workspace.js';

export interface IExecuteDataSourceToolDeps {
	readonly sources: readonly IQueryableSource[];
	getSecret(dataSourceId: string): Promise<IDataSourceSecret | undefined>;
	/** Injectable for tests; defaults to the real driver-backed runner. */
	readonly runWrite?: DbWriteRunner;
}

/**
 * The app's FIRST and ONLY agent-facing database write path. Deliberately
 * NOT read-only, so the permission gate routes every call through user
 * approval in ask/auto-edit (plan mode never sees this tool — it is only
 * registered when mode !== 'plan', like the SSH tools); deriveGrant has no
 * entry for it, so "always allow" is not offered — every statement is its own
 * decision. On top of approval, a source that is not effectively writable
 * (protected environment or read-only account) is refused unconditionally.
 */
export function createExecuteDataSourceTool(deps: IExecuteDataSourceToolDeps): IAgentTool {
	const run = deps.runWrite ?? runDbWrite;
	return defineTool({
		name: 'execute_data_source',
		description:
			"Execute ONE mutating SQL statement (INSERT / UPDATE / CREATE TABLE / …) against a configured, WRITABLE database data source. Every call requires the user's explicit approval — show the SQL you intend to run in the conversation BEFORE calling, and batch set-based statements (e.g. INSERT … SELECT with the transforms inlined) instead of row-by-row loops. " +
			'Cross-source migrations must read via query_data_source (100-row pages) and write batched inserts — feasible for small datasets, slow for large ones; say so instead of pretending otherwise. ' +
			'Sources marked READ-ONLY in list_data_sources are refused unconditionally. For reads use query_data_source.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'The data source label or id — see list_data_sources.' },
				sql: { type: 'string', description: 'A single mutating SQL statement (a trailing semicolon is fine; scripts are refused).' },
			},
			required: ['source', 'sql'],
			additionalProperties: false,
		},
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
			if (!isSingleStatement(record.sql as string)) {
				return invalid('exactly one SQL statement per call — split scripts into separate calls so each write is approved individually');
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { source, sql } = input as { source: string; sql: string };
			const match = resolveDataSource(deps.sources, source);
			if (!match) {
				return { content: `No data source named "${source}". Call list_data_sources to see the options.`, isError: true };
			}
			if (Array.isArray(match)) {
				return { content: `"${source}" is ambiguous across environments — pass one of these ids: ${match.map(candidate => candidate.id).join(', ')}.`, isError: true };
			}
			if (!match.writable) {
				return {
					content: `"${match.label}" is effectively read-only (protected environment or read-only account) — writes are refused unconditionally; user approval cannot override this.`,
					isError: true,
				};
			}
			if (isReadOnlySql(sql)) {
				return { content: 'That statement is read-only — use query_data_source for reads; execute_data_source is for writes.', isError: true };
			}
			const secret = await deps.getSecret(match.id);
			try {
				const result = await run(match.coordinates, secret, sql, { signal: context.signal });
				return { content: `OK — ${result.affectedRows} row(s) affected on "${match.label}".` };
			} catch (error) {
				return { content: explainQueryError(match, error), isError: true };
			}
		},
	});
}
