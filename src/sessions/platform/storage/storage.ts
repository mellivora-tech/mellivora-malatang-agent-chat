/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../base/common/event.js';
import { Emitter } from '../../base/common/event.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { createDecorator } from '../instantiation/instantiation.js';

export const IStorageService = createDecorator<IStorageService>('storageService');

export const enum StorageScope {
	APPLICATION = 'application',
	PROFILE = 'profile',
	WORKSPACE = 'workspace',
}

export const enum StorageTarget {
	USER = 'user',
	MACHINE = 'machine',
}

export interface IStorageChangeEvent {
	readonly key: string;
	readonly scope: StorageScope;
}

export interface IStorageService {
	readonly onDidChangeValue: Event<IStorageChangeEvent>;
	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined;
	store(key: string, value: string | boolean | number | undefined, scope: StorageScope, target: StorageTarget): void;
	remove(key: string, scope: StorageScope): void;
	keys(scope: StorageScope, target: StorageTarget): string[];
}

type StorageValue = {
	readonly value: string;
	readonly target: StorageTarget;
};

export class InMemoryStorageService implements IStorageService, IDisposable {
	private readonly stores = new Map<StorageScope, Map<string, StorageValue>>();
	private readonly onDidChangeValueEmitter = new Emitter<IStorageChangeEvent>();

	readonly onDidChangeValue = this.onDidChangeValueEmitter.event;

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		return this.getStore(scope).get(key)?.value ?? fallbackValue;
	}

	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.get(key, scope);
		if (value === undefined) {
			return fallbackValue;
		}

		return value === 'true';
	}

	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.get(key, scope);
		if (value === undefined) {
			return fallbackValue;
		}

		const parsed = Number(value);
		return Number.isNaN(parsed) ? fallbackValue : parsed;
	}

	store(key: string, value: string | boolean | number | undefined, scope: StorageScope, target: StorageTarget): void {
		if (value === undefined) {
			this.remove(key, scope);
			return;
		}

		const serialized = String(value);
		const store = this.getStore(scope);
		const currentValue = store.get(key);
		if (currentValue && currentValue.value === serialized && currentValue.target === target) {
			return;
		}

		store.set(key, { value: serialized, target });
		this.onDidChangeValueEmitter.fire({ key, scope });
	}

	remove(key: string, scope: StorageScope): void {
		const store = this.getStore(scope);
		if (!store.delete(key)) {
			return;
		}

		this.onDidChangeValueEmitter.fire({ key, scope });
	}

	keys(scope: StorageScope, target: StorageTarget): string[] {
		return [...this.getStore(scope).entries()].filter(([, value]) => value.target === target).map(([key]) => key);
	}

	dispose(): void {
		this.stores.clear();
		this.onDidChangeValueEmitter.dispose();
	}

	private getStore(scope: StorageScope): Map<string, StorageValue> {
		let store = this.stores.get(scope);
		if (!store) {
			store = new Map<string, StorageValue>();
			this.stores.set(scope, store);
		}

		return store;
	}
}
