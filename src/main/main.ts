/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = join(fileURLToPath(new URL('../..', import.meta.url)));

async function createWindow(): Promise<void> {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		title: 'Agent Chat',
		backgroundColor: '#1e1e1e',
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			preload: join(distRoot, 'preload/preload.js'),
			contextIsolation: true,
			nodeIntegration: false
		}
	});

	await win.loadFile(join(distRoot, 'sessions/electron-browser/sessions.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
