/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentLog } from './agent/observability/agentLog.js';

/**
 * The instrumentation half of {@link registerHandler}, kept free of any runtime
 * `electron` import so it stays bare-node testable (same split as gitDiff.ts).
 *
 * An audit found that of 64 `ipcMain.handle` registrations exactly ONE
 * (`agent:run`) ever reached the log file — every `agentLog.emit` in the
 * codebase lives in runLogger.ts, which only `agent:run` constructs. A failing
 * provider probe, data-source test, git clone or title call therefore left
 * nothing on disk: the rejection is serialized back to the renderer, where a
 * DevTools-only `console.warn` absorbs it. A global `unhandledRejection` hook
 * CANNOT close this gap — `ipcMain.handle` catches the handler's rejection
 * itself, so the process never sees an unhandled one. Wrapping registration is
 * the only seam that covers every channel at once, including the handlers that
 * carry no catch of their own.
 */

/**
 * Successful calls are logged only when they take at least this long. Chatty
 * read channels (branch pills, app state) fire constantly; one line per call
 * would drown the run events that make the log useful. Failures always log.
 */
export const SLOW_CALL_MS = 1000;

/** Constructor name (or a coarse label) — export-safe, unlike the message. */
export function classifyError(error: unknown): string {
	if (error instanceof Error) {
		return error.name !== '' && error.name !== 'Error' ? error.name : (error.constructor?.name ?? 'Error');
	}
	return typeof error;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap one handler so a rejection (and a slow success) lands in the agent log.
 * The handler's own contract is untouched: the result is returned and a
 * rejection re-thrown, so Electron's error serialization behaves exactly as
 * before. Logging is best-effort — `agentLog.emit` already swallows sink
 * failures, so observability can never break a channel.
 */
export function instrumentHandler<TArgs extends unknown[], TResult>(
	channel: string,
	listener: (...args: TArgs) => TResult | Promise<TResult>,
	now: () => number = Date.now,
): (...args: TArgs) => Promise<TResult> {
	return async (...args: TArgs): Promise<TResult> => {
		const startedAt = now();
		try {
			const result = await listener(...args);
			const durationMs = now() - startedAt;
			if (durationMs >= SLOW_CALL_MS) {
				agentLog.emit({ ts: new Date().toISOString(), type: 'ipc', channel, ok: true, durationMs });
			}
			return result;
		} catch (error) {
			agentLog.emit({
				ts: new Date().toISOString(),
				type: 'ipc',
				channel,
				ok: false,
				durationMs: now() - startedAt,
				errorClass: classifyError(error),
				detail: { message: describeError(error) },
			});
			throw error;
		}
	};
}
