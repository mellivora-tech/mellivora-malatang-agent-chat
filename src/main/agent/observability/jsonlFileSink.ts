/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLogEvent, IAgentLogSink } from './agentLog.js';
import { createBufferedWriter } from './bufferedWriter.js';

/** The daily-file key (`YYYY-MM-DD`) — also the format the run index stores. */
export function logDateKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Local JSONL sink: one dated file per day plus a `latest.jsonl` symlink so a
 * developer can `tail -f <logsDir>/latest.jsonl`. Being on the user's own
 * machine, it keeps full `detail` (inputs, outputs, paths). Off-machine sinks
 * added later must use {@link import('./agentLog.js').toExportable} instead.
 */
export function createJsonlFileSink(logsDir: string, options?: { readonly immediate?: boolean; readonly now?: () => Date }): IAgentLogSink {
	const now = options?.now ?? ((): Date => new Date());
	// The target is re-resolved at every flush so a long-lived app rolls over to
	// the new day's file at midnight instead of appending to yesterday's forever.
	let linkedDate: string | undefined;

	const ensureReady = (date: string, file: string): void => {
		if (linkedDate === date) {
			return;
		}
		mkdirSync(logsDir, { recursive: true });
		const link = join(logsDir, 'latest.jsonl');
		try {
			unlinkSync(link);
		} catch {
			// No prior symlink.
		}
		try {
			symlinkSync(file, link);
		} catch {
			// Symlinks may be unavailable (e.g. some Windows setups) — not fatal.
		}
		linkedDate = date;
	};

	const writer = createBufferedWriter({
		...(options?.immediate !== undefined ? { immediate: options.immediate } : {}),
		writeFn: content => {
			const date = logDateKey(now());
			const file = join(logsDir, `${date}.jsonl`);
			ensureReady(date, file);
			appendFileSync(file, content);
		},
	});

	return {
		write: (event: AgentLogEvent) => writer.write(`${JSON.stringify(event)}\n`),
		flush: () => writer.flush(),
		dispose: () => writer.dispose(),
	};
}

/**
 * Where the log files live. This no longer gates WHETHER logging happens — the
 * sink is always attached (errors-only by default; see logFilter.ts) — it only
 * resolves the directory: MELLIVORA_LOG_DIR wins, else `<dataRoot>/logs`.
 */
export function resolveAgentLogsDir(dataRoot: string, env: NodeJS.ProcessEnv): string {
	return env['MELLIVORA_LOG_DIR'] || join(dataRoot, 'logs');
}

/**
 * Dev override: MELLIVORA_DEBUG (or an explicit MELLIVORA_LOG_DIR) forces full
 * logging regardless of the persisted user setting, so `npm run dev:debug`
 * keeps meaning "everything on disk" and the settings toggle shows as forced.
 */
export function isFullModeForced(env: NodeJS.ProcessEnv): boolean {
	if (env['MELLIVORA_LOG_DIR']) {
		return true;
	}
	const enabled = env['MELLIVORA_DEBUG'];
	return Boolean(enabled && enabled !== '0' && enabled.toLowerCase() !== 'false');
}
