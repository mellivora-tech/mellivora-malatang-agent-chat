/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type {
	IPlanCommentData,
	ISessionEntry,
	ISessionHeader,
	ISessionMessageEntry,
	ISessionRef,
	ISessionSnapshot,
	ISessionSnapshotMessage,
	ISessionStateEntry,
} from '../sessions/services/sessions/common/sessionsBridge.js';
import { appendArtifact } from './artifactsStorage.js';
import { reportStorageDegraded } from './storageDiagnostics.js';
import { reportMainFailure } from './mainDiagnostics.js';

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
	await rm(sessionMediaDir(root, ref), { recursive: true, force: true });
}

// --- Session media (attached images) --------------------------------------------
// Bytes live beside the transcript, never inside it: the JSONL entry carries only
// a media-relative path, so transcripts stay greppable and cheap to fold.

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
};

function sessionMediaDir(root: string, ref: ISessionRef): string {
	return join(dirname(sessionFilePath(root, ref)), 'media', ref.sessionId);
}

/** Write one image (raw base64) and return its entry path (`media/<sessionId>/<hash>.<ext>`). Content-addressed: re-attaching the same image is a no-op. */
export async function storeSessionMedia(root: string, ref: ISessionRef, base64: string, mediaType: string): Promise<string> {
	const extension = MEDIA_EXTENSIONS[mediaType];
	if (!extension) {
		throw new Error(`Unsupported media type: ${mediaType}`);
	}
	const bytes = Buffer.from(base64, 'base64');
	const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
	const dir = sessionMediaDir(root, ref);
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${hash}.${extension}`);
	await writeFile(file, bytes);
	return `media/${ref.sessionId}/${hash}.${extension}`;
}

/** Write an agent-rendered table (csv) beside the transcript (#7 P3); returns its absolute path and display name. */
export async function storeSessionTableCsv(root: string, ref: ISessionRef, title: string, csv: string): Promise<{ readonly path: string; readonly name: string }> {
	const dir = sessionMediaDir(root, ref);
	await mkdir(dir, { recursive: true });
	const safe =
		title
			.replace(/[\\/:*?"<>|\s]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'table';
	const hash = createHash('sha256').update(csv).digest('hex').slice(0, 8);
	const name = `${safe}-${hash}.csv`;
	const file = join(dir, name);
	await writeFile(file, csv, 'utf8');
	// Artifact capture (#13 P0), best-effort: a broken index never fails the csv
	// write. The id derives from the file name so rebuild regenerates it stably.
	try {
		await appendArtifact(root, {
			id: `${ref.sessionId}:${name}`,
			kind: 'table',
			sessionId: ref.sessionId,
			...(ref.projectId !== undefined ? { projectId: ref.projectId } : {}),
			title,
			createdAt: new Date().toISOString(),
			payload: { type: 'media', path: file },
		});
	} catch (error) {
		reportMainFailure('artifacts.captureOnTableStore', error, { sessionId: ref.sessionId });
	}
	return { path: file, name };
}

/**
 * Write a split long answer's full markdown beside the transcript (#13
 * 长答案分流) — the table-csv pattern verbatim: content-hashed name, live
 * artifact capture, transcript never inflates. Returns the ENTRY path
 * (`media/<sessionId>/<name>.md`, what the assistant attachment persists and
 * readSessionMediaText resolves) plus the bare file name.
 */
export async function storeSessionDocument(root: string, ref: ISessionRef, title: string, markdown: string): Promise<{ readonly path: string; readonly name: string }> {
	const dir = sessionMediaDir(root, ref);
	await mkdir(dir, { recursive: true });
	const safe =
		title
			.replace(/[\\/:*?"<>|\s]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'document';
	const hash = createHash('sha256').update(markdown).digest('hex').slice(0, 8);
	const name = `${safe}-${hash}.md`;
	const file = join(dir, name);
	await writeFile(file, markdown, 'utf8');
	// Artifact capture (#13), best-effort: a broken index never fails the
	// document write. The id derives from the file name so rebuild regenerates
	// it stably.
	try {
		await appendArtifact(root, {
			id: `${ref.sessionId}:${name}`,
			kind: 'document',
			sessionId: ref.sessionId,
			...(ref.projectId !== undefined ? { projectId: ref.projectId } : {}),
			title,
			createdAt: new Date().toISOString(),
			payload: { type: 'media', path: file },
		});
	} catch (error) {
		reportMainFailure('artifacts.captureOnDocumentStore', error, { sessionId: ref.sessionId });
	}
	return { path: `media/${ref.sessionId}/${name}`, name };
}

/** Resolve an entry path against the session's transcript dir; undefined when it escapes the session's media dir — the renderer can never point main at arbitrary files. */
function gatedMediaPath(root: string, ref: ISessionRef, entryPath: string): string | undefined {
	const mediaRoot = resolve(sessionMediaDir(root, ref));
	const target = resolve(dirname(sessionFilePath(root, ref)), entryPath);
	return target !== mediaRoot && !target.startsWith(mediaRoot + sep) ? undefined : target;
}

/** Read a stored image back as raw base64; undefined when missing or the path escapes the media dir. */
export async function readSessionMedia(root: string, ref: ISessionRef, entryPath: string): Promise<string | undefined> {
	const target = gatedMediaPath(root, ref, entryPath);
	if (target === undefined) {
		return undefined;
	}
	try {
		return (await readFile(target)).toString('base64');
	} catch {
		return undefined;
	}
}

/** Read a stored media text file (the document card's expand); undefined when missing or the path escapes the media dir — same gate as readSessionMedia. */
export async function readSessionMediaText(root: string, ref: ISessionRef, entryPath: string): Promise<string | undefined> {
	const target = gatedMediaPath(root, ref, entryPath);
	if (target === undefined) {
		return undefined;
	}
	try {
		return await readFile(target, 'utf8');
	} catch {
		return undefined;
	}
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
		// The file is on disk but its header is unusable, so the entire conversation
		// silently vanishes from the session list — the most alarming possible
		// outcome to present with no explanation anywhere.
		reportStorageDegraded('session', 'unparseable', { path: file });
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
	let permissionMode: string | undefined;
	let compactionAnchor: ISessionStateEntry['compactionAnchor'];
	let contextUsage: ISessionStateEntry['contextUsage'];
	let pausedRun: NonNullable<ISessionStateEntry['pausedRun']> | undefined;
	const feedback = new Map<string, 'like' | 'dislike'>();
	const planStates = new Map<string, 'draft' | 'approved' | 'superseded'>();
	const planComments = new Map<string, IPlanCommentData>();

	let droppedEntries = 0;
	for (const line of lines.slice(1)) {
		const entry = parseEntry(line);
		if (!entry) {
			// A truncated or corrupt line removes that message/tool result from the
			// transcript, leaving a gap with no marker — count them and report once.
			droppedEntries += 1;
			continue;
		}

		if (entry.timestamp > updatedAt) {
			updatedAt = entry.timestamp;
		}

		if (entry.type === 'feedback') {
			if (entry.feedback === null) {
				feedback.delete(entry.messageId);
			} else {
				feedback.set(entry.messageId, entry.feedback);
			}
			continue;
		}

		if (entry.type === 'planState') {
			planStates.set(entry.messageId, entry.planState);
			continue;
		}

		if (entry.type === 'planComment') {
			planComments.set(entry.comment.id, entry.comment);
			continue;
		}

		if (entry.type === 'message') {
			messages.push({
				id: entry.id,
				role: entry.role,
				text: entry.text,
				...(entry.attachments !== undefined ? { attachments: entry.attachments } : {}),
				...(entry.detail !== undefined ? { detail: entry.detail } : {}),
				...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
				...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
				...(entry.steps !== undefined ? { steps: entry.steps } : {}),
				...(entry.plan !== undefined ? { plan: entry.plan } : {}),
				...(entry.ui !== undefined ? { ui: entry.ui } : {}),
				timestamp: entry.timestamp,
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
		if (entry.permissionMode !== undefined) {
			permissionMode = entry.permissionMode;
		}
		if (entry.compactionAnchor !== undefined) {
			compactionAnchor = entry.compactionAnchor;
		}
		if (entry.contextUsage !== undefined) {
			contextUsage = entry.contextUsage;
		}
		if (entry.pausedRun !== undefined) {
			// null is the explicit clear (resume started / user moved on).
			pausedRun = entry.pausedRun ?? undefined;
		}
	}

	if (droppedEntries > 0) {
		reportStorageDegraded('session', 'entries-dropped', { path: file, dropped: droppedEntries });
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
		...(permissionMode !== undefined ? { permissionMode } : {}),
		messages: messages
			.map(message => (feedback.has(message.id) ? { ...message, feedback: feedback.get(message.id)! } : message))
			.map(message => (message.plan !== undefined && planStates.has(message.id) ? { ...message, plan: { ...message.plan, state: planStates.get(message.id)! } } : message)),
		// The directory decides project membership; the header copy is only
		// for debuggability and may be stale.
		...(projectId !== undefined ? { projectId } : {}),
		...(header.workspace !== undefined ? { workspace: header.workspace } : {}),
		...(description !== undefined ? { description } : {}),
		...(summary !== undefined ? { changesSummary: summary } : {}),
		...(compactionAnchor !== undefined ? { compactionAnchor } : {}),
		...(contextUsage !== undefined ? { contextUsage } : {}),
		...(pausedRun !== undefined ? { pausedRun } : {}),
		...(planComments.size > 0 ? { planComments: [...planComments.values()] } : {}),
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

function parseEntry(line: string): ISessionEntry | undefined {
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

	if (candidate['type'] === 'feedback') {
		if (typeof candidate['messageId'] !== 'string' || !['like', 'dislike', null].includes(candidate['feedback'] as never)) {
			return undefined;
		}
		return parsed as ISessionEntry;
	}

	if (candidate['type'] === 'planState') {
		if (typeof candidate['messageId'] !== 'string' || !['draft', 'approved', 'superseded'].includes(candidate['planState'] as never)) {
			return undefined;
		}
		return parsed as ISessionEntry;
	}

	if (candidate['type'] === 'planComment') {
		const comment = candidate['comment'] as Record<string, unknown> | undefined;
		if (
			typeof comment !== 'object' ||
			comment === null ||
			typeof comment['id'] !== 'string' ||
			typeof comment['planId'] !== 'string' ||
			typeof comment['sectionId'] !== 'string' ||
			typeof comment['body'] !== 'string' ||
			typeof comment['resolved'] !== 'boolean'
		) {
			return undefined;
		}
		return parsed as ISessionEntry;
	}

	return undefined;
}

/**
 * The read-side role whitelist. It MUST stay in step with the role union in
 * sessions/services/sessions/common/session.ts — a role that is written but not
 * listed here is silently dropped on load, and the message simply disappears
 * from the transcript.
 *
 * That is not hypothetical: 'digest' shipped missing from this list, so every
 * hidden per-run work summary was written to disk and then discarded on every
 * reload — the cross-run work memory could never survive a restart, with nothing
 * anywhere reporting a loss. Adding a role means updating this list too.
 */
function isRole(value: unknown): value is 'user' | 'assistant' | 'tool' | 'work' | 'plan' | 'digest' | 'ui' {
	return value === 'user' || value === 'assistant' || value === 'tool' || value === 'work' || value === 'plan' || value === 'digest' || value === 'ui';
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
