/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import type { IAppState } from '../sessions/services/appState/common/appState.js';
import { readAppState, writeAppState } from './appStateStorage.js';

export function registerAppStateIpc(dataRoot: string): void {
	registerHandler('appState:get', () => readAppState(dataRoot));
	// Shallow merge, not replace: callers set the one field they own (the project
	// list sets activeProjectId, settings set loggingMode) and must not clobber
	// each other. Consequence: a field can be overwritten but never cleared via
	// this channel — nothing needs clearing today.
	registerHandler('appState:set', async (_event, state: IAppState) => writeAppState(dataRoot, { ...(await readAppState(dataRoot)), ...state }));
}
