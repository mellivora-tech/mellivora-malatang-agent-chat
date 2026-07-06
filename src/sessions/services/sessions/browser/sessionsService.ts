/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { ISession } from '../common/session.js';
import type { ISessionsManagementService } from '../common/sessionsManagement.js';
import type { IStartSessionOptions } from '../common/sessionsProvider.js';
import { VisibleSessions } from './visibleSessions.js';
import type { ISessionsPartService } from './sessionsPartService.js';

export const ISessionsService = createDecorator<ISessionsService>('sessionsService');

export interface ISessionsService {
	readonly visibleSessions: VisibleSessions['visibleSessions'];
	readonly activeSession: VisibleSessions['activeSession'];
	getSessions(): readonly ISession[];
	startSession(query: string, options?: IStartSessionOptions): Promise<ISession>;
	openSession(sessionId: string): void;
	setActive(sessionId: string): void;
	closeSession(sessionId: string): void;
	sendMessage(sessionId: string, query: string): Promise<ISession>;
	stopSession(sessionId: string): Promise<ISession>;
}

export class SessionsService extends Disposable implements ISessionsService {
	readonly visibleSessions;
	readonly activeSession;

	private readonly visibleSessionsModel: VisibleSessions;

	constructor(
		private readonly managementService: ISessionsManagementService,
		private readonly sessionsPartService: ISessionsPartService,
	) {
		super();

		this.visibleSessionsModel = new VisibleSessions(this.managementService.getSessions());
		this.visibleSessions = this.visibleSessionsModel.visibleSessions;
		this.activeSession = this.visibleSessionsModel.activeSession;

		this._register(
			this.managementService.onDidChangeSessions(() => {
				this.visibleSessionsModel.setSessions(this.managementService.getSessions());
				this.syncPart();
			}),
		);
		this._register(this.visibleSessions.subscribe(() => this.syncPart()));
		this._register(this.activeSession.subscribe(() => this.syncPart()));
		this.syncPart();
	}

	getSessions(): readonly ISession[] {
		return this.managementService.getSessions();
	}

	async startSession(query: string, options?: IStartSessionOptions): Promise<ISession> {
		const session = await this.managementService.startSession(query, options);
		this.visibleSessionsModel.setSessions(this.managementService.getSessions());
		this.visibleSessionsModel.openOnly(session);
		this.sessionsPartService.showConversation(false);
		return session;
	}

	openSession(sessionId: string): void {
		const session = this.getRequiredSession(sessionId);
		this.visibleSessionsModel.openSession(session);
		this.sessionsPartService.showConversation();
	}

	setActive(sessionId: string): void {
		const session = this.getRequiredSession(sessionId);
		this.visibleSessionsModel.setActive(session);
		this.sessionsPartService.showConversation();
	}

	closeSession(sessionId: string): void {
		this.visibleSessionsModel.closeSession(sessionId);
	}

	async sendMessage(sessionId: string, query: string): Promise<ISession> {
		const session = await this.managementService.sendMessage(sessionId, query);
		this.visibleSessionsModel.setSessions(this.managementService.getSessions());
		this.visibleSessionsModel.setActive(session);
		this.sessionsPartService.showConversation();
		return session;
	}

	async stopSession(sessionId: string): Promise<ISession> {
		return this.managementService.stopSession(sessionId);
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
