/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAgentIpc } from './agentIpc.js';
import { agentLog } from './agent/observability/agentLog.js';
import { registerGitIpc } from './gitIpc.js';
import { registerSkillsIpc } from './skillsIpc.js';
import { registerEnvironmentsIpc } from './environmentsIpc.js';
import { registerDataFilesIpc } from './dataFilesIpc.js';
import { handleActivate, handleWindowAllClosed } from './appLifecycle.js';
import { registerAppStateIpc } from './appStateIpc.js';
import { registerModelConfigIpc } from './modelConfigIpc.js';
import { registerProjectsIpc } from './projectsIpc.js';
import { ensureProjectsRoot, resolveDataRoot } from './projectsStorage.js';
import { registerSessionsIpc } from './sessionsIpc.js';
import { getInitialWindowBackgroundColor } from './windowTheme.js';

const distRoot = join(fileURLToPath(new URL('..', import.meta.url)));

const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

// The packaged app takes its Dock/taskbar icon from the bundled .icns/.ico; in dev
// Electron shows its own default, so point the macOS Dock at the generated icon.
function applyDevDockIcon(): void {
	if (process.platform !== 'darwin' || app.isPackaged || !app.dock) {
		return;
	}
	const iconPath = join(distRoot, '..', 'build', 'icon.png');
	if (existsSync(iconPath)) {
		app.dock.setIcon(iconPath);
	}
}

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
	applyDevDockIcon();
	await ensureProjectsRoot(dataRoot);
	registerProjectsIpc(dataRoot);
	registerSessionsIpc(dataRoot);
	registerAppStateIpc(dataRoot);
	registerModelConfigIpc(dataRoot);
	registerAgentIpc(dataRoot);
	registerGitIpc(dataRoot);
	registerSkillsIpc(dataRoot);
	registerEnvironmentsIpc(dataRoot);
	registerDataFilesIpc();
	await createWindow();
});
// Flush any buffered agent logs before the process exits.
app.on('will-quit', () => agentLog.dispose());
app.on('window-all-closed', () => handleWindowAllClosed(lifecycleHost));
app.on('activate', () => handleActivate(lifecycleHost));
