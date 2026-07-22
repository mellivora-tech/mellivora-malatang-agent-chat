/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import { agentLog } from './agent/observability/agentLog.js';
import { createJsonlFileSink, isFullModeForced, resolveAgentLogsDir } from './agent/observability/jsonlFileSink.js';
import { createModeFilteredSink, type LoggingMode } from './agent/observability/logFilter.js';
import { createRunIndexSink } from './agent/observability/runIndexSink.js';
import { listRuns, readRunEvents } from './agent/observability/logReader.js';
import { readAppState, writeAppState } from './appStateStorage.js';
import type { ILoggingConfig, IRunLogPage } from '../sessions/services/logs/common/logs.js';

/**
 * Observability wiring: attaches the (now permanent) log sinks and owns the
 * logging-mode setting. The sink is ALWAYS attached — 'errors' mode (the
 * default) keeps failure events only, 'full' keeps everything; see logFilter.ts
 * for the exact contract. Mode changes apply on the next event, no restart.
 *
 * Called FIRST in whenReady so early storage_degraded/ipc events hit an
 * attached sink instead of relying on the bus's bounded pre-attach queue.
 *
 * No retention policy yet: full-mode dailies grow ~MBs/day and are never
 * pruned. Follow-up when it hurts: age out dailies past N days (the index
 * would need the same trim so listed runs stay readable).
 */
export async function registerLogsIpc(dataRoot: string): Promise<void> {
	const logsDir = resolveAgentLogsDir(dataRoot, process.env);
	const forcedFull = isFullModeForced(process.env);
	let persistedMode: LoggingMode = (await readAppState(dataRoot)).loggingMode ?? 'errors';
	const getMode = (): LoggingMode => (forcedFull ? 'full' : persistedMode);
	const getConfig = (): ILoggingConfig => ({ mode: getMode(), forcedFull, logsDir });

	agentLog.attach(createModeFilteredSink(createJsonlFileSink(logsDir), getMode));
	agentLog.attach(createRunIndexSink(logsDir, getMode));
	console.error(`[agent] observability log: ${logsDir}/latest.jsonl (${getMode()})`);

	registerHandler('logs:getConfig', () => getConfig());

	registerHandler('logs:setMode', async (_event, mode: unknown): Promise<ILoggingConfig> => {
		// Untrusted boundary: anything but the two literals is rejected.
		if (mode !== 'full' && mode !== 'errors') {
			throw new Error(`invalid logging mode: ${String(mode)}`);
		}
		// Main-side read-merge-write — the same discipline as appState:set, so
		// concurrent writers can only lose their own field, never each other's.
		const state = await readAppState(dataRoot);
		await writeAppState(dataRoot, { ...state, loggingMode: mode });
		persistedMode = mode;
		return getConfig();
	});

	registerHandler('logs:listRuns', (_event, opts?: { readonly sessionId?: string; readonly limit?: number }) => {
		// The buffered writer batches up to 1s — without a flush the viewer
		// misses the tail of a run that just finished.
		agentLog.flush();
		return listRuns(logsDir, {
			...(typeof opts?.sessionId === 'string' ? { sessionId: opts.sessionId } : {}),
			...(typeof opts?.limit === 'number' ? { limit: opts.limit } : {}),
		});
	});

	registerHandler('logs:readRun', async (_event, runId: unknown): Promise<IRunLogPage> => {
		if (typeof runId !== 'string' || runId === '') {
			return { events: [], truncated: false };
		}
		agentLog.flush();
		// No limit here — the run being replayed may be far past the list default.
		const summary = (await listRuns(logsDir, { limit: Number.MAX_SAFE_INTEGER })).find(run => run.runId === runId);
		if (!summary) {
			return { events: [], truncated: false };
		}
		return readRunEvents(logsDir, summary);
	});
}
