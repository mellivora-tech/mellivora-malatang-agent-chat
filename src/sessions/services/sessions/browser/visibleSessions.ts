/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { derived, observableValue, type IObservable } from '../../../base/common/observable.js';
import { SessionStatus, type IActiveSession, type ISession } from '../common/session.js';

class ActiveSession implements IActiveSession {
	readonly isCreated: IObservable<boolean>;
	readonly sticky = observableValue(false);

	constructor(private readonly session: ISession) {
		this.isCreated = derived(() => this.session.status.get() !== SessionStatus.Untitled, [this.session.status]);
	}

	get sessionId() {
		return this.session.sessionId;
	}
	get providerId() {
		return this.session.providerId;
	}
	get sessionType() {
		return this.session.sessionType;
	}
	get icon() {
		return this.session.icon;
	}
	get createdAt() {
		return this.session.createdAt;
	}
	get projectId() {
		return this.session.projectId;
	}
	get workspace() {
		return this.session.workspace;
	}
	get title() {
		return this.session.title;
	}
	get updatedAt() {
		return this.session.updatedAt;
	}
	get status() {
		return this.session.status;
	}
	get description() {
		return this.session.description;
	}
	get changesSummary() {
		return this.session.changesSummary;
	}
	get isArchived() {
		return this.session.isArchived;
	}
	get isRead() {
		return this.session.isRead;
	}
	get isPinned() {
		return this.session.isPinned;
	}
	get messages() {
		return this.session.messages;
	}
	get interactivity() {
		return this.session.interactivity;
	}
	get pendingApproval() {
		return this.session.pendingApproval;
	}
	get reconnect() {
		return this.session.reconnect;
	}
	get permissionMode() {
		return this.session.permissionMode;
	}
}

export class VisibleSessions {
	readonly visibleSessions = observableValue<readonly (IActiveSession | undefined)[]>([undefined]);
	readonly activeSession = observableValue<IActiveSession | undefined>(undefined);

	private readonly activeSessions = new Map<string, IActiveSession>();
	private sessions: readonly ISession[] = [];

	constructor(sessions: readonly ISession[]) {
		this.setSessions(sessions);
	}

	setSessions(sessions: readonly ISession[]): void {
		this.sessions = sessions;
		const availableIds = new Set(sessions.map(session => session.sessionId));
		for (const sessionId of [...this.activeSessions.keys()]) {
			if (!availableIds.has(sessionId)) {
				this.activeSessions.delete(sessionId);
			}
		}

		const nextVisible = this.visibleSessions
			.get()
			.filter((session): session is IActiveSession => session !== undefined && availableIds.has(session.sessionId))
			.map(session => this.toActiveSession(this.getRequiredSession(session.sessionId)));

		if (nextVisible.length === 0 && sessions.length > 0) {
			nextVisible.push(this.toActiveSession(sessions[0]!));
		}

		const nextActive = this.resolveNextActive(nextVisible, sessions);
		this.visibleSessions.set(nextVisible.length > 0 ? nextVisible : [undefined]);
		this.activeSession.set(nextActive);
	}

	openSession(session: ISession): void {
		const activeSession = this.toActiveSession(session);
		this.visibleSessions.set([activeSession]);
		this.activeSession.set(activeSession);
	}

	openOnly(session: ISession): void {
		const activeSession = this.toActiveSession(session);
		this.visibleSessions.set([activeSession]);
		this.activeSession.set(activeSession);
	}

	setActive(session: ISession): void {
		const visible = this.visibleSessions.get().find(candidate => candidate?.sessionId === session.sessionId);
		if (visible) {
			this.activeSession.set(visible);
			return;
		}

		this.openSession(session);
	}

	closeSession(sessionId: string): void {
		const currentVisible = this.visibleSessions.get().filter((session): session is IActiveSession => session !== undefined);
		const closingIndex = currentVisible.findIndex(session => session.sessionId === sessionId);
		if (closingIndex === -1) {
			return;
		}

		const nextVisible = currentVisible.filter(session => session.sessionId !== sessionId);
		if (nextVisible.length === 0 && this.sessions.length > 0) {
			const fallback = this.sessions.find(session => session.sessionId !== sessionId);
			if (fallback) {
				nextVisible.push(this.toActiveSession(fallback));
			}
		}

		const active = this.activeSession.get();
		const nextActive = active?.sessionId === sessionId ? nextVisible[Math.max(0, closingIndex - 1)] : active;

		this.visibleSessions.set(nextVisible.length > 0 ? nextVisible : [undefined]);
		this.activeSession.set(nextActive);
	}

	private resolveNextActive(visibleSessions: readonly IActiveSession[], sessions: readonly ISession[]): IActiveSession | undefined {
		const currentActiveId = this.activeSession.get()?.sessionId;
		if (currentActiveId) {
			const stillVisible = visibleSessions.find(session => session.sessionId === currentActiveId);
			if (stillVisible) {
				return stillVisible;
			}
		}

		if (visibleSessions.length > 0) {
			return visibleSessions[0];
		}

		return sessions.length > 0 ? this.toActiveSession(sessions[0]!) : undefined;
	}

	private toActiveSession(session: ISession): IActiveSession {
		let activeSession = this.activeSessions.get(session.sessionId);
		if (!activeSession) {
			activeSession = new ActiveSession(session);
			this.activeSessions.set(session.sessionId, activeSession);
		}

		return activeSession;
	}

	private getRequiredSession(sessionId: string): ISession {
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		return session;
	}
}
