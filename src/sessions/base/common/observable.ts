/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from './event.js';
import { DisposableStore, IDisposable, toDisposable } from './lifecycle.js';

export interface IObservable<T> {
	get(): T;
	subscribe(listener: (value: T) => void): IDisposable;
}

export class ObservableValue<T> implements IObservable<T>, IDisposable {
	private value: T;
	private readonly emitter = new Emitter<T>();

	constructor(value: T) {
		this.value = value;
	}

	get(): T {
		return this.value;
	}

	set(value: T): void {
		if (Object.is(this.value, value)) {
			return;
		}

		this.value = value;
		this.emitter.fire(value);
	}

	subscribe(listener: (value: T) => void): IDisposable {
		return this.emitter.event(listener);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

class DerivedObservable<T> implements IObservable<T>, IDisposable {
	private readonly emitter = new Emitter<T>();
	private readonly subscriptions = new DisposableStore();
	private readonly listeners = new Set<(value: T) => void>();
	private currentValue: T;

	constructor(
		private readonly read: () => T,
		private readonly dependencies: readonly IObservable<unknown>[]
	) {
		this.currentValue = this.read();
	}

	get(): T {
		this.currentValue = this.read();
		return this.currentValue;
	}

	subscribe(listener: (value: T) => void): IDisposable {
		if (this.listeners.size === 0) {
			this.bindDependencies();
		}

		this.listeners.add(listener);
		const subscription = this.emitter.event(listener);

		return toDisposable(() => {
			subscription.dispose();
			this.listeners.delete(listener);

			if (this.listeners.size === 0) {
				this.subscriptions.clear();
			}
		});
	}

	dispose(): void {
		this.subscriptions.dispose();
		this.listeners.clear();
		this.emitter.dispose();
	}

	private bindDependencies(): void {
		for (const dependency of this.dependencies) {
			this.subscriptions.add(dependency.subscribe(() => {
				const nextValue = this.read();
				if (Object.is(this.currentValue, nextValue)) {
					return;
				}

				this.currentValue = nextValue;
				this.emitter.fire(nextValue);
			}));
		}
	}
}

export function observableValue<T>(value: T): ObservableValue<T> {
	return new ObservableValue(value);
}

export function derived<T>(read: () => T, dependencies: readonly IObservable<unknown>[]): IObservable<T> {
	return new DerivedObservable(read, dependencies);
}
