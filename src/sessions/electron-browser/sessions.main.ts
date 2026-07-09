/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Workbench } from '../browser/workbench.js';

export class SessionsMain {
	async open(): Promise<void> {
		const workbench = new Workbench(document.body);
		workbench.startup();
	}
}
