/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IRunLogEvent, IRunSummary, LoggingMode } from '../../../sessions/services/logs/common/logs.js';
import { RUNS_INDEX_FILE } from './runIndexSink.js';

/**
 * Read-back over the on-disk logs: fold `runs-index.jsonl` into run summaries
 * and extract one run's full event stream from the daily files. Bare node —
 * no Electron imports — so replay logic is unit-testable against temp dirs.
 *
 * Trust posture: file names are built ONLY from index `date` fields that match
 * `YYYY-MM-DD`, joined under logsDir. The renderer supplies a runId, never a path.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIST_LIMIT = 100;
export const MAX_RUN_EVENTS = 20_000;

function parseLines(raw: string): unknown[] {
	const parsed: unknown[] = [];
	for (const line of raw.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// A torn or corrupt line must not hide the rest of the file.
		}
	}
	return parsed;
}

function asLoggingMode(value: unknown): LoggingMode | undefined {
	return value === 'full' || value === 'errors' ? value : undefined;
}

export async function listRuns(logsDir: string, opts?: { readonly sessionId?: string; readonly limit?: number }): Promise<IRunSummary[]> {
	let raw: string;
	try {
		raw = await readFile(join(logsDir, RUNS_INDEX_FILE), 'utf8');
	} catch {
		return [];
	}

	const byRunId = new Map<string, IRunSummary>();
	for (const value of parseLines(raw)) {
		if (typeof value !== 'object' || value === null) {
			continue;
		}
		const line = value as Record<string, unknown>;
		if (typeof line['runId'] !== 'string' || typeof line['ts'] !== 'string' || typeof line['date'] !== 'string' || !DATE_KEY.test(line['date'])) {
			continue;
		}
		if (line['kind'] === 'start') {
			const loggingMode = asLoggingMode(line['loggingMode']);
			byRunId.set(line['runId'], {
				runId: line['runId'],
				sessionId: typeof line['sessionId'] === 'string' ? line['sessionId'] : '',
				startedAt: line['ts'],
				startDate: line['date'],
				...(typeof line['model'] === 'string' ? { model: line['model'] } : {}),
				...(typeof line['permissionMode'] === 'string' ? { permissionMode: line['permissionMode'] } : {}),
				...(loggingMode !== undefined ? { loggingMode } : {}),
			});
		} else if (line['kind'] === 'end') {
			const start = byRunId.get(line['runId']);
			// An end without a start (index truncated mid-history) is unlistable —
			// there is no startDate to locate the events with.
			if (start) {
				byRunId.set(line['runId'], {
					...start,
					endedAt: line['ts'],
					endDate: line['date'],
					...(typeof line['reason'] === 'string' ? { reason: line['reason'] } : {}),
					...(typeof line['turns'] === 'number' ? { turns: line['turns'] } : {}),
					...(typeof line['durationMs'] === 'number' ? { durationMs: line['durationMs'] } : {}),
				});
			}
		}
	}

	const limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
	return [...byRunId.values()]
		.filter(run => opts?.sessionId === undefined || run.sessionId === opts.sessionId)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
		.slice(0, limit);
}

/** The daily files that can contain the run: start..end, or start+1day when the run never ended (crash / in flight / midnight rollover). */
function candidateDates(summary: IRunSummary): string[] {
	const start = summary.startDate;
	const end = summary.endDate ?? nextDateKey(start);
	const dates: string[] = [];
	let cursor = start;
	// Bounded walk — a run spans at most a handful of days; cap defensively.
	for (let i = 0; i < 14 && cursor <= end; i++) {
		dates.push(cursor);
		cursor = nextDateKey(cursor);
	}
	return dates;
}

function nextDateKey(date: string): string {
	const next = new Date(`${date}T00:00:00.000Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	return next.toISOString().slice(0, 10);
}

export async function readRunEvents(logsDir: string, summary: IRunSummary, opts?: { readonly maxEvents?: number }): Promise<{ events: IRunLogEvent[]; truncated: boolean }> {
	const maxEvents = opts?.maxEvents ?? MAX_RUN_EVENTS;
	const events: IRunLogEvent[] = [];
	let truncated = false;

	for (const date of candidateDates(summary)) {
		if (!DATE_KEY.test(date)) {
			continue;
		}
		let raw: string;
		try {
			raw = await readFile(join(logsDir, `${date}.jsonl`), 'utf8');
		} catch {
			continue;
		}
		for (const value of parseLines(raw)) {
			if (typeof value !== 'object' || value === null) {
				continue;
			}
			const line = value as Record<string, unknown>;
			if (line['runId'] !== summary.runId || typeof line['ts'] !== 'string' || typeof line['type'] !== 'string') {
				continue;
			}
			if (events.length >= maxEvents) {
				truncated = true;
				return { events, truncated };
			}
			events.push(line as IRunLogEvent);
		}
	}

	return { events, truncated };
}
