/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IDisposable {
	dispose(): void;
}

class FunctionDisposable implements IDisposable {
	private _isDisposed = false;

	constructor(private readonly fn: () => void) {}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}

		this._isDisposed = true;
		this.fn();
	}
}

export class DisposableStore implements IDisposable {
	private readonly disposables = new Set<IDisposable>();
	private isDisposed = false;

	add<T extends IDisposable>(disposable: T): T {
		if (disposable === (this as IDisposable)) {
			throw new Error('Cannot register a disposable on itself.');
		}

		if (this.isDisposed) {
			disposable.dispose();
			return disposable;
		}

		this.disposables.add(disposable);
		return disposable;
	}

	clear(): void {
		const snapshot = [...this.disposables];
		this.disposables.clear();

		for (const disposable of snapshot) {
			disposable.dispose();
		}
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.clear();
	}
}

export class Disposable implements IDisposable {
	static readonly None: IDisposable = Object.freeze({ dispose() {} });

	private readonly store = new DisposableStore();
	private isDisposed = false;

	protected _register<T extends IDisposable>(disposable: T): T {
		if (this.isDisposed) {
			disposable.dispose();
			return disposable;
		}

		return this.store.add(disposable);
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.store.dispose();
	}
}

export class MutableDisposable<T extends IDisposable> implements IDisposable {
	private currentValue: T | undefined;
	private isDisposed = false;

	get value(): T | undefined {
		return this.currentValue;
	}

	set value(value: T | undefined) {
		if (this.isDisposed) {
			value?.dispose();
			return;
		}

		if (this.currentValue === value) {
			return;
		}

		this.currentValue?.dispose();
		this.currentValue = value;
	}

	clear(): void {
		this.value = undefined;
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.currentValue?.dispose();
		this.currentValue = undefined;
	}
}

export function toDisposable(fn: () => void): IDisposable {
	return new FunctionDisposable(fn);
}
