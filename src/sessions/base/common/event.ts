/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from './lifecycle.js';

export type Event<T> = (listener: (event: T) => void) => IDisposable;

export class Emitter<T> implements IDisposable {
	private readonly listeners = new Set<(event: T) => void>();
	private isDisposed = false;

	readonly event: Event<T> = listener => {
		if (this.isDisposed) {
			return toDisposable(() => {});
		}

		this.listeners.add(listener);
		return toDisposable(() => {
			this.listeners.delete(listener);
		});
	};

	fire(event: T): void {
		if (this.isDisposed || this.listeners.size === 0) {
			return;
		}

		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.listeners.clear();
	}
}
