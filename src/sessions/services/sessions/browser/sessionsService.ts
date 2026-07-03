/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IActiveSession, ISession } from '../common/session.js';
import type { ISessionsManagementService } from '../common/sessionsManagement.js';
import { VisibleSessions } from './visibleSessions.js';
import type { ISessionsPartService } from './sessionsPartService.js';

export const ISessionsService = createDecorator<ISessionsService>('sessionsService');

export interface ISessionsService {
	readonly visibleSessions: VisibleSessions['visibleSessions'];
	readonly activeSession: VisibleSessions['activeSession'];
	getSessions(): readonly ISession[];
	openSession(sessionId: string): void;
	setActive(sessionId: string): void;
	closeSession(sessionId: string): void;
	sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession>;
}

export class SessionsService extends Disposable implements ISessionsService {
	readonly visibleSessions;
	readonly activeSession;

	private readonly visibleSessionsModel: VisibleSessions;

	constructor(
		private readonly managementService: ISessionsManagementService,
		private readonly sessionsPartService: ISessionsPartService
	) {
		super();

		this.visibleSessionsModel = new VisibleSessions(this.managementService.getSessions());
		this.visibleSessions = this.visibleSessionsModel.visibleSessions;
		this.activeSession = this.visibleSessionsModel.activeSession;

		this._register(this.managementService.onDidChangeSessions(() => {
			this.visibleSessionsModel.setSessions(this.managementService.getSessions());
			this.syncPart();
		}));
		this._register(this.visibleSessions.subscribe(() => this.syncPart()));
		this._register(this.activeSession.subscribe(() => this.syncPart()));
		this.syncPart();
	}

	getSessions(): readonly ISession[] {
		return this.managementService.getSessions();
	}

	openSession(sessionId: string): void {
		const session = this.getRequiredSession(sessionId);
		this.visibleSessionsModel.openSession(session);
	}

	setActive(sessionId: string): void {
		const session = this.getRequiredSession(sessionId);
		this.visibleSessionsModel.setActive(session);
	}

	closeSession(sessionId: string): void {
		this.visibleSessionsModel.closeSession(sessionId);
	}

	async sendRequest(sessionId: string, chatId: string, query: string): Promise<ISession> {
		const session = await this.managementService.sendRequest(sessionId, chatId, query);
		this.visibleSessionsModel.setSessions(this.managementService.getSessions());
		this.visibleSessionsModel.setActive(session);
		return session;
	}

	private getRequiredSession(sessionId: string): ISession {
		const session = this.managementService.getSession(sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		return session;
	}

	private syncPart(): void {
		this.sessionsPartService.updateVisibleSessions(this.visibleSessions.get(), this.activeSession.get());
	}
}
