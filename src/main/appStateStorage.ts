/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IAppState } from '../sessions/services/appState/common/appState.js';

function stateFilePath(root: string): string {
	return join(root, 'state.json');
}

export async function readAppState(root: string): Promise<IAppState> {
	let raw: string;
	try {
		raw = await readFile(stateFilePath(root), 'utf8');
	} catch {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return {};
	}

	const candidate = parsed as Record<string, unknown>;
	return {
		...(typeof candidate['activeProjectId'] === 'string' ? { activeProjectId: candidate['activeProjectId'] } : {}),
	};
}

export async function writeAppState(root: string, state: IAppState): Promise<void> {
	await mkdir(root, { recursive: true });
	const file = stateFilePath(root);
	await writeFile(`${file}.tmp`, `${JSON.stringify(state, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}
