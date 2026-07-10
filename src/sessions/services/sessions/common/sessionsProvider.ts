/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { PermissionMode } from '../../agent/common/agent.js';
import type { ISession, ISessionAttachment, ISessionWorkspace } from './session.js';

export interface ISessionChangeEvent {
	readonly added: readonly ISession[];
	readonly removed: readonly ISession[];
	readonly changed: readonly ISession[];
}

/** An image captured in the composer, not yet written to session media (raw base64, no data: prefix). */
export interface IPendingImage {
	readonly data: string;
	readonly mediaType: string;
}

export interface IStartSessionOptions {
	readonly workspace?: ISessionWorkspace;
	readonly projectId?: string;
	readonly attachments?: readonly ISessionAttachment[];
	readonly images?: readonly IPendingImage[];
}

export interface ISendMessageOptions {
	readonly attachments?: readonly ISessionAttachment[];
	readonly images?: readonly IPendingImage[];
}

export interface ISessionsProvider {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly order: number;
	getSessions(): readonly ISession[];
	readonly onDidChangeSessions: Event<ISessionChangeEvent>;
	startSession(query: string, options?: IStartSessionOptions): Promise<ISession>;
	sendMessage(sessionId: string, query: string, options?: ISendMessageOptions): Promise<ISession>;
	stopSession(sessionId: string): Promise<ISession>;
	setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession>;
	setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession>;
	deleteSession(sessionId: string): Promise<void>;
	setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<ISession>;
	setMessageFeedback(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<ISession>;
	/** Duplicate the session's history up to (and including) `messageId` into a new session. */
	forkSession(sessionId: string, messageId: string): Promise<ISession>;
	/** Data URL for a stored image attachment, for thumbnails. Optional; undefined when unavailable. */
	resolveMedia?(sessionId: string, path: string): Promise<string | undefined>;
}
