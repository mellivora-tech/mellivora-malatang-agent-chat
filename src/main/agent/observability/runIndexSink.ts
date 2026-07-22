/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLogEvent, IAgentLogSink } from './agentLog.js';
import type { LoggingMode } from './logFilter.js';

export const RUNS_INDEX_FILE = 'runs-index.jsonl';

/** One line of `runs-index.jsonl` — the fold key is (runId, kind). */
export interface IRunIndexLine {
	readonly kind: 'start' | 'end';
	readonly runId: string;
	readonly ts: string;
	/** Daily-file key the run's events were routed to (`YYYY-MM-DD`). */
	readonly date: string;
	readonly sessionId?: string;
	readonly model?: string;
	readonly permissionMode?: string;
	/** Mode at write time — tells the viewer whether a full replay exists. */
	readonly loggingMode?: LoggingMode;
	readonly reason?: string;
	readonly turns?: number;
	readonly durationMs?: number;
}

/**
 * A second always-attached sink that mirrors ONLY run boundaries into a tiny
 * sidecar, so listing runs never re-scans the (potentially tens-of-MB) daily
 * files. Rebuildable from the dailies: both modes keep run_start/run_end.
 * Writes are immediate — two lines per run, durability beats batching.
 */
export function createRunIndexSink(logsDir: string, getMode: () => LoggingMode): IAgentLogSink {
	let ensured = false;

	const append = (line: IRunIndexLine): void => {
		try {
			if (!ensured) {
				mkdirSync(logsDir, { recursive: true });
				ensured = true;
			}
			appendFileSync(join(logsDir, RUNS_INDEX_FILE), `${JSON.stringify(line)}\n`);
		} catch {
			// The index is a rebuildable mirror — its failures must never surface.
		}
	};

	return {
		write: (event: AgentLogEvent) => {
			if (event.type === 'run_start') {
				append({
					kind: 'start',
					runId: event.runId,
					ts: event.ts,
					date: event.ts.slice(0, 10),
					sessionId: event.sessionId,
					model: event.model,
					permissionMode: event.mode,
					loggingMode: getMode(),
				});
			} else if (event.type === 'run_end') {
				append({
					kind: 'end',
					runId: event.runId,
					ts: event.ts,
					date: event.ts.slice(0, 10),
					reason: event.reason,
					turns: event.turns,
					durationMs: event.durationMs,
				});
			}
		},
	};
}
