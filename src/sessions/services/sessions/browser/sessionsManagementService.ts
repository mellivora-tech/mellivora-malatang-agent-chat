/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { PermissionMode } from '../../agent/common/agent.js';
import type { ISession } from '../common/session.js';
import type { ISessionsManagementService as ISessionsManagementServiceContract } from '../common/sessionsManagement.js';
import type { ISendMessageOptions, ISessionChangeEvent, ISessionsProvider, IStartSessionOptions } from '../common/sessionsProvider.js';
import type { ISessionsProvidersChangeEvent, ISessionsProvidersService } from './sessionsProvidersService.js';

export const ISessionsManagementService = createDecorator<ISessionsManagementServiceContract>('sessionsManagementService');

export class SessionsManagementService extends Disposable implements ISessionsManagementServiceContract {
	private readonly onDidChangeSessionsEmitter = new Emitter<ISessionChangeEvent>();
	private readonly providerListeners = new Map<string, IDisposable>();

	readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

	constructor(private readonly providersService: ISessionsProvidersService) {
		super();

		for (const provider of this.providersService.getProviders()) {
			this.attachProvider(provider);
		}

		this._register(this.providersService.onDidChangeProviders(event => this.onProvidersChanged(event)));
	}

	getSessions(): readonly ISession[] {
		return this.providersService.getProviders().flatMap(provider => provider.getSessions());
	}

	getSession(sessionId: string): ISession | undefined {
		return this.getSessions().find(session => session.sessionId === sessionId);
	}

	async startSession(query: string, options?: IStartSessionOptions): Promise<ISession> {
		const provider = this.providersService.getProviders()[0];
		if (!provider) {
			throw new Error('No sessions provider is registered');
		}

		return provider.startSession(query, options);
	}

	async sendMessage(sessionId: string, query: string, options?: ISendMessageOptions): Promise<ISession> {
		return this.getOwningProvider(sessionId).sendMessage(sessionId, query, options);
	}

	async renameSession(sessionId: string, title: string): Promise<ISession> {
		return this.getOwningProvider(sessionId).renameSession(sessionId, title);
	}

	async resolveMedia(sessionId: string, path: string): Promise<string | undefined> {
		try {
			return await this.getOwningProvider(sessionId).resolveMedia?.(sessionId, path);
		} catch {
			return undefined;
		}
	}

	async stopSession(sessionId: string): Promise<ISession> {
		return this.getOwningProvider(sessionId).stopSession(sessionId);
	}

	async setSessionPinned(sessionId: string, isPinned: boolean): Promise<ISession> {
		return this.getOwningProvider(sessionId).setSessionPinned(sessionId, isPinned);
	}

	async setSessionArchived(sessionId: string, isArchived: boolean): Promise<ISession> {
		return this.getOwningProvider(sessionId).setSessionArchived(sessionId, isArchived);
	}

	async setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<ISession> {
		return this.getOwningProvider(sessionId).setSessionPermissionMode(sessionId, mode);
	}

	async setMessageFeedback(sessionId: string, messageId: string, feedback: 'like' | 'dislike' | undefined): Promise<ISession> {
		return this.getOwningProvider(sessionId).setMessageFeedback(sessionId, messageId, feedback);
	}

	async forkSession(sessionId: string, messageId: string): Promise<ISession> {
		return this.getOwningProvider(sessionId).forkSession(sessionId, messageId);
	}

	async deleteSession(sessionId: string): Promise<void> {
		return this.getOwningProvider(sessionId).deleteSession(sessionId);
	}

	private getOwningProvider(sessionId: string): ISessionsProvider {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const provider = this.providersService.getProvider(session.providerId);
		if (!provider) {
			throw new Error(`Unknown provider: ${session.providerId}`);
		}

		return provider;
	}

	private onProvidersChanged(event: ISessionsProvidersChangeEvent): void {
		for (const provider of event.added) {
			this.attachProvider(provider);
		}

		for (const provider of event.removed) {
			this.providerListeners.get(provider.id)?.dispose();
			this.providerListeners.delete(provider.id);
		}

		if (event.added.length > 0 || event.removed.length > 0) {
			this.onDidChangeSessionsEmitter.fire({
				added: event.added.flatMap(provider => provider.getSessions()),
				removed: event.removed.flatMap(provider => provider.getSessions()),
				changed: [],
			});
		}
	}

	private attachProvider(provider: ISessionsProvider): void {
		if (this.providerListeners.has(provider.id)) {
			return;
		}

		const listener = provider.onDidChangeSessions(event => this.onDidChangeSessionsEmitter.fire(event));
		this.providerListeners.set(provider.id, listener);
		this._register(listener);
	}
}
