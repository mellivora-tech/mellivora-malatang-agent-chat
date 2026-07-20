/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { ISessionEntry, ISessionHeader, ISessionRef } from '../sessions/services/sessions/common/sessionsBridge.js';
import { appendArtifact, extractArtifactsFromEntries, removeSessionArtifacts } from './artifactsStorage.js';
import { appendSessionEntry, createSessionFile, deleteSessionFile, loadAllSessions, readSessionMedia, storeSessionMedia } from './sessionsStorage.js';

export function registerSessionsIpc(dataRoot: string): void {
	ipcMain.handle('sessions:list', () => loadAllSessions(dataRoot));
	ipcMain.handle('sessions:create', (_event, header: ISessionHeader) => createSessionFile(dataRoot, header));
	ipcMain.handle('sessions:append', async (_event, ref: ISessionRef, entry: ISessionEntry) => {
		await appendSessionEntry(dataRoot, ref, entry);
		// Artifact capture (#13 P0) is best-effort: the index is a rebuildable
		// mirror, so its failures must never surface into the transcript write.
		try {
			for (const line of extractArtifactsFromEntries(ref.sessionId, ref.projectId, [entry])) {
				await appendArtifact(dataRoot, line);
			}
		} catch (error) {
			console.error('[artifacts] capture on append failed', error);
		}
	});
	ipcMain.handle('sessions:delete', async (_event, ref: ISessionRef) => {
		await deleteSessionFile(dataRoot, ref);
		try {
			await removeSessionArtifacts(dataRoot, ref);
		} catch (error) {
			console.error('[artifacts] cleanup on delete failed', error);
		}
	});
	ipcMain.handle('sessions:storeMedia', (_event, ref: ISessionRef, base64: string, mediaType: string) => storeSessionMedia(dataRoot, ref, base64, mediaType));
	ipcMain.handle('sessions:readMedia', (_event, ref: ISessionRef, entryPath: string) => readSessionMedia(dataRoot, ref, entryPath));
}
