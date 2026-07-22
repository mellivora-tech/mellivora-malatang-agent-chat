/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentLog } from './agent/observability/agentLog.js';

/**
 * Record that a config/data store existed but could not be used.
 *
 * Every storage reader here degrades rather than throws — the right call, since a
 * corrupt file must not stop the app booting. The bug is that it degrades
 * SILENTLY: "unreadable" and "never configured" produce the same empty result and
 * the same UI, so a user whose credentials fail to decrypt is told nothing was
 * ever configured, and goes looking for the wrong problem.
 *
 * Report only when a file was actually present and unusable. A missing file is
 * the legitimate empty case and must stay quiet, or the log fills with noise on
 * every fresh install.
 */
export function reportStorageDegraded(
	store: string,
	reason: 'unparseable' | 'undecryptable' | 'entries-dropped',
	detail?: { readonly path?: string; readonly message?: string; readonly dropped?: number },
): void {
	const message = detail?.message;
	const path = detail?.path;
	agentLog.emit({
		ts: new Date().toISOString(),
		type: 'storage_degraded',
		store,
		reason,
		...(detail?.dropped !== undefined ? { dropped: detail.dropped } : {}),
		...(path !== undefined || message !== undefined ? { detail: { ...(path !== undefined ? { path } : {}), ...(message !== undefined ? { message } : {}) } } : {}),
	});
}
