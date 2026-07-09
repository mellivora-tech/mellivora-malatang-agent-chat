/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Persisted UI state (state.json at the data root). */
export interface IAppState {
	readonly activeProjectId?: string;
}

/** The shape exposed on `agentWindow.appState` by the preload script. */
export interface IAppStateBridge {
	get(): Promise<IAppState>;
	set(state: IAppState): Promise<void>;
}
