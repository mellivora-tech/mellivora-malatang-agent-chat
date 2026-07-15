/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Project-scoped persisted "always allow" patterns (#5 v2). Lives in the APP's
 * data dir — personal and per-machine, never inside the workspace — so an
 * allowlist can't ride a git clone onto someone else's machine.
 *
 * Deliberately narrow: ONLY `bash:` grants persist. `bash-nosandbox:` (a
 * per-call sandbox-escape decision) and `edit:*` (would amount to permanent
 * auto-edit) stay session-level; the filter runs on WRITE and again on READ,
 * so a hand-edited file can't smuggle wider grants in.
 */

interface IApprovalsFile {
	readonly version: 1;
	readonly allow: readonly string[];
}

/** The only namespace that may cross process boundaries. */
export function isPersistablePattern(pattern: string): boolean {
	return pattern.startsWith('bash:') && pattern.length > 'bash:'.length;
}

function approvalsPath(dataRoot: string, projectId: string): string {
	return join(dataRoot, 'projects', projectId, 'approvals.json');
}

/** Read the project's persisted patterns; corrupt/missing files fold to empty. */
export async function readProjectAllowlist(dataRoot: string, projectId: string): Promise<Set<string>> {
	let raw: string;
	try {
		raw = await readFile(approvalsPath(dataRoot, projectId), 'utf8');
	} catch {
		return new Set();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return new Set();
	}
	const allow = (parsed as { allow?: unknown })?.allow;
	if (!Array.isArray(allow)) {
		return new Set();
	}
	return new Set(allow.filter((entry): entry is string => typeof entry === 'string' && isPersistablePattern(entry)));
}

async function writeProjectAllowlist(dataRoot: string, projectId: string, patterns: ReadonlySet<string>): Promise<void> {
	const file = approvalsPath(dataRoot, projectId);
	await mkdir(dirname(file), { recursive: true });
	const payload: IApprovalsFile = { version: 1, allow: [...patterns].sort() };
	await writeFile(`${file}.tmp`, `${JSON.stringify(payload, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

/** Merge persistable patterns in; non-persistable ones are silently dropped. */
export async function addProjectAllowPatterns(dataRoot: string, projectId: string, patterns: readonly string[]): Promise<readonly string[]> {
	const current = await readProjectAllowlist(dataRoot, projectId);
	for (const pattern of patterns) {
		if (isPersistablePattern(pattern)) {
			current.add(pattern);
		}
	}
	await writeProjectAllowlist(dataRoot, projectId, current);
	return [...current].sort();
}

export async function removeProjectAllowPattern(dataRoot: string, projectId: string, pattern: string): Promise<readonly string[]> {
	const current = await readProjectAllowlist(dataRoot, projectId);
	current.delete(pattern);
	await writeProjectAllowlist(dataRoot, projectId, current);
	return [...current].sort();
}

export async function listProjectAllowPatterns(dataRoot: string, projectId: string): Promise<readonly string[]> {
	return [...(await readProjectAllowlist(dataRoot, projectId))].sort();
}
