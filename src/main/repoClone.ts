/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeRootVcs } from '../sessions/services/projects/common/projects.js';

export interface ICommandResult {
	readonly code: number;
	readonly output: string;
}

/** Runs a VCS command; injectable so the clone logic is testable without a real network. */
export type CommandRunner = (file: string, args: readonly string[], signal: AbortSignal) => Promise<ICommandResult>;

export const runCommand: CommandRunner = (file, args, signal) =>
	new Promise(resolve => {
		const child = spawn(file, args);
		let output = '';
		const collect = (chunk: Buffer): void => {
			output += chunk.toString('utf8');
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		const onAbort = (): void => {
			child.kill('SIGKILL');
		};
		signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', error => {
			signal.removeEventListener('abort', onAbort);
			resolve({ code: -1, output: `${output}${error.message}` });
		});
		child.on('close', code => {
			signal.removeEventListener('abort', onAbort);
			resolve({ code: code ?? -1, output });
		});
	});

/**
 * Canonical identity of a repo URL for dedup: `host/owner/repo`, lowercased,
 * `.git` and trailing slashes stripped, scheme + userinfo removed. Collapses the
 * https / ssh / scp forms of the same repo to one key.
 */
export function normalizeRepoUrl(url: string): string {
	let s = url.trim();
	const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s); // git@host:owner/repo
	if (scp) {
		s = `${scp[1]}/${scp[2]}`;
	} else {
		s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme://
		s = s.replace(/^[^/@]+@/, ''); // strip userinfo@
	}
	return s
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '')
		.toLowerCase();
}

/** The `origin` remote URL of a local git working copy, or undefined if none / not a repo. */
export async function gitRemoteOrigin(path: string, signal: AbortSignal, run: CommandRunner = runCommand): Promise<string | undefined> {
	const result = await run('git', ['-C', path, 'config', '--get', 'remote.origin.url'], signal);
	const url = result.code === 0 ? result.output.trim() : '';
	return url.length > 0 ? url : undefined;
}

/** Derive a repo folder name from a URL: last path segment, `.git` stripped. Handles `git@host:owner/repo`. */
export function repoName(url: string): string {
	const cleaned = url
		.trim()
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '');
	const segment = cleaned.split(/[/:]/).filter(Boolean).pop();
	return segment && segment.length > 0 ? segment : 'repo';
}

export interface ICloneResult {
	readonly ok: boolean;
	readonly message: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clone (first time) or fast-forward update (already present) a remote into
 * `localPath`. Relies on the system `git`/`svn` and its credentials (SSH agent /
 * credential helper) — no credential handling here. Never throws: a failure is
 * returned as `{ ok: false }` with the last line of output.
 */
export async function cloneOrUpdate(
	localPath: string,
	remote: { readonly url: string; readonly vcs: CodeRootVcs; readonly ref?: string },
	signal: AbortSignal,
	run: CommandRunner = runCommand,
): Promise<ICloneResult> {
	const marker = remote.vcs === 'svn' ? '.svn' : '.git';
	const present = await exists(join(localPath, marker));

	let result: ICommandResult;
	if (remote.vcs === 'git') {
		result = present
			? await run('git', ['-C', localPath, 'pull', '--ff-only'], signal)
			: await run('git', ['clone', ...(remote.ref ? ['--branch', remote.ref] : []), '--', remote.url, localPath], signal);
	} else {
		result = present ? await run('svn', ['update', localPath], signal) : await run('svn', ['checkout', remote.url, localPath], signal);
	}

	if (result.code === 0) {
		return { ok: true, message: present ? '已更新' : '已克隆' };
	}
	const lastLine = result.output.trim().split('\n').filter(Boolean).pop();
	return { ok: false, message: (lastLine ?? `退出码 ${result.code}`).slice(0, 300) };
}
