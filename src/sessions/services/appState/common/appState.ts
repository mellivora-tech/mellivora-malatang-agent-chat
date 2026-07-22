/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LoggingMode } from '../../logs/common/logs.js';

/** Persisted UI state (state.json at the data root). */
export interface IAppState {
	readonly activeProjectId?: string;
	/** Absent = 'errors' (failure events only). See logs/common/logs.ts. */
	readonly loggingMode?: LoggingMode;
}

/** The shape exposed on `agentWindow.appState` by the preload script. */
export interface IAppStateBridge {
	get(): Promise<IAppState>;
	set(state: IAppState): Promise<void>;
}
