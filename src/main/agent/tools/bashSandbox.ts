/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Escape a path for embedding in a Seatbelt (SBPL) string literal. */
function escapeProfilePath(path: string): string {
	return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Resolve symlinks (Seatbelt matches real paths, e.g. /tmp → /private/tmp). */
function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * A macOS Seatbelt profile that allows everything EXCEPT file writes, which are
 * confined to the workspace plus the standard scratch/cache locations dev
 * tooling needs (npm, temp dirs). Reads and network stay open so builds, tests,
 * git and package installs still work — the jail is specifically against writing
 * outside the project (rm -rf ~, tampering with /etc, etc.).
 */
export function buildBashSandboxProfile(cwd: string): string {
	const home = homedir();
	const writable = [realOrSelf(cwd), realOrSelf(tmpdir()), '/private/tmp', '/private/var/tmp', '/private/var/folders', `${home}/.npm`, `${home}/.cache`, `${home}/Library/Caches`];
	const subpaths = [...new Set(writable)].map(path => `\t(subpath "${escapeProfilePath(path)}")`).join('\n');
	return [
		'(version 1)',
		'(allow default)',
		'(deny file-write*)',
		'(allow file-write*',
		subpaths,
		'\t(literal "/dev/null")',
		'\t(literal "/dev/zero")',
		'\t(literal "/dev/dtracehelper")',
		'\t(literal "/dev/tty"))',
		'(allow file-write-data (regex #"^/dev/fd/[0-9]+$"))',
	].join('\n');
}

export interface ISandboxedCommand {
	readonly file: string;
	readonly args: readonly string[];
	readonly sandboxed: boolean;
}

/**
 * Wrap a shell command in the OS sandbox when available. macOS uses
 * `sandbox-exec`; elsewhere (or when disabled via MELLIVORA_BASH_SANDBOX=off,
 * or sandbox-exec is missing) it runs unsandboxed and reports so.
 */
export function sandboxedShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): ISandboxedCommand {
	const disabled = env['MELLIVORA_BASH_SANDBOX'] === 'off';
	if (disabled || process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
		return { file: '/bin/sh', args: ['-c', command], sandboxed: false };
	}
	return { file: SANDBOX_EXEC, args: ['-p', buildBashSandboxProfile(cwd), '/bin/sh', '-c', command], sandboxed: true };
}
