/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../../../base/common/observable.js';
import type { PermissionMode } from '../../agent/common/agent.js';

export const enum SessionStatus {
	Untitled = 0,
	InProgress = 1,
	NeedsInput = 2,
	Completed = 3,
	Error = 4,
}

export const enum SessionInteractivity {
	Full = 'full',
	ReadOnly = 'read-only',
	Hidden = 'hidden',
}

export interface ISessionWorkspace {
	readonly label: string;
	readonly description?: string;
	readonly branchName?: string;
}

export interface ISessionChangesSummary {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

/** One step inside a work block: a thinking stretch or a tool call. */
export interface ISessionWorkStep {
	readonly kind: 'thinking' | 'tool';
	readonly label: string;
	readonly durationMs: number;
	/** Expandable detail — for tool steps, the (truncated) output. */
	readonly detail?: string;
}

export interface ISessionMessage {
	readonly id: string;
	/** 'work' messages summarize one agent run: total duration plus its steps. */
	readonly role: 'user' | 'assistant' | 'tool' | 'work';
	readonly text: string;
	readonly detail?: string;
	/** Total run duration; unset while the run is still in progress. */
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStep[];
	readonly feedback?: 'like' | 'dislike';
	/** When the message landed (user: send time; assistant: reply completion). */
	readonly timestamp?: Date;
}

/** The model stream dropped; the harness is retrying with backoff. */
export interface ISessionReconnect {
	readonly attempt: number;
	readonly maxAttempts: number;
}

/** Real token count from the most recent request — ground truth for the context-window meter. */
export interface ISessionContextUsage {
	readonly inputTokens: number;
}

/** A tool call paused on the user's allow / deny. */
export interface ISessionPendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	/** One-line summary of what the tool wants to do (command, file path…). */
	readonly detail: string;
	respond(approved: boolean): void;
}

export interface ISession {
	readonly sessionId: string;
	readonly providerId: string;
	readonly sessionType: string;
	readonly icon: string;
	readonly createdAt: Date;
	readonly projectId: string | undefined;
	readonly workspace: IObservable<ISessionWorkspace | undefined>;
	readonly title: IObservable<string>;
	readonly updatedAt: IObservable<Date>;
	readonly status: IObservable<SessionStatus>;
	readonly description: IObservable<string | undefined>;
	readonly changesSummary: IObservable<ISessionChangesSummary | undefined>;
	readonly isArchived: IObservable<boolean>;
	readonly isRead: IObservable<boolean>;
	readonly isPinned: IObservable<boolean>;
	readonly messages: IObservable<readonly ISessionMessage[]>;
	readonly interactivity: IObservable<SessionInteractivity>;
	readonly pendingApproval: IObservable<ISessionPendingApproval | undefined>;
	readonly reconnect: IObservable<ISessionReconnect | undefined>;
	readonly permissionMode: IObservable<PermissionMode>;
	/** Undefined until the first real usage reading arrives; the UI falls back to an estimate until then. */
	readonly contextUsage: IObservable<ISessionContextUsage | undefined>;
}

export interface IActiveSession extends ISession {
	readonly isCreated: IObservable<boolean>;
	readonly sticky: IObservable<boolean>;
}
