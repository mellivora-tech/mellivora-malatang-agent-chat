/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { ISessionsProvider } from '../common/sessionsProvider.js';

export const ISessionsProvidersService = createDecorator<ISessionsProvidersService>('sessionsProvidersService');

export interface ISessionsProvidersChangeEvent {
	readonly added: readonly ISessionsProvider[];
	readonly removed: readonly ISessionsProvider[];
}

export interface ISessionsProvidersService {
	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent>;
	getProviders(): readonly ISessionsProvider[];
	getProvider(providerId: string): ISessionsProvider | undefined;
	registerProvider(provider: ISessionsProvider): IDisposable;
}

interface IProviderEntry {
	readonly provider: ISessionsProvider;
	readonly index: number;
}

export class SessionsProvidersService implements ISessionsProvidersService {
	private readonly providers: IProviderEntry[] = [];
	private readonly onDidChangeProvidersEmitter = new Emitter<ISessionsProvidersChangeEvent>();
	private registrationIndex = 0;

	readonly onDidChangeProviders = this.onDidChangeProvidersEmitter.event;

	getProviders(): readonly ISessionsProvider[] {
		return this.providers.map(entry => entry.provider);
	}

	getProvider(providerId: string): ISessionsProvider | undefined {
		return this.providers.find(entry => entry.provider.id === providerId)?.provider;
	}

	registerProvider(provider: ISessionsProvider): IDisposable {
		if (this.getProvider(provider.id)) {
			throw new Error(`A sessions provider with id "${provider.id}" is already registered.`);
		}

		const entry: IProviderEntry = { provider, index: this.registrationIndex++ };
		this.providers.push(entry);
		this.providers.sort((left, right) => {
			if (left.provider.order === right.provider.order) {
				return left.index - right.index;
			}

			return left.provider.order - right.provider.order;
		});
		this.onDidChangeProvidersEmitter.fire({ added: [provider], removed: [] });

		return toDisposable(() => {
			const index = this.providers.findIndex(candidate => candidate.provider.id === provider.id);
			if (index === -1) {
				return;
			}

			this.providers.splice(index, 1);
			this.onDidChangeProvidersEmitter.fire({ added: [], removed: [provider] });
		});
	}
}
