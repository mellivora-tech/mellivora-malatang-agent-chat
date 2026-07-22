/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Observability contracts: the logging-mode setting and the run-log read-back
 * channels behind `agentWindow.logs`.
 */

/** 'errors' (default) keeps only failure events on disk; 'full' keeps everything. */
export type LoggingMode = 'full' | 'errors';

export interface ILoggingConfig {
	readonly mode: LoggingMode;
	/** MELLIVORA_DEBUG / MELLIVORA_LOG_DIR override — the toggle is disabled. */
	readonly forcedFull: boolean;
	readonly logsDir: string;
}

/** One agent run as folded from the run index (end fields absent = crashed or in flight). */
export interface IRunSummary {
	readonly runId: string;
	readonly sessionId: string;
	readonly startedAt: string;
	readonly startDate: string;
	readonly endedAt?: string;
	readonly endDate?: string;
	readonly model?: string;
	readonly permissionMode?: string;
	/** Mode the run was logged under — 'errors' means no full replay exists. */
	readonly loggingMode?: LoggingMode;
	readonly reason?: string;
	readonly turns?: number;
	readonly durationMs?: number;
}

/**
 * Loose transport shape for one log line. Deliberately NOT the main-process
 * event union: the renderer cannot import `src/main` types, and the viewer must
 * tolerate lines written by older/newer builds — unknown types render as
 * generic rows instead of breaking replay.
 */
export interface IRunLogEvent {
	readonly ts: string;
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface IRunLogPage {
	readonly events: readonly IRunLogEvent[];
	readonly truncated: boolean;
}

/** The shape exposed on `agentWindow.logs` by the preload script. */
export interface ILogsBridge {
	getConfig(): Promise<ILoggingConfig>;
	setMode(mode: LoggingMode): Promise<ILoggingConfig>;
	listRuns(opts?: { readonly sessionId?: string; readonly limit?: number }): Promise<readonly IRunSummary[]>;
	readRun(runId: string): Promise<IRunLogPage>;
}
