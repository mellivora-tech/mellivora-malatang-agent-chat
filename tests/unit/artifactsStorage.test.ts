/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { IArtifactEntryData } from '../../src/sessions/services/artifacts/common/artifacts.js';
import { appendArtifact, artifactsFilePath, extractArtifactsFromEntries, listArtifacts, rebuildArtifacts, removeSessionArtifacts } from '../../src/main/artifactsStorage.js';
import { storeSessionDocument, storeSessionTableCsv } from '../../src/main/sessionsStorage.js';
import type { ISessionEntry } from '../../src/sessions/services/sessions/common/sessionsBridge.js';

async function createTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-artifacts-'));
}

function entry(overrides: Partial<IArtifactEntryData> & { readonly id: string }): IArtifactEntryData {
	return {
		kind: 'plan',
		sessionId: 's1',
		title: 'a plan',
		createdAt: '2026-07-20T10:00:00.000Z',
		payload: { type: 'message', messageId: 'm1' },
		...overrides,
	};
}

test('appendArtifact routes by projectId; listArtifacts folds, filters and sorts', async () => {
	const root = await createTempRoot();
	try {
		await appendArtifact(root, entry({ id: 's1:m2', title: 'second', createdAt: '2026-07-20T11:00:00.000Z', payload: { type: 'message', messageId: 'm2' } }));
		await appendArtifact(root, entry({ id: 's1:m1' }));
		await appendArtifact(root, entry({ id: 'p-sess:m9', sessionId: 'p-sess', projectId: 'proj1', title: 'in project', createdAt: '2026-07-20T09:00:00.000Z' }));

		// Same id appended again → later line wins wholesale.
		await appendArtifact(root, entry({ id: 's1:m1', title: 'a plan v2' }));
		// Patch line → merged onto the entry.
		await appendArtifact(root, { id: 's1:m1', superseded: true });

		const all = await listArtifacts(root);
		assert.deepEqual(
			all.map(artifact => artifact.id),
			['p-sess:m9', 's1:m1', 's1:m2'],
			'createdAt ascending across scopes',
		);
		assert.equal(all[1]!.title, 'a plan v2');
		assert.equal(all[1]!.superseded, true);
		assert.equal(all[2]!.superseded, undefined);

		// projectId routing: the project entry lives in its own file.
		const projectRaw = await readFile(artifactsFilePath(root, 'proj1'), 'utf8');
		assert.equal(projectRaw.trim().split('\n').length, 1);
		assert.deepEqual(
			(await listArtifacts(root, { projectId: 'proj1' })).map(artifact => artifact.id),
			['p-sess:m9'],
		);
		assert.deepEqual(
			(await listArtifacts(root, { sessionId: 's1' })).map(artifact => artifact.id),
			['s1:m1', 's1:m2'],
		);
		assert.deepEqual(await listArtifacts(root, { projectId: 'proj1', sessionId: 's1' }), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('listArtifacts drops orphan patches and corrupt lines', async () => {
	const root = await createTempRoot();
	try {
		// A patch whose entry lives in a deleted session, plus garbage lines.
		await appendArtifact(root, { id: 'gone:m1', superseded: true });
		const file = artifactsFilePath(root);
		await writeFile(file, `${await readFile(file, 'utf8')}not json\n{"noId":true}\n`, 'utf8');
		await appendArtifact(root, entry({ id: 's1:m1' }));

		assert.deepEqual(
			(await listArtifacts(root)).map(artifact => artifact.id),
			['s1:m1'],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('extractArtifactsFromEntries maps plan/walkthrough/ui messages and planState patches; ignores the rest', () => {
	const entries: ISessionEntry[] = [
		{ type: 'message', id: 'u1', role: 'user', text: 'hi', timestamp: '2026-07-20T10:00:00.000Z' },
		{ type: 'message', id: 'a1', role: 'assistant', text: 'hello', timestamp: '2026-07-20T10:00:01.000Z' },
		{
			type: 'message',
			id: 'p1',
			role: 'plan',
			text: 'plan md',
			timestamp: '2026-07-20T10:00:02.000Z',
			plan: { id: 'plan-1', version: 1, title: '迁移方案', sections: [], state: 'draft' },
		},
		{
			type: 'message',
			id: 'w1',
			role: 'plan',
			text: 'walkthrough md',
			timestamp: '2026-07-20T10:00:03.000Z',
			plan: { id: 'plan-2', version: 1, title: '执行讲解', sections: [], state: 'draft', kind: 'walkthrough' },
		},
		{
			type: 'message',
			id: 'c1',
			role: 'ui',
			text: 'card md',
			timestamp: '2026-07-20T10:00:04.000Z',
			ui: { id: 'ui-1', component: 'migration_preview', title: '订单表迁移映射', props: {} },
		},
		// A plan-role message without its payload (older/corrupt line) yields nothing.
		{ type: 'message', id: 'p2', role: 'plan', text: 'bare', timestamp: '2026-07-20T10:00:05.000Z' },
		{ type: 'planState', messageId: 'p1', planState: 'superseded', timestamp: '2026-07-20T10:00:06.000Z' },
		{ type: 'planState', messageId: 'w1', planState: 'approved', timestamp: '2026-07-20T10:00:07.000Z' },
		{ type: 'state', timestamp: '2026-07-20T10:00:08.000Z', title: 'ignored' },
	];

	const lines = extractArtifactsFromEntries('sess-1', 'proj-1', entries);
	assert.deepEqual(lines, [
		{
			id: 'sess-1:p1',
			kind: 'plan',
			sessionId: 'sess-1',
			projectId: 'proj-1',
			title: '迁移方案',
			createdAt: '2026-07-20T10:00:02.000Z',
			payload: { type: 'message', messageId: 'p1' },
		},
		{
			id: 'sess-1:w1',
			kind: 'walkthrough',
			sessionId: 'sess-1',
			projectId: 'proj-1',
			title: '执行讲解',
			createdAt: '2026-07-20T10:00:03.000Z',
			payload: { type: 'message', messageId: 'w1' },
		},
		{
			id: 'sess-1:c1',
			kind: 'ui-card',
			sessionId: 'sess-1',
			projectId: 'proj-1',
			title: '订单表迁移映射',
			createdAt: '2026-07-20T10:00:04.000Z',
			payload: { type: 'message', messageId: 'c1' },
		},
		{ id: 'sess-1:p1', superseded: true, projectId: 'proj-1' },
	]);

	// No projectId → the field is absent, not undefined (the line is JSON).
	const bare = extractArtifactsFromEntries('sess-1', undefined, entries.slice(2, 3));
	assert.deepEqual(Object.keys(bare[0]!).includes('projectId'), false);
});

/** Strips the fields rebuild legitimately regenerates differently (table createdAt = file mtime). */
function stableFields(artifact: IArtifactEntryData): Omit<IArtifactEntryData, 'createdAt'> {
	const { createdAt: _createdAt, ...rest } = artifact;
	return rest;
}

test('rebuildArtifacts regenerates the same index the live hooks produced (export excepted)', async () => {
	const root = await createTempRoot();
	const projectId = 'proj1';
	const sessionsDir = join(root, 'projects', projectId, 'sessions');
	await mkdir(sessionsDir, { recursive: true });
	try {
		// Two session fixtures in the ui-card.spec seed format. Timestamps sit in
		// the past so the table artifact (createdAt ≈ now / file mtime) sorts
		// last in BOTH the live and the rebuilt list.
		const t = (second: number): string => `2026-01-01T10:00:0${second}.000Z`;
		const planMessage = {
			type: 'message',
			timestamp: t(1),
			id: 'p1',
			role: 'plan',
			text: 'plan md',
			plan: { id: 'plan-1', version: 1, title: '迁移方案', sections: [], state: 'draft' },
		};
		const supersede = { type: 'planState', messageId: 'p1', planState: 'superseded', timestamp: t(2) };
		const uiMessage = {
			type: 'message',
			timestamp: t(3),
			id: 'c1',
			role: 'ui',
			text: 'card md',
			ui: { id: 'ui-1', component: 'migration_preview', title: '订单表迁移映射', props: {} },
		};
		const sessionA = [
			{ type: 'session', version: 1, sessionId: 'sess-a', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: t(0), interactivity: 'full' },
			{ type: 'message', timestamp: t(0), id: 'u1', role: 'user', text: '把订单表迁到新库' },
			planMessage,
			supersede,
			{ type: 'state', timestamp: t(2), status: 2, title: 'session a' },
		];
		const sessionB = [
			{ type: 'session', version: 1, sessionId: 'sess-b', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: t(3), interactivity: 'full' },
			uiMessage,
			{ type: 'state', timestamp: t(3), status: 2, title: 'session b' },
		];
		await writeFile(join(sessionsDir, 'sess-a.jsonl'), `${sessionA.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');
		await writeFile(join(sessionsDir, 'sess-b.jsonl'), `${sessionB.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');

		// Live capture: what sessions:append + storeSessionTableCsv would have done.
		for (const line of extractArtifactsFromEntries('sess-a', projectId, [planMessage, supersede] as unknown as ISessionEntry[])) {
			await appendArtifact(root, line);
		}
		for (const line of extractArtifactsFromEntries('sess-b', projectId, [uiMessage] as unknown as ISessionEntry[])) {
			await appendArtifact(root, line);
		}
		// storeSessionTableCsv / storeSessionDocument write the media file AND its live index entry.
		await storeSessionTableCsv(root, { sessionId: 'sess-b', projectId }, 'orders', 'a,b\n1,2');
		await storeSessionDocument(root, { sessionId: 'sess-b', projectId }, '梳理报告', '# 全文\n\n正文内容。');

		const live = await listArtifacts(root, { projectId });
		assert.equal(live.length, 4);

		await rebuildArtifacts(root, projectId);
		const rebuilt = await listArtifacts(root, { projectId });

		assert.deepEqual(rebuilt.map(stableFields), live.map(stableFields));
		assert.equal(rebuilt.find(artifact => artifact.id === 'sess-a:p1')?.superseded, true);
		assert.equal(rebuilt.find(artifact => artifact.kind === 'table')?.title, 'orders');
		// The media scan regenerates document rows from their .md files too (#13 长答案分流).
		const rebuiltDocument = rebuilt.find(artifact => artifact.kind === 'document');
		assert.equal(rebuiltDocument?.title, '梳理报告');
		assert.equal(rebuiltDocument?.payload.type, 'media');
		// Message-payload artifacts keep their transcript timestamps exactly.
		assert.deepEqual(
			rebuilt.filter(artifact => artifact.payload.type === 'message').map(artifact => artifact.createdAt),
			live.filter(artifact => artifact.payload.type === 'message').map(artifact => artifact.createdAt),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rebuildArtifacts preserves export AND change-set entries — the index is their only record (P1 panel rebuilds on every mount)', async () => {
	const root = await createTempRoot();
	try {
		await mkdir(join(root, 'sessions'), { recursive: true });
		await writeFile(
			join(root, 'sessions', 's1.jsonl'),
			`${JSON.stringify({ type: 'session', version: 1, sessionId: 's1', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: '2026-07-20T10:00:00.000Z', interactivity: 'full' })}\n`,
			'utf8',
		);
		await appendArtifact(root, entry({ id: 's1:export:abc', kind: 'export', title: 'migration.sql', payload: { type: 'export', path: '/somewhere/migration.sql' } }));
		// change-set snapshots transient working-tree state — no transcript line
		// can regenerate it, so it rides the same preservation (#13 P2).
		await appendArtifact(
			root,
			entry({
				id: 's1:changeset:deadbeef',
				kind: 'change-set',
				title: '1 个文件改动',
				payload: { type: 'change-set', files: [{ path: 'src/a.ts', added: 3, removed: 1 }] },
			}),
		);
		assert.equal((await listArtifacts(root)).length, 2);

		await rebuildArtifacts(root);
		const after = await listArtifacts(root);
		assert.equal(after.length, 2, 'export and change-set rows survived the rebuild');
		assert.deepEqual(after.map(artifact => artifact.kind).sort(), ['change-set', 'export']);
		const changeSet = after.find(artifact => artifact.kind === 'change-set');
		assert.deepEqual(changeSet?.payload, { type: 'change-set', files: [{ path: 'src/a.ts', added: 3, removed: 1 }] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('change-set snapshots with identical content fold to one row; changed content is a new row', async () => {
	const root = await createTempRoot();
	try {
		const payload = { type: 'change-set' as const, files: [{ path: 'src/a.ts', added: 3, removed: 1 }] };
		await appendArtifact(root, entry({ id: 's1:changeset:aaaa0001', kind: 'change-set', title: '1 个文件改动', payload }));
		// A restart loses the renderer-side gate — the same content appended
		// again must still collapse (same content hash → same id → fold).
		await appendArtifact(root, entry({ id: 's1:changeset:aaaa0001', kind: 'change-set', title: '1 个文件改动', createdAt: '2026-07-20T12:00:00.000Z', payload }));
		const deduped = await listArtifacts(root);
		assert.equal(deduped.length, 1);
		assert.equal(deduped[0]!.createdAt, '2026-07-20T12:00:00.000Z', 'the later snapshot wins the fold');

		await appendArtifact(
			root,
			entry({
				id: 's1:changeset:bbbb0002',
				kind: 'change-set',
				title: '2 个文件改动',
				createdAt: '2026-07-20T13:00:00.000Z',
				payload: { type: 'change-set', files: [...payload.files, { path: 'src/b.ts', added: 1, removed: 0 }] },
			}),
		);
		assert.equal((await listArtifacts(root)).length, 2, 'a different diff is its own artifact');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('removeSessionArtifacts drops the session lines (patches included) and keeps the rest', async () => {
	const root = await createTempRoot();
	try {
		await appendArtifact(root, entry({ id: 's1:m1' }));
		await appendArtifact(root, { id: 's1:m1', superseded: true });
		await appendArtifact(root, entry({ id: 's2:m1', sessionId: 's2', title: 'keep me' }));

		await removeSessionArtifacts(root, { sessionId: 's1' });
		assert.deepEqual(
			(await listArtifacts(root)).map(artifact => artifact.id),
			['s2:m1'],
		);

		// Removing the last session deletes the file entirely.
		await removeSessionArtifacts(root, { sessionId: 's2' });
		await assert.rejects(() => readFile(artifactsFilePath(root), 'utf8'));

		// Missing index file is a no-op, not an error.
		await removeSessionArtifacts(root, { sessionId: 's1', projectId: 'nope' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
