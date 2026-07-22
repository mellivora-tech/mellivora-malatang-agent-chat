/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentLogEvent, IAgentLogSink } from './agentLog.js';

export type LoggingMode = 'full' | 'errors';

/**
 * The errors-only contract: with logging "off", these events still reach disk,
 * so "the feature failed and no log says why" stays impossible regardless of the
 * user's choice. Everything else — reasoning, tool I/O, telemetry — is full-mode
 * only, because that is exactly what the toggle lets the user decline to keep.
 */
export function isErrorClassEvent(event: AgentLogEvent): boolean {
	switch (event.type) {
		case 'error':
		case 'renderer_error':
		case 'main_error':
		case 'storage_degraded':
		case 'stream_retry':
		case 'loop_guard':
			return true;
		case 'ipc':
			// Slow-but-successful calls are latency telemetry, not failures.
			return !event.ok;
		case 'tool_result':
			return !event.ok;
		case 'hooks_loaded':
			return event.corrupt || event.dropped > 0;
		case 'hook':
			return event.failOpen === true;
		case 'reply_verifier':
			return event.verdict !== 'pass';
		case 'compaction':
			return event.outcome === 'error';
		// Run boundaries are kept in BOTH modes: two tiny lines per run make every
		// error attributable to a build/model/run, and keep the run index consistent
		// with the daily files whichever mode wrote them.
		case 'run_start':
		case 'run_end':
			return true;
		default:
			return false;
	}
}

/**
 * Wrap a sink so the CURRENT mode decides per event — `getMode` is consulted on
 * every write, which is what makes the settings toggle take effect on the very
 * next event with no re-attach (the bus has no detach, deliberately).
 */
export function createModeFilteredSink(inner: IAgentLogSink, getMode: () => LoggingMode): IAgentLogSink {
	return {
		write: event => {
			if (getMode() === 'full' || isErrorClassEvent(event)) {
				inner.write(event);
			}
		},
		flush: () => inner.flush?.(),
		dispose: () => inner.dispose?.(),
	};
}
