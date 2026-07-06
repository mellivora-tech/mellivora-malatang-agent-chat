/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IAppLifecycleHost {
	readonly platform: NodeJS.Platform;
	getWindowCount(): number;
	createWindow(): Promise<void>;
	quit(): void;
}

export function handleWindowAllClosed(host: IAppLifecycleHost): void {
	if (host.platform !== 'darwin') {
		host.quit();
	}
}

export function handleActivate(host: IAppLifecycleHost): void {
	if (host.getWindowCount() === 0) {
		void host.createWindow();
	}
}
