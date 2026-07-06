/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { ISession } from './session.js';

export interface ISessionChangeEvent {
	readonly added: readonly ISession[];
	readonly removed: readonly ISession[];
	readonly changed: readonly ISession[];
}

export interface ISessionsProvider {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly order: number;
	getSessions(): readonly ISession[];
	readonly onDidChangeSessions: Event<ISessionChangeEvent>;
	startSession(query: string): Promise<ISession>;
	sendMessage(sessionId: string, query: string): Promise<ISession>;
	stopSession(sessionId: string): Promise<ISession>;
}
