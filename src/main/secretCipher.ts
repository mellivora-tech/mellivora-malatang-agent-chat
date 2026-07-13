/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeStorage } from 'electron';
import { PLAINTEXT_CIPHER, type ISecretCipher } from './credentialStorage.js';

/**
 * The app's real secret cipher, backed by Electron `safeStorage` (OS keychain /
 * credential store). When encryption isn't available on the platform (e.g. a
 * Linux box with no keyring), it degrades to the plaintext cipher so credentials
 * still work — the security posture just drops to what it was before.
 */
export function createSafeStorageCipher(): ISecretCipher {
	if (!safeStorage.isEncryptionAvailable()) {
		return PLAINTEXT_CIPHER;
	}
	return {
		available: true,
		encrypt: plain => safeStorage.encryptString(plain).toString('base64'),
		decrypt: stored => safeStorage.decryptString(Buffer.from(stored, 'base64')),
	};
}
