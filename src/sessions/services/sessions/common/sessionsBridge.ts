/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
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
	readonly kind: 'thinking' | 'tool' | 'narration';
	readonly label: string;
	readonly durationMs: number;
	readonly detail?: string;
}

/** A structured reference attached to a user message (@-mentioned file/folder, a stored image, or a $-mentioned skill). */
export interface ISessionAttachmentData {
	readonly kind: 'file' | 'folder' | 'image' | 'skill' | 'session';
	readonly path: string;
	/** Images only: e.g. 'image/png'. */
	readonly mediaType?: string;
	/** Human-readable name for chips (session title at attach time). */
	readonly label?: string;
}

export interface ISessionMessageEntry {
	readonly type: 'message';
	readonly id: string;
	/** 'work' entries summarize one agent run: total duration plus its steps. */
	readonly role: 'user' | 'assistant' | 'tool' | 'work';
	readonly text: string;
	readonly attachments?: readonly ISessionAttachmentData[];
	readonly detail?: string;
	readonly timestamp: string;
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStepData[];
}

/** User feedback on a single message; the last entry per message wins. */
export interface ISessionFeedbackEntry {
	readonly type: 'feedback';
	readonly messageId: string;
	readonly feedback: 'like' | 'dislike' | null;
	readonly timestamp: string;
}

/**
 * A compaction summary persisted with the session. `covered` counts the prefix
 * of the transcript (as toTranscript builds it) the summary stands in for;
 * `prefixChars` is that prefix's content size for the main-side integrity gate.
 */
export interface ISessionCompactionAnchorData {
	readonly summary: string;
	readonly covered: number;
	readonly prefixChars: number;
}

/**
 * The context meter's last known reading, persisted so a reopened session
 * shows the previous run's real bill (labeled "last run") instead of a blank
 * estimate. `inputTokens` is a real provider count; the breakdown chars are
 * the char/4-estimated category rows from the same moment.
 */
export interface ISessionContextUsageData {
	readonly inputTokens: number;
	readonly breakdown?: {
		readonly systemChars: number;
		readonly instructionsChars: number;
		readonly skillsChars: number;
		readonly toolsChars: number;
		readonly messagesChars: number;
		readonly compactedChars: number;
		readonly prunedChars: number;
	};
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
	readonly permissionMode?: string;
	readonly compactionAnchor?: ISessionCompactionAnchorData;
	readonly contextUsage?: ISessionContextUsageData;
}

export type ISessionEntry = ISessionMessageEntry | ISessionStateEntry | ISessionFeedbackEntry;

export interface ISessionSnapshotMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool' | 'work';
	readonly text: string;
	readonly attachments?: readonly ISessionAttachmentData[];
	readonly detail?: string;
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStepData[];
	readonly feedback?: 'like' | 'dislike';
	readonly timestamp?: string;
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
	readonly permissionMode?: string;
	readonly compactionAnchor?: ISessionCompactionAnchorData;
	readonly contextUsage?: ISessionContextUsageData;
	readonly messages: readonly ISessionSnapshotMessage[];
}

/** The shape exposed on `agentWindow.sessions` by the preload script. */
export interface ISessionsBridge {
	list(): Promise<readonly ISessionSnapshot[]>;
	create(header: ISessionHeader): Promise<void>;
	append(ref: ISessionRef, entry: ISessionEntry): Promise<void>;
	delete(ref: ISessionRef): Promise<void>;
	/** Store one attached image (raw base64); returns the entry path (`media/<sessionId>/<hash>.<ext>`). Optional for older preloads/test doubles. */
	storeMedia?(ref: ISessionRef, base64: string, mediaType: string): Promise<string>;
	/** Read a stored image back as raw base64; undefined when missing. */
	readMedia?(ref: ISessionRef, entryPath: string): Promise<string | undefined>;
}
