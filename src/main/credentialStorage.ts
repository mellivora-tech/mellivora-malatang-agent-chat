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
 * At rest the secrets are ENCRYPTED via an injectable {@link ISecretCipher} — in
 * the app that's Electron `safeStorage` (OS keychain); in tests / when
 * encryption is unavailable it falls back to the plaintext cipher. The renderer
 * only ever learns whether a credential EXISTS (hasCredential), never contents.
 */

/** Symmetric string cipher for secrets at rest. `available` decides whether new writes are encrypted. */
export interface ISecretCipher {
	readonly available: boolean;
	encrypt(plain: string): string;
	decrypt(stored: string): string;
}

/** No-op cipher: secrets stored as plaintext. Default for tests / when OS encryption is unavailable. */
export const PLAINTEXT_CIPHER: ISecretCipher = {
	available: false,
	encrypt: plain => plain,
	decrypt: stored => stored,
};

type Credentials = Record<string, IDataSourceSecret>;

interface ICredentialFileV2 {
	readonly version: 2;
	/** Whether `secrets` is cipher-encrypted (else it's plaintext JSON). */
	readonly enc: boolean;
	/** The serialized (and possibly encrypted) credentials record. */
	readonly secrets: string;
}

function credentialsFilePath(root: string): string {
	return join(root, 'credentials.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function readAll(root: string, cipher: ISecretCipher): Promise<Credentials> {
	let raw: string;
	try {
		raw = await readFile(credentialsFilePath(root), 'utf8');
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!isRecord(parsed)) {
		return {};
	}
	// v2: an encrypted (or plaintext) `secrets` blob.
	if (parsed['version'] === 2 && typeof parsed['secrets'] === 'string') {
		try {
			const json = parsed['enc'] === true ? cipher.decrypt(parsed['secrets']) : parsed['secrets'];
			const record = JSON.parse(json);
			return isRecord(record) ? (record as Credentials) : {};
		} catch {
			// Wrong cipher / corrupt blob — fail safe to empty rather than throwing.
			return {};
		}
	}
	// v1 (legacy plaintext): `{ version: 1, credentials: {...} }`.
	return isRecord(parsed['credentials']) ? (parsed['credentials'] as Credentials) : {};
}

async function writeAll(root: string, credentials: Credentials, cipher: ISecretCipher): Promise<void> {
	const file = credentialsFilePath(root);
	await mkdir(dirname(file), { recursive: true });
	const json = JSON.stringify(credentials);
	const payload: ICredentialFileV2 = cipher.available ? { version: 2, enc: true, secrets: cipher.encrypt(json) } : { version: 2, enc: false, secrets: json };
	await writeFile(`${file}.tmp`, `${JSON.stringify(payload, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

/** Empty/absent fields prune the whole entry (clearing a credential); otherwise stores only the provided fields. */
export async function setCredential(root: string, dataSourceId: string, secret: IDataSourceSecret, cipher: ISecretCipher = PLAINTEXT_CIPHER): Promise<void> {
	const all = await readAll(root, cipher);
	const trimmed: IDataSourceSecret = {
		...(secret.username ? { username: secret.username } : {}),
		...(secret.password ? { password: secret.password } : {}),
		...(secret.token ? { token: secret.token } : {}),
		...(secret.privateKey ? { privateKey: secret.privateKey } : {}),
	};
	if (Object.keys(trimmed).length === 0) {
		delete all[dataSourceId];
	} else {
		all[dataSourceId] = trimmed;
	}
	await writeAll(root, all, cipher);
}

/** Main-process only — used when actually connecting. Never expose the result to the renderer. */
export async function getCredential(root: string, dataSourceId: string, cipher: ISecretCipher = PLAINTEXT_CIPHER): Promise<IDataSourceSecret | undefined> {
	return (await readAll(root, cipher))[dataSourceId];
}

export async function hasCredential(root: string, dataSourceId: string, cipher: ISecretCipher = PLAINTEXT_CIPHER): Promise<boolean> {
	return (await readAll(root, cipher))[dataSourceId] !== undefined;
}

export async function deleteCredential(root: string, dataSourceId: string, cipher: ISecretCipher = PLAINTEXT_CIPHER): Promise<void> {
	const all = await readAll(root, cipher);
	if (all[dataSourceId] !== undefined) {
		delete all[dataSourceId];
		await writeAll(root, all, cipher);
	}
}
