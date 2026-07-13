/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { PermissionMode } from '../../agent/common/agent.js';
import type { ISession } from './session.js';
import type { ISendMessageOptions, ISessionChangeEvent, IStartSessionOptions } from './sessionsProvider.js';

export interface ISessionsManagementService {
	getSessions(): readonly ISession[];
	getSession(sessionId: string): ISession | undefined;
	readonly onDidChangeSessions: Event<ISessionChangeEvent>;
	startSession(query: string, options?: IStartSessionOptions): Promise<ISession>;
	sendMessage(sessionId: string, query: string, options?: ISendMessageOptions): Promise<ISession>;
	stopSession(sessionId: string): Promise<ISession>;
	setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession>;
	setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession>;
	deleteSession(sessionId: string): Promise<void>;
	setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<ISession>;
	setMessageFeedback(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<ISession>;
	/** Set a plan artifact's review state (approved / superseded); overlaid onto the plan message like feedback. */
	setPlanState(sessionId: string, messageId: string, state: 'draft' | 'approved' | 'superseded'): Promise<ISession>;
	forkSession(sessionId: string, messageId: string): Promise<ISession>;
	renameSession(sessionId: string, title: string): Promise<ISession>;
	/** Data URL for a stored image attachment, for thumbnails. */
	resolveMedia(sessionId: string, path: string): Promise<string | undefined>;
}
