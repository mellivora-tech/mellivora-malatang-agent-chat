/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { ISession } from './session.js';
import type { ISessionChangeEvent, IStartSessionOptions } from './sessionsProvider.js';

export interface ISessionsManagementService {
	getSessions(): readonly ISession[];
	getSession(sessionId: string): ISession | undefined;
	readonly onDidChangeSessions: Event<ISessionChangeEvent>;
	startSession(query: string, options?: IStartSessionOptions): Promise<ISession>;
	sendMessage(sessionId: string, query: string): Promise<ISession>;
	stopSession(sessionId: string): Promise<ISession>;
	setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession>;
	setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession>;
}
