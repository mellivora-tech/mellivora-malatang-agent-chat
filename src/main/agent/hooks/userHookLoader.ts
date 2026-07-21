/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IHook } from './hooks.js';
import { createCommandHook, parseUserHookConfig, type IUserHookConfig } from './userHooks.js';

/**
 * Load user-configured hooks safely (design docs/design/hooks §8 trust model).
 *
 * TRUST: hooks run external commands, so a project could otherwise ship a
 * malicious `.mellivora/hooks.json` that executes on open. Therefore:
 *  · GLOBAL hooks (~/.mellivora/hooks.json) are the user's own machine config —
 *    always trusted.
 *  · PROJECT hooks (<project>/.mellivora/hooks.json) are NOT trusted by default.
 *    They run only after the user approves their exact content; approval is keyed
 *    to a content HASH, so any edit to the file revokes trust until re-approved —
 *    a repo cannot swap in a new command behind a stale approval.
 *
 * The loader never throws: a missing/corrupt file yields no hooks.
 */

const HOOKS_FILE = 'hooks.json';
const TRUST_FILE = 'hook-trust.json';

/** sha256 of the raw config file content — the unit of approval. */
export function hashConfig(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

async function readRaw(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return undefined; // absent or unreadable → nothing to load.
	}
}

/** Parse a hooks file's raw content into validated configs; malformed entries are dropped. */
function parseHooksFile(raw: string): IUserHookConfig[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return []; // corrupt file → no hooks (degrade, never crash).
	}
	const entries = typeof value === 'object' && value !== null && Array.isArray((value as { hooks?: unknown }).hooks) ? ((value as { hooks: unknown[] }).hooks as unknown[]) : [];
	return entries.map((entry, index) => parseUserHookConfig(entry, index)).filter((config): config is IUserHookConfig => config !== undefined);
}

// --- trust store (in the global dir; keyed by project path → approved hash) ------

async function readTrustStore(globalDir: string): Promise<Record<string, string>> {
	const raw = await readRaw(join(globalDir, TRUST_FILE));
	if (raw === undefined) {
		return {};
	}
	try {
		const value = JSON.parse(raw) as unknown;
		return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** True iff the user has approved THIS EXACT content (hash) for this project. */
export async function isProjectHooksTrusted(globalDir: string, projectPath: string, hash: string): Promise<boolean> {
	const store = await readTrustStore(globalDir);
	return store[projectPath] === hash;
}

/** Record approval of a project's current hooks content. A later edit (new hash) needs re-approval. */
export async function approveProjectHooks(globalDir: string, projectPath: string, hash: string): Promise<void> {
	const store = await readTrustStore(globalDir);
	store[projectPath] = hash;
	const path = join(globalDir, TRUST_FILE);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(store, null, '\t'), 'utf8');
}

/** Drop a project's approval (e.g. the user revokes it). */
export async function revokeProjectHooks(globalDir: string, projectPath: string): Promise<void> {
	const store = await readTrustStore(globalDir);
	if (!(projectPath in store)) {
		return;
	}
	delete store[projectPath];
	await writeFile(join(globalDir, TRUST_FILE), JSON.stringify(store, null, '\t'), 'utf8');
}

// --- loader ----------------------------------------------------------------------

export interface ILoadedUserHooks {
	/** Trusted, runnable hooks (global always; project only when approved). */
	readonly hooks: readonly IHook[];
	/** Set when a project hooks file exists but is NOT approved (or changed since) — the caller prompts. */
	readonly pending?: { readonly projectPath: string; readonly hash: string; readonly count: number };
}

export interface ILoadUserHooksOptions {
	/** The global config dir (~/.mellivora) — its hooks.json is trusted; also holds the trust store. */
	readonly globalDir: string;
	/** The project config dir (<project>/.mellivora) — its hooks.json is gated on approval. */
	readonly projectDir?: string;
	/** The project's stable identity for the trust store (usually its path). */
	readonly projectPath?: string;
}

async function readHooks(dir: string): Promise<IUserHookConfig[]> {
	const raw = await readRaw(join(dir, HOOKS_FILE));
	return raw === undefined ? [] : parseHooksFile(raw);
}

export async function loadUserHooks(options: ILoadUserHooksOptions): Promise<ILoadedUserHooks> {
	const hooks: IHook[] = [];

	// Global — always trusted.
	for (const config of await readHooks(options.globalDir)) {
		hooks.push(createCommandHook(config));
	}

	// Project — trusted only when the exact content is approved.
	let pending: ILoadedUserHooks['pending'];
	if (options.projectDir !== undefined && options.projectPath !== undefined) {
		const raw = await readRaw(join(options.projectDir, HOOKS_FILE));
		if (raw !== undefined) {
			const configs = parseHooksFile(raw);
			if (configs.length > 0) {
				const hash = hashConfig(raw);
				if (await isProjectHooksTrusted(options.globalDir, options.projectPath, hash)) {
					for (const config of configs) {
						hooks.push(createCommandHook(config));
					}
				} else {
					pending = { projectPath: options.projectPath, hash, count: configs.length };
				}
			}
		}
	}

	return pending !== undefined ? { hooks, pending } : { hooks };
}
