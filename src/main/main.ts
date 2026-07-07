/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAgentIpc } from './agentIpc.js';
import { handleActivate, handleWindowAllClosed } from './appLifecycle.js';
import { registerAppStateIpc } from './appStateIpc.js';
import { registerModelConfigIpc } from './modelConfigIpc.js';
import { registerProjectsIpc } from './projectsIpc.js';
import { ensureProjectsRoot, resolveDataRoot } from './projectsStorage.js';
import { registerSessionsIpc } from './sessionsIpc.js';
import { getInitialWindowBackgroundColor } from './windowTheme.js';

const distRoot = join(fileURLToPath(new URL('..', import.meta.url)));

const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

async function createWindow(): Promise<void> {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		title: 'Agent Chat',
		backgroundColor: getInitialWindowBackgroundColor(),
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			preload: join(distRoot, 'preload/preload.mjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	if (rendererUrl) {
		await win.loadURL(new URL('sessions.html', rendererUrl).toString());
	} else {
		await win.loadFile(join(distRoot, 'sessions/electron-browser/sessions.html'));
	}
}

const lifecycleHost = {
	platform: process.platform,
	getWindowCount: () => BrowserWindow.getAllWindows().length,
	createWindow,
	quit: () => app.quit(),
};

const dataRoot = resolveDataRoot(process.env, homedir());

app.whenReady().then(async () => {
	await ensureProjectsRoot(dataRoot);
	registerProjectsIpc(dataRoot);
	registerSessionsIpc(dataRoot);
	registerAppStateIpc(dataRoot);
	registerModelConfigIpc(dataRoot);
	registerAgentIpc(dataRoot);
	await createWindow();
});
app.on('window-all-closed', () => handleWindowAllClosed(lifecycleHost));
app.on('activate', () => handleActivate(lifecycleHost));
