/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLogEvent, IAgentLogSink } from './agentLog.js';
import { createBufferedWriter } from './bufferedWriter.js';

/**
 * Local JSONL sink: one dated file per day plus a `latest.jsonl` symlink so a
 * developer can `tail -f <logsDir>/latest.jsonl`. Being on the user's own
 * machine, it keeps full `detail` (inputs, outputs, paths). Off-machine sinks
 * added later must use {@link import('./agentLog.js').toExportable} instead.
 */
export function createJsonlFileSink(logsDir: string, options?: { readonly immediate?: boolean }): IAgentLogSink {
	const file = join(logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
	let ensured = false;

	const ensureReady = (): void => {
		if (ensured) {
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
		ensured = true;
	};

	const writer = createBufferedWriter({
		...(options?.immediate !== undefined ? { immediate: options.immediate } : {}),
		writeFn: content => {
			ensureReady();
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
 * Attach the local file sink when logging is enabled. Off by default; enable
 * with MELLIVORA_DEBUG (or point MELLIVORA_LOG_DIR somewhere). Returns the log
 * file path when attached so startup can print where to tail.
 */
export function resolveAgentLogsDir(dataRoot: string, env: NodeJS.ProcessEnv): string | undefined {
	const explicit = env['MELLIVORA_LOG_DIR'];
	if (explicit) {
		return explicit;
	}
	const enabled = env['MELLIVORA_DEBUG'];
	if (enabled && enabled !== '0' && enabled.toLowerCase() !== 'false') {
		return join(dataRoot, 'logs');
	}
	return undefined;
}
