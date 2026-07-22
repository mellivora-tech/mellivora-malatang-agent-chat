/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentLog } from './agent/observability/agentLog.js';

/**
 * Report a failure the MAIN process caught in best-effort side work (artifact
 * capture, cleanup), so it lands in the log file instead of ending at a bare
 * `console.error` that reaches only dev stdout. The console call is kept — it
 * stays useful in a dev terminal; the emit is what makes the failure survive.
 * Same cap as diagnosticsIpc: a stack or pasted payload must not bloat the log.
 */
const MAX_MESSAGE_CHARS = 2000;

export function reportMainFailure(scope: string, error: unknown, opts?: { readonly sessionId?: string }): void {
	console.error(`[main] ${scope} failed:`, error);
	const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE_CHARS);
	const errorClass = error instanceof Error ? (error.name !== '' ? error.name : error.constructor?.name) : typeof error;
	agentLog.emit({
		ts: new Date().toISOString(),
		type: 'main_error',
		scope,
		...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
		...(errorClass !== undefined ? { errorClass } : {}),
		...(message !== '' ? { detail: { message } } : {}),
	});
}
