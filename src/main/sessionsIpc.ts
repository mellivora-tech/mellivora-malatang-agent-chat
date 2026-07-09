/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { ISessionEntry, ISessionHeader, ISessionRef } from '../sessions/services/sessions/common/sessionsBridge.js';
import { appendSessionEntry, createSessionFile, deleteSessionFile, loadAllSessions } from './sessionsStorage.js';

export function registerSessionsIpc(dataRoot: string): void {
	ipcMain.handle('sessions:list', () => loadAllSessions(dataRoot));
	ipcMain.handle('sessions:create', (_event, header: ISessionHeader) => createSessionFile(dataRoot, header));
	ipcMain.handle('sessions:append', (_event, ref: ISessionRef, entry: ISessionEntry) => appendSessionEntry(dataRoot, ref, entry));
	ipcMain.handle('sessions:delete', (_event, ref: ISessionRef) => deleteSessionFile(dataRoot, ref));
}
