/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';
import type { IObservable } from '../../../../base/common/observable.js';

/**
 * Subscribes a component directly to one of the app's IObservable stores, so
 * it re-renders itself on a change instead of relying on a parent-level
 * "dirty flag + force a resync" dance (the pattern the old DOM patcher needed
 * because it couldn't tell "the store fired" from "the message prop changed").
 */
export function useObservable<T>(observable: IObservable<T> | undefined, fallback: T): T {
	return useSyncExternalStore(
		onStoreChange => {
			if (!observable) {
				return () => {};
			}
			const disposable = observable.subscribe(() => onStoreChange());
			return () => disposable.dispose();
		},
		() => observable?.get() ?? fallback,
	);
}
