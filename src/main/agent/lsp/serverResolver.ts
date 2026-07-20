/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

/** Languages we can resolve a server for. Extension → language is 1:1 here. */
export type Language = 'java' | 'typescript' | 'vue';

/** A resolved server launch spec — ready to hand to child_process.spawn. */
export interface IServerSpec {
	readonly language: Language;
	readonly command: string;
	readonly args: readonly string[];
}

/** Optional per-language overrides (e.g. from workspace config): full argv. */
export type ServerOverrides = Partial<Record<Language, readonly string[]>>;

const EXTENSION_LANGUAGE: ReadonlyMap<string, Language> = new Map([
	['.java', 'java'],
	['.ts', 'typescript'],
	['.tsx', 'typescript'],
	['.mts', 'typescript'],
	['.cts', 'typescript'],
	['.js', 'typescript'],
	['.jsx', 'typescript'],
	['.mjs', 'typescript'],
	['.vue', 'vue'],
]);

/**
 * Default stdio launch commands, tried when no override is given. These are the
 * conventional binary names; if none is on PATH the language degrades to "no
 * server" and read_symbol says so rather than failing hard.
 */
const DEFAULT_COMMANDS: Record<Language, readonly (readonly string[])[]> = {
	// jdtls ships a `jdtls` launcher (python) that wraps the eclipse.jdt.ls server.
	java: [['jdtls']],
	typescript: [['typescript-language-server', '--stdio']],
	// Volar: modern name is `vue-language-server`; older installs expose `@vue/language-server`.
	vue: [['vue-language-server', '--stdio'], ['vue-language-server']],
};

export function languageForPath(filePath: string): Language | undefined {
	return EXTENSION_LANGUAGE.get(extname(filePath).toLowerCase());
}

/** True if `command` resolves to an executable on PATH (cross-platform-ish). */
function onPath(command: string): boolean {
	// An explicit path (contains a separator) is checked directly.
	if (command.includes('/') || command.includes('\\')) {
		return isExecutable(command);
	}
	const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
	// On Windows a bare name resolves via PATHEXT; probe the common ones.
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			if (isExecutable(join(dir, command + ext))) {
				return true;
			}
		}
	}
	return false;
}

function isExecutable(candidate: string): boolean {
	try {
		accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a launch spec for a language, or undefined if no server is available.
 * Override wins unconditionally (the user asked for exactly that argv); otherwise
 * the first default command whose executable is found on PATH is used.
 */
export function resolveServer(language: Language, overrides?: ServerOverrides): IServerSpec | undefined {
	const override = overrides?.[language];
	if (override && override.length > 0) {
		return { language, command: override[0]!, args: override.slice(1) };
	}
	for (const argv of DEFAULT_COMMANDS[language]) {
		if (onPath(argv[0]!)) {
			return { language, command: argv[0]!, args: argv.slice(1) };
		}
	}
	return undefined;
}
