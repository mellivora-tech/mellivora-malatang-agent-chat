/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IDataSourceSecret } from '../sessions/services/environments/common/environments.js';

/**
 * Data-source credentials — the SECRET half, kept out of the workspace (which
 * may be a committed repo) and never sent to the renderer. Stored app-side,
 * keyed by data-source id.
 *
 * Plaintext at rest for now, exactly like the model API keys in
 * modelConfigStorage — a later revision can wrap this with Electron
 * `safeStorage` without touching callers. The renderer only ever learns
 * whether a credential EXISTS (hasCredential), never its contents.
 */

interface ICredentialFile {
	readonly version: 1;
	readonly credentials: Record<string, IDataSourceSecret>;
}

function credentialsFilePath(root: string): string {
	return join(root, 'credentials.json');
}

async function readAll(root: string): Promise<Record<string, IDataSourceSecret>> {
	let raw: string;
	try {
		raw = await readFile(credentialsFilePath(root), 'utf8');
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as ICredentialFile;
		return typeof parsed === 'object' && parsed !== null && typeof parsed.credentials === 'object' && parsed.credentials !== null ? parsed.credentials : {};
	} catch {
		return {};
	}
}

async function writeAll(root: string, credentials: Record<string, IDataSourceSecret>): Promise<void> {
	const file = credentialsFilePath(root);
	await mkdir(dirname(file), { recursive: true });
	const payload: ICredentialFile = { version: 1, credentials };
	await writeFile(`${file}.tmp`, `${JSON.stringify(payload, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

/** Empty/absent fields prune the whole entry (clearing a credential); otherwise stores only the provided fields. */
export async function setCredential(root: string, dataSourceId: string, secret: IDataSourceSecret): Promise<void> {
	const all = await readAll(root);
	const trimmed: IDataSourceSecret = {
		...(secret.username ? { username: secret.username } : {}),
		...(secret.password ? { password: secret.password } : {}),
		...(secret.token ? { token: secret.token } : {}),
	};
	if (Object.keys(trimmed).length === 0) {
		delete all[dataSourceId];
	} else {
		all[dataSourceId] = trimmed;
	}
	await writeAll(root, all);
}

/** Main-process only — used when actually connecting. Never expose the result to the renderer. */
export async function getCredential(root: string, dataSourceId: string): Promise<IDataSourceSecret | undefined> {
	return (await readAll(root))[dataSourceId];
}

export async function hasCredential(root: string, dataSourceId: string): Promise<boolean> {
	return (await readAll(root))[dataSourceId] !== undefined;
}

export async function deleteCredential(root: string, dataSourceId: string): Promise<void> {
	const all = await readAll(root);
	if (all[dataSourceId] !== undefined) {
		delete all[dataSourceId];
		await writeAll(root, all);
	}
}
