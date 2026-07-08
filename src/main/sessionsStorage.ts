/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
	ISessionEntry,
	ISessionHeader,
	ISessionMessageEntry,
	ISessionRef,
	ISessionSnapshot,
	ISessionSnapshotMessage,
	ISessionStateEntry,
} from '../sessions/services/sessions/common/sessionsBridge.js';

const DEFAULT_STATUS_NEEDS_INPUT = 2;

export function sessionFilePath(root: string, ref: ISessionRef): string {
	const dir = ref.projectId ? join(root, 'projects', ref.projectId, 'sessions') : join(root, 'sessions');
	return join(dir, `${ref.sessionId}.jsonl`);
}

export async function createSessionFile(root: string, header: ISessionHeader): Promise<void> {
	const ref: ISessionRef = { sessionId: header.sessionId, ...(header.projectId ? { projectId: header.projectId } : {}) };
	const file = sessionFilePath(root, ref);
	await mkdir(dirname(file), { recursive: true });
	// 'wx' refuses to overwrite an existing transcript.
	await writeFile(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function appendSessionEntry(root: string, ref: ISessionRef, entry: ISessionEntry): Promise<void> {
	await appendFile(sessionFilePath(root, ref), `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function deleteSessionFile(root: string, ref: ISessionRef): Promise<void> {
	await rm(sessionFilePath(root, ref), { force: true });
}

export async function loadSession(root: string, ref: ISessionRef): Promise<ISessionSnapshot | undefined> {
	return loadSessionFromFile(sessionFilePath(root, ref), ref.projectId);
}

export async function loadAllSessions(root: string): Promise<readonly ISessionSnapshot[]> {
	const files: { file: string; projectId?: string }[] = [];

	for (const file of await listJsonlFiles(join(root, 'sessions'))) {
		files.push({ file });
	}

	for (const projectDir of await listDirectories(join(root, 'projects'))) {
		for (const file of await listJsonlFiles(join(root, 'projects', projectDir, 'sessions'))) {
			files.push({ file, projectId: projectDir });
		}
	}

	const sessions: ISessionSnapshot[] = [];
	for (const { file, projectId } of files) {
		const snapshot = await loadSessionFromFile(file, projectId);
		if (snapshot) {
			sessions.push(snapshot);
		}
	}

	return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
}

async function loadSessionFromFile(file: string, projectId: string | undefined): Promise<ISessionSnapshot | undefined> {
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return undefined;
	}

	const lines = raw.split('\n').filter(line => line.trim().length > 0);
	const header = parseHeader(lines[0]);
	if (!header || header.sessionId !== basename(file, '.jsonl')) {
		return undefined;
	}

	const messages: ISessionSnapshotMessage[] = [];
	let updatedAt = header.createdAt;
	let title = '';
	let status = DEFAULT_STATUS_NEEDS_INPUT;
	let description: string | undefined;
	let summary: ISessionStateEntry['changesSummary'];
	let isArchived = false;
	let isRead = true;
	let isPinned = false;

	for (const line of lines.slice(1)) {
		const entry = parseEntry(line);
		if (!entry) {
			continue;
		}

		if (entry.timestamp > updatedAt) {
			updatedAt = entry.timestamp;
		}

		if (entry.type === 'message') {
			messages.push({
				id: entry.id,
				role: entry.role,
				text: entry.text,
				...(entry.detail !== undefined ? { detail: entry.detail } : {}),
				...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
				...(entry.steps !== undefined ? { steps: entry.steps } : {}),
			});
			continue;
		}

		if (entry.status !== undefined) {
			status = entry.status;
		}
		if (entry.title !== undefined) {
			title = entry.title;
		}
		if (entry.description !== undefined) {
			description = entry.description;
		}
		if (entry.changesSummary !== undefined) {
			summary = entry.changesSummary;
		}
		if (entry.isArchived !== undefined) {
			isArchived = entry.isArchived;
		}
		if (entry.isRead !== undefined) {
			isRead = entry.isRead;
		}
		if (entry.isPinned !== undefined) {
			isPinned = entry.isPinned;
		}
	}

	return {
		sessionId: header.sessionId,
		sessionType: header.sessionType,
		icon: header.icon,
		createdAt: header.createdAt,
		updatedAt,
		interactivity: header.interactivity,
		title,
		status,
		isArchived,
		isRead,
		isPinned,
		messages,
		// The directory decides project membership; the header copy is only
		// for debuggability and may be stale.
		...(projectId !== undefined ? { projectId } : {}),
		...(header.workspace !== undefined ? { workspace: header.workspace } : {}),
		...(description !== undefined ? { description } : {}),
		...(summary !== undefined ? { changesSummary: summary } : {}),
	};
}

function parseHeader(line: string | undefined): ISessionHeader | undefined {
	if (!line) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}

	const candidate = parsed as Record<string, unknown>;
	if (
		candidate['type'] !== 'session' ||
		typeof candidate['sessionId'] !== 'string' ||
		typeof candidate['sessionType'] !== 'string' ||
		typeof candidate['icon'] !== 'string' ||
		typeof candidate['createdAt'] !== 'string' ||
		typeof candidate['interactivity'] !== 'string'
	) {
		return undefined;
	}

	return parsed as ISessionHeader;
}

function parseEntry(line: string): ISessionMessageEntry | ISessionStateEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}

	const candidate = parsed as Record<string, unknown>;
	if (typeof candidate['timestamp'] !== 'string') {
		return undefined;
	}

	if (candidate['type'] === 'message') {
		if (typeof candidate['id'] !== 'string' || typeof candidate['text'] !== 'string' || !isRole(candidate['role'])) {
			return undefined;
		}
		return parsed as ISessionMessageEntry;
	}

	if (candidate['type'] === 'state') {
		return parsed as ISessionStateEntry;
	}

	return undefined;
}

function isRole(value: unknown): value is 'user' | 'assistant' | 'tool' | 'work' {
	return value === 'user' || value === 'assistant' || value === 'tool' || value === 'work';
}

async function listJsonlFiles(dir: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function listDirectories(dir: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
	} catch {
		return [];
	}
}
