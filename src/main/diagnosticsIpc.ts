/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import { agentLog } from './agent/observability/agentLog.js';

/**
 * The renderer's only route to the log file.
 *
 * An audit found that every `console.warn` / `console.error` in `src/sessions/**`
 * is DevTools-only: in Electron a renderer's console does NOT reach the main
 * process stdout, and nothing forwards it to disk. So a failure the renderer
 * caught — a title that never generated, an image attachment silently dropped,
 * an assistant reply that failed to persist — left no trace anywhere a user or
 * maintainer could look. For post-hoc auditing that is identical to an empty
 * catch. This channel gives those failures the same landing place as main-process
 * ones.
 *
 * Deliberately `send`/`on` rather than `invoke`/`handle`: reporting a failure must
 * be fire-and-forget. It can neither block the caller nor produce a rejection of
 * its own — a logging path that can fail is how you lose the report about the
 * failure you were trying to log.
 */

/** Cap the stored message; a stack or a pasted payload must not bloat the log. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_SCOPE_CHARS = 120;

interface IRendererFailurePayload {
	readonly scope?: unknown;
	readonly message?: unknown;
	readonly errorClass?: unknown;
	readonly sessionId?: unknown;
}

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed.slice(0, max);
}

export function registerDiagnosticsIpc(): void {
	// Untrusted input: the payload crosses a process boundary, so every field is
	// validated rather than trusted, and a malformed report is dropped instead of
	// throwing inside the log path.
	ipcMain.on('diagnostics:report', (_event, payload: IRendererFailurePayload) => {
		const scope = text(payload?.scope, MAX_SCOPE_CHARS);
		if (scope === undefined) {
			return;
		}
		const message = text(payload?.message, MAX_MESSAGE_CHARS);
		const errorClass = text(payload?.errorClass, MAX_SCOPE_CHARS);
		const sessionId = text(payload?.sessionId, MAX_SCOPE_CHARS);
		agentLog.emit({
			ts: new Date().toISOString(),
			type: 'renderer_error',
			scope,
			...(sessionId !== undefined ? { sessionId } : {}),
			...(errorClass !== undefined ? { errorClass } : {}),
			...(message !== undefined ? { detail: { message } } : {}),
		});
	});
}
