/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRenderDataTool, toCsv } from '../../src/main/agent/tools/renderDataTool.js';
import { parseCsv } from '../../src/main/dataFiles.js';
import { storeSessionTableCsv } from '../../src/main/sessionsStorage.js';
import { RENDERED_TABLE_MARKER } from '../../src/sessions/services/sessions/common/session.js';

test('toCsv round-trips through parseCsv (quotes, commas, newlines, NULLs, dates)', () => {
	const columns = ['id', 'note', 'when'];
	const rows = [
		[1, 'a,b and "q"', new Date('2026-01-01T00:00:00Z')],
		[2, 'line1\nline2', null],
	];
	const parsed = parseCsv(toCsv(columns, rows));
	assert.deepEqual(parsed[0], columns);
	assert.deepEqual(parsed[1], ['1', 'a,b and "q"', '2026-01-01T00:00:00.000Z']);
	assert.deepEqual(parsed[2], ['2', 'line1\nline2', '']);
});

test('render_data validates shape and caps, stores csv, and tails the marker', async () => {
	const stored: { title: string; csv: string }[] = [];
	const tool = createRenderDataTool({
		storeCsv: async (title, csv) => {
			stored.push({ title, csv });
			return { path: '/data/projects/p/sessions/media/s/汇总-abc123.csv', name: '汇总-abc123.csv' };
		},
	});

	assert.equal(tool.validateInput({ columns: [], rows: [] }).ok, false);
	assert.equal(tool.validateInput({ columns: ['a'], rows: 'nope' }).ok, false);
	assert.equal(tool.validateInput({ columns: ['a'], rows: [[1]], title: ' 汇总 ' }).ok, true);
	assert.equal(tool.validateInput({ columns: ['a'], rows: Array.from({ length: 5001 }, () => [1]) }).ok, false);

	const result = await tool.call({ title: '汇总', columns: ['id', 'name'], rows: [[1, 'x'], [2, 'y']] }, { toolUseId: 't1', signal: new AbortController().signal } as never);
	assert.match(result.content, /已渲染 2 行 × 2 列/);
	assert.match(result.content, /不要在回复中重复/);
	const marker = RENDERED_TABLE_MARKER.exec(result.content);
	assert.equal(marker?.[1], '/data/projects/p/sessions/media/s/汇总-abc123.csv');
	assert.equal(stored[0]?.csv, 'id,name\n1,x\n2,y');
});

test('storeSessionTableCsv writes into the session media dir with a sanitized name', async () => {
	const root = await mkdtemp(join(tmpdir(), 'render-data-'));
	const stored = await storeSessionTableCsv(root, { sessionId: 's1', projectId: 'p1' }, '订单 / 汇总*', 'a,b\n1,2');
	assert.match(stored.name, /^订单-汇总-[0-9a-f]{8}\.csv$/);
	assert.ok(stored.path.includes(join('projects', 'p1', 'sessions', 'media', 's1')));
	assert.equal(await readFile(stored.path, 'utf8'), 'a,b\n1,2');
});
