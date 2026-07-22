/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import type { IAppState } from '../sessions/services/appState/common/appState.js';
import { readAppState, writeAppState } from './appStateStorage.js';

export function registerAppStateIpc(dataRoot: string): void {
	registerHandler('appState:get', () => readAppState(dataRoot));
	registerHandler('appState:set', (_event, state: IAppState) => writeAppState(dataRoot, state));
}
