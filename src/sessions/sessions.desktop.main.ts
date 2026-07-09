/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './sessions.common.main.js';
import { SessionsMain } from './electron-browser/sessions.main.js';

export async function main(): Promise<void> {
	await new SessionsMain().open();
}
