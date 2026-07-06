/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../base/common/event.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { createDecorator } from '../instantiation/instantiation.js';

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService');

export interface IContextKey<T> {
	set(value: T): void;
	reset(): void;
	get(): T | undefined;
}

export interface IContextKeyChangeEvent {
	readonly key: string;
}

export interface IContextKeyService {
	readonly onDidChangeContext: Event<IContextKeyChangeEvent>;
	createKey<T>(key: string, defaultValue: T | undefined): IContextKey<T>;
	getContextKeyValue<T>(key: string): T | undefined;
	createScoped(target: HTMLElement): IContextKeyService;
}

class ContextKey<T> implements IContextKey<T> {
	constructor(
		private readonly service: ContextKeyService,
		private readonly key: string,
		private readonly defaultValue: T | undefined,
	) {}

	set(value: T): void {
		this.service.setValue(this.key, value);
	}

	reset(): void {
		this.service.setValue(this.key, this.defaultValue);
	}

	get(): T | undefined {
		return this.service.getContextKeyValue(this.key);
	}
}

export class RawContextKey<T> {
	constructor(
		readonly key: string,
		readonly defaultValue: T | undefined,
		readonly description?: string,
	) {}

	bindTo(target: IContextKeyService): IContextKey<T> {
		return target.createKey(this.key, this.defaultValue);
	}
}

export class ContextKeyService extends Disposable implements IContextKeyService {
	private readonly values = new Map<string, unknown>();
	private readonly scopedChildren = new Set<ContextKeyService>();
	private readonly onDidChangeContextEmitter = this._register(new Emitter<IContextKeyChangeEvent>());

	readonly onDidChangeContext = this.onDidChangeContextEmitter.event;

	constructor(private readonly parent?: ContextKeyService) {
		super();
	}

	createKey<T>(key: string, defaultValue: T | undefined): IContextKey<T> {
		if (defaultValue !== undefined && !this.values.has(key)) {
			this.values.set(key, defaultValue);
		}

		return new ContextKey(this, key, defaultValue);
	}

	getContextKeyValue<T>(key: string): T | undefined {
		if (this.values.has(key)) {
			return this.values.get(key) as T | undefined;
		}

		return this.parent?.getContextKeyValue<T>(key);
	}

	createScoped(target: HTMLElement): IContextKeyService {
		const scoped = new ContextKeyService(this);
		this.scopedChildren.add(scoped);
		target.dataset.contextScope = 'true';

		return scoped;
	}

	override dispose(): void {
		for (const child of [...this.scopedChildren]) {
			child.dispose();
		}

		this.scopedChildren.clear();
		super.dispose();
	}

	setValue(key: string, value: unknown): void {
		const currentValue = this.values.get(key);
		if (Object.is(currentValue, value) && this.values.has(key)) {
			return;
		}

		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}

		this.onDidChangeContextEmitter.fire({ key });
	}
}

export function createScopedContextKeyService(parent: IContextKeyService, target: HTMLElement): IContextKeyService {
	return parent.createScoped(target);
}
