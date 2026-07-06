/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../../../base/common/observable.js';

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

export interface ISessionMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly text: string;
	readonly detail?: string;
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
}

export interface IActiveSession extends ISession {
	readonly isCreated: IObservable<boolean>;
	readonly sticky: IObservable<boolean>;
}
