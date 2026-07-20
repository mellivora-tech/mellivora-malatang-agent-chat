/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	appendSessionEntry,
	createSessionFile,
	deleteSessionFile,
	loadAllSessions,
	loadSession,
	readSessionMedia,
	readSessionMediaText,
	storeSessionDocument,
	storeSessionMedia,
} from '../../src/main/sessionsStorage.js';
import type { ISessionHeader } from '../../src/sessions/services/sessions/common/sessionsBridge.js';

async function createTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-sessions-'));
}

function createHeader(sessionId: string, options: { projectId?: string; createdAt?: string; workspace?: ISessionHeader['workspace'] } = {}): ISessionHeader {
	return {
		type: 'session',
		version: 1,
		sessionId,
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: options.createdAt ?? '2026-07-07T00:00:00.000Z',
		interactivity: 'full',
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.workspace ? { workspace: options.workspace } : {}),
	};
}

test('createSessionFile writes a header line under the shared sessions dir', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));

		const raw = await readFile(join(root, 'sessions', 'aaaa-1111.jsonl'), 'utf8');
		const lines = raw.split('\n').filter(line => line.length > 0);
		assert.equal(lines.length, 1);
		assert.equal((JSON.parse(lines[0]!) as ISessionHeader).sessionId, 'aaaa-1111');

		const snapshot = await loadSession(root, { sessionId: 'aaaa-1111' });
		assert.ok(snapshot);
		assert.equal(snapshot.sessionId, 'aaaa-1111');
		assert.equal(snapshot.projectId, undefined);
		assert.equal(snapshot.title, '');
		assert.equal(snapshot.status, 2);
		assert.equal(snapshot.isArchived, false);
		assert.equal(snapshot.isRead, true);
		assert.equal(snapshot.updatedAt, '2026-07-07T00:00:00.000Z');
		assert.deepEqual(snapshot.messages, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('createSessionFile writes under projects/<projectId>/sessions for project sessions', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('bbbb-2222', { projectId: '3f2a8c1d', workspace: { label: 'my-app', description: '/tmp/my-app' } }));

		const raw = await readFile(join(root, 'projects', '3f2a8c1d', 'sessions', 'bbbb-2222.jsonl'), 'utf8');
		assert.ok(raw.includes('"bbbb-2222"'));

		const snapshot = await loadSession(root, { sessionId: 'bbbb-2222', projectId: '3f2a8c1d' });
		assert.ok(snapshot);
		assert.equal(snapshot.projectId, '3f2a8c1d');
		assert.deepEqual(snapshot.workspace, { label: 'my-app', description: '/tmp/my-app' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('createSessionFile refuses to overwrite an existing session file', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await assert.rejects(() => createSessionFile(root, createHeader('aaaa-1111')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('appendSessionEntry and loadSession round-trip messages and folded state', async () => {
	const root = await createTempRoot();
	const ref = { sessionId: 'aaaa-1111' };
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await appendSessionEntry(root, ref, { type: 'message', id: 'm1', role: 'user', text: 'hello', timestamp: '2026-07-07T00:01:00.000Z' });
		await appendSessionEntry(root, ref, {
			type: 'state',
			timestamp: '2026-07-07T00:01:00.000Z',
			status: 1,
			title: 'hello',
			isRead: false,
			changesSummary: { files: 5, additions: 3431, deletions: 815 },
		});
		await appendSessionEntry(root, ref, { type: 'message', id: 'm2', role: 'assistant', text: 'Assistant reply', timestamp: '2026-07-07T00:02:00.000Z' });
		await appendSessionEntry(root, ref, { type: 'state', timestamp: '2026-07-07T00:02:00.000Z', status: 2 });

		const snapshot = await loadSession(root, ref);
		assert.ok(snapshot);
		assert.deepEqual(snapshot.messages, [
			{ id: 'm1', role: 'user', text: 'hello', timestamp: '2026-07-07T00:01:00.000Z' },
			{ id: 'm2', role: 'assistant', text: 'Assistant reply', timestamp: '2026-07-07T00:02:00.000Z' },
		]);
		assert.equal(snapshot.title, 'hello');
		assert.equal(snapshot.status, 2);
		assert.equal(snapshot.isRead, false);
		assert.deepEqual(snapshot.changesSummary, { files: 5, additions: 3431, deletions: 815 });
		assert.equal(snapshot.updatedAt, '2026-07-07T00:02:00.000Z');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadSession defaults isPinned to false for legacy files and folds pin toggles', async () => {
	const root = await createTempRoot();
	const ref = { sessionId: 'aaaa-1111' };
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		assert.equal((await loadSession(root, ref))?.isPinned, false);

		await appendSessionEntry(root, ref, { type: 'state', timestamp: '2026-07-07T00:01:00.000Z', isPinned: true });
		assert.equal((await loadSession(root, ref))?.isPinned, true);

		await appendSessionEntry(root, ref, { type: 'state', timestamp: '2026-07-07T00:02:00.000Z', isPinned: false });
		assert.equal((await loadSession(root, ref))?.isPinned, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadSession keeps message detail when present', async () => {
	const root = await createTempRoot();
	const ref = { sessionId: 'aaaa-1111' };
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await appendSessionEntry(root, ref, { type: 'message', id: 'm1', role: 'tool', text: 'typecheck', detail: 'All good.', timestamp: '2026-07-07T00:01:00.000Z' });

		const snapshot = await loadSession(root, ref);
		assert.deepEqual(snapshot?.messages, [{ id: 'm1', role: 'tool', text: 'typecheck', detail: 'All good.', timestamp: '2026-07-07T00:01:00.000Z' }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadSession folds later state entries over earlier ones per field', async () => {
	const root = await createTempRoot();
	const ref = { sessionId: 'aaaa-1111' };
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await appendSessionEntry(root, ref, { type: 'state', timestamp: '2026-07-07T00:01:00.000Z', status: 1, title: 'first title', description: 'working' });
		await appendSessionEntry(root, ref, { type: 'state', timestamp: '2026-07-07T00:02:00.000Z', status: 3 });

		const snapshot = await loadSession(root, ref);
		assert.equal(snapshot?.status, 3);
		assert.equal(snapshot?.title, 'first title');
		assert.equal(snapshot?.description, 'working');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadSession skips corrupt lines but keeps valid ones', async () => {
	const root = await createTempRoot();
	const ref = { sessionId: 'aaaa-1111' };
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await appendSessionEntry(root, ref, { type: 'message', id: 'm1', role: 'user', text: 'hello', timestamp: '2026-07-07T00:01:00.000Z' });
		const file = join(root, 'sessions', 'aaaa-1111.jsonl');
		await writeFile(file, `${await readFile(file, 'utf8')}{ not json\n{"type":"unknown-kind"}\n`, 'utf8');
		await appendSessionEntry(root, ref, { type: 'message', id: 'm2', role: 'assistant', text: 'ok', timestamp: '2026-07-07T00:02:00.000Z' });

		const snapshot = await loadSession(root, ref);
		assert.deepEqual(
			snapshot?.messages.map(message => message.id),
			['m1', 'm2'],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadSession returns undefined for a missing file, missing header, or mismatched filename', async () => {
	const root = await createTempRoot();
	try {
		assert.equal(await loadSession(root, { sessionId: 'missing' }), undefined);

		const dir = join(root, 'sessions');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'no-header.jsonl'), '{"type":"message","id":"m1","role":"user","text":"x","timestamp":"2026-07-07T00:00:00.000Z"}\n', 'utf8');
		assert.equal(await loadSession(root, { sessionId: 'no-header' }), undefined);

		await writeFile(join(dir, 'mismatch.jsonl'), `${JSON.stringify(createHeader('other-id'))}\n`, 'utf8');
		assert.equal(await loadSession(root, { sessionId: 'mismatch' }), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('deleteSessionFile removes shared and project transcripts and tolerates missing files', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('aaaa-1111'));
		await createSessionFile(root, createHeader('bbbb-2222', { projectId: '3f2a8c1d' }));

		await deleteSessionFile(root, { sessionId: 'aaaa-1111' });
		await deleteSessionFile(root, { sessionId: 'bbbb-2222', projectId: '3f2a8c1d' });
		await deleteSessionFile(root, { sessionId: 'never-existed' });

		assert.equal(await loadSession(root, { sessionId: 'aaaa-1111' }), undefined);
		assert.equal(await loadSession(root, { sessionId: 'bbbb-2222', projectId: '3f2a8c1d' }), undefined);
		assert.deepEqual(await loadAllSessions(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadAllSessions scans shared and project locations sorted by updatedAt desc', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('shared-old', { createdAt: '2026-07-01T00:00:00.000Z' }));
		await createSessionFile(root, createHeader('project-new', { projectId: '3f2a8c1d', createdAt: '2026-07-05T00:00:00.000Z' }));
		await createSessionFile(root, createHeader('shared-newest', { createdAt: '2026-07-06T00:00:00.000Z' }));
		await appendSessionEntry(root, { sessionId: 'shared-newest' }, { type: 'message', id: 'm1', role: 'user', text: 'x', timestamp: '2026-07-07T00:00:00.000Z' });

		const sessions = await loadAllSessions(root);
		assert.deepEqual(
			sessions.map(session => session.sessionId),
			['shared-newest', 'project-new', 'shared-old'],
		);
		assert.equal(sessions[1]?.projectId, '3f2a8c1d');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadAllSessions derives projectId from the directory over the header', async () => {
	const root = await createTempRoot();
	try {
		const dir = join(root, 'projects', 'real-dir', 'sessions');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'cccc-3333.jsonl'), `${JSON.stringify(createHeader('cccc-3333', { projectId: 'stale-header-id' }))}\n`, 'utf8');

		const sessions = await loadAllSessions(root);
		assert.equal(sessions[0]?.projectId, 'real-dir');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('loadAllSessions returns empty for a missing root and skips invalid files', async () => {
	const root = await createTempRoot();
	try {
		assert.deepEqual(await loadAllSessions(join(root, 'does-not-exist')), []);

		const dir = join(root, 'sessions');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'broken.jsonl'), '{ not json\n', 'utf8');
		await writeFile(join(dir, 'notes.txt'), 'not a session', 'utf8');
		await createSessionFile(root, createHeader('valid-one'));

		const sessions = await loadAllSessions(root);
		assert.deepEqual(
			sessions.map(session => session.sessionId),
			['valid-one'],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

test('storeSessionMedia writes content-addressed bytes and readSessionMedia round-trips them', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('med-1'));
		const ref = { sessionId: 'med-1' };

		const path = await storeSessionMedia(root, ref, PNG_BASE64, 'image/png');
		assert.match(path, /^media\/med-1\/[0-9a-f]{16}\.png$/);

		// Same bytes → same path (content-addressed, no duplicate files).
		assert.equal(await storeSessionMedia(root, ref, PNG_BASE64, 'image/png'), path);

		assert.equal(await readSessionMedia(root, ref, path), PNG_BASE64);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('storeSessionMedia rejects unknown media types; readSessionMedia refuses path escapes', async () => {
	const root = await createTempRoot();
	try {
		const ref = { sessionId: 'med-2' };
		await assert.rejects(storeSessionMedia(root, ref, PNG_BASE64, 'application/pdf'), /Unsupported media type/);

		await storeSessionMedia(root, ref, PNG_BASE64, 'image/png');
		assert.equal(await readSessionMedia(root, ref, '../med-2.jsonl'), undefined, 'a traversal outside the media dir reads nothing');
		assert.equal(await readSessionMedia(root, ref, 'media/med-2/missing.png'), undefined, 'a missing file reads nothing');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('storeSessionDocument writes the split answer beside the transcript; readSessionMediaText round-trips and refuses escapes', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('doc-1'));
		const ref = { sessionId: 'doc-1' };

		const stored = await storeSessionDocument(root, ref, '部署 / 梳理*', '# 全文\n\n正文内容。');
		assert.match(stored.name, /^部署-梳理-[0-9a-f]{8}\.md$/);
		assert.equal(stored.path, `media/doc-1/${stored.name}`);

		assert.equal(await readSessionMediaText(root, ref, stored.path), '# 全文\n\n正文内容。');
		assert.equal(await readSessionMediaText(root, ref, '../doc-1.jsonl'), undefined, 'a traversal outside the media dir reads nothing');
		assert.equal(await readSessionMediaText(root, ref, 'media/doc-1/missing.md'), undefined, 'a missing file reads nothing');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('deleteSessionFile removes the media dir with the transcript', async () => {
	const root = await createTempRoot();
	try {
		await createSessionFile(root, createHeader('med-3'));
		const ref = { sessionId: 'med-3' };
		const path = await storeSessionMedia(root, ref, PNG_BASE64, 'image/png');

		await deleteSessionFile(root, ref);
		assert.equal(await readSessionMedia(root, ref, path), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
