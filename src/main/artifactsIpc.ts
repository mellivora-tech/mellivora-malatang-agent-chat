/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import { shell } from 'electron';
import { stat } from 'node:fs/promises';
import type { IArtifactEntryData, IArtifactFilter } from '../sessions/services/artifacts/common/artifacts.js';
import { appendArtifact, listArtifacts, rebuildArtifacts } from './artifactsStorage.js';

export function registerArtifactsIpc(dataRoot: string): void {
	registerHandler('artifacts:list', (_event, filter?: IArtifactFilter) => listArtifacts(dataRoot, filter ?? {}));
	// The producer channel for artifacts that ride no message (#13 P2 change-set)
	// — listArtifacts' fold validates shape on read, so a malformed line can
	// never surface as an entry.
	registerHandler('artifacts:record', (_event, entry: IArtifactEntryData) => appendArtifact(dataRoot, entry));
	registerHandler('artifacts:rebuild', (_event, projectId?: string) => rebuildArtifacts(dataRoot, projectId));
	registerHandler('artifacts:reveal', async (_event, path: string) => {
		// showItemInFolder silently no-ops on a missing path — probe first so the
		// renderer can mark the row stale instead of the click just doing nothing.
		try {
			await stat(path);
		} catch {
			return false;
		}
		shell.showItemInFolder(path);
		return true;
	});
}
