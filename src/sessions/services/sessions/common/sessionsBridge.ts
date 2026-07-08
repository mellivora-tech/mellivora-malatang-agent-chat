/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Data contracts for the file-backed sessions store, shared between the main
 * process and the renderer. Pure JSON shapes: dates are ISO strings and the
 * session status is a plain number (the renderer maps it to SessionStatus so
 * const-enum values never cross the main bundle boundary).
 */

export interface ISessionRef {
	readonly sessionId: string;
	readonly projectId?: string;
}

export interface ISessionWorkspaceData {
	readonly label: string;
	readonly description?: string;
	readonly branchName?: string;
}

export interface ISessionChangesSummaryData {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface ISessionHeader {
	readonly type: 'session';
	readonly version: 1;
	readonly sessionId: string;
	readonly projectId?: string;
	readonly sessionType: string;
	readonly icon: string;
	readonly createdAt: string;
	readonly workspace?: ISessionWorkspaceData;
	readonly interactivity: 'full' | 'read-only' | 'hidden';
}

/** One step inside a work block: a thinking stretch or a tool call. */
export interface ISessionWorkStepData {
	readonly kind: 'thinking' | 'tool';
	readonly label: string;
	readonly durationMs: number;
	readonly detail?: string;
}

export interface ISessionMessageEntry {
	readonly type: 'message';
	readonly id: string;
	/** 'work' entries summarize one agent run: total duration plus its steps. */
	readonly role: 'user' | 'assistant' | 'tool' | 'work';
	readonly text: string;
	readonly detail?: string;
	readonly timestamp: string;
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStepData[];
}

export interface ISessionStateEntry {
	readonly type: 'state';
	readonly timestamp: string;
	readonly status?: number;
	readonly title?: string;
	readonly description?: string;
	readonly changesSummary?: ISessionChangesSummaryData;
	readonly isArchived?: boolean;
	readonly isRead?: boolean;
	readonly isPinned?: boolean;
}

export type ISessionEntry = ISessionMessageEntry | ISessionStateEntry;

export interface ISessionSnapshotMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool' | 'work';
	readonly text: string;
	readonly detail?: string;
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStepData[];
}

/** The hydrated result of folding one session file. */
export interface ISessionSnapshot {
	readonly sessionId: string;
	readonly projectId?: string;
	readonly sessionType: string;
	readonly icon: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly workspace?: ISessionWorkspaceData;
	readonly interactivity: 'full' | 'read-only' | 'hidden';
	readonly title: string;
	readonly status: number;
	readonly description?: string;
	readonly changesSummary?: ISessionChangesSummaryData;
	readonly isArchived: boolean;
	readonly isRead: boolean;
	readonly isPinned: boolean;
	readonly messages: readonly ISessionSnapshotMessage[];
}

/** The shape exposed on `agentWindow.sessions` by the preload script. */
export interface ISessionsBridge {
	list(): Promise<readonly ISessionSnapshot[]>;
	create(header: ISessionHeader): Promise<void>;
	append(ref: ISessionRef, entry: ISessionEntry): Promise<void>;
	delete(ref: ISessionRef): Promise<void>;
}
