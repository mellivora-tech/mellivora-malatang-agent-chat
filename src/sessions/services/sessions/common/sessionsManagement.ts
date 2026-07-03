/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { ISession } from './session.js';
import type { ISessionChangeEvent } from './sessionsProvider.js';

export interface ISessionsManagementService {
	getSessions(): readonly ISession[];
	getSession(sessionId: string): ISession | undefined;
	readonly onDidChangeSessions: Event<ISessionChangeEvent>;
	sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession>;
}
