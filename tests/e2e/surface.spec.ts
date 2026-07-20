/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * The workbench surface (#12 M4): seeded surface_patch batches must project a
 * light card in the stream, fold into a live tree in the surface tab (batch 2
 * patching batch 1's skeleton), bind edits locally, and send the @ToAssistant
 * confirm turn WITH the form snapshot.
 */

const BATCH_1 = [
	'$days = "7"',
	'root = Stack([title, tbl, range, apply])',
	'title = Text("日志筛选", "title")',
	'tbl = Table(["级别", "数量"], [["error", 3], ["warn", 12]])',
	'range = Select("时间范围", ["7", "30", "90"], $days)',
	'apply = Button("按当前筛选查询", Action([@ToAssistant("按当前筛选重新查询")]))',
].join('\n');

// Turn 2: incremental edit — retitle + add a caption, root re-declared to include it.
const BATCH_2 = ['title = Text("日志筛选(已更新)", "title")', 'root = Stack([title, tbl, range, apply, hint])', 'hint = Text("数据截至 10:00", "caption")'].join('\n');

async function seedSession(dataDir: string): Promise<void> {
	const now = new Date().toISOString();
	await mkdir(join(dataDir, 'sessions'), { recursive: true });
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId: 'surface-sess', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: now, interactivity: 'full' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'u1', role: 'user', text: '做个日志筛选台' }),
		JSON.stringify({
			type: 'message',
			timestamp: now,
			id: 'm-s1',
			role: 'ui',
			text: '## 工作台\n\n初始批。',
			ui: { id: 'sp-1', component: 'surface_patch', title: '日志筛选台', props: { surface: 'main', statements: BATCH_1 } },
		}),
		JSON.stringify({
			type: 'message',
			timestamp: now,
			id: 'm-s2',
			role: 'ui',
			text: '## 工作台\n\n增量批。',
			ui: { id: 'sp-2', component: 'surface_patch', title: '日志筛选台', props: { surface: 'main', statements: BATCH_2 } },
		}),
		JSON.stringify({ type: 'state', timestamp: now, status: 2, title: 'surface session' }),
	];
	await writeFile(join(dataDir, 'sessions', 'surface-sess.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

test('surface_patch: projection cards in the stream, cross-batch fold in the workbench tab, @ToAssistant carries the form snapshot', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-surface-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	const errors: string[] = [];
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		page.on('pageerror', error => errors.push(error.message));
		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.waitForSelector('.sessions-sidebar');
		await page.locator('.sessions-project-task-row').filter({ hasText: 'surface session' }).click();

		// The stream shows light projections, not the raw statements.
		await expect(page.locator('.surface-patch-card')).toHaveCount(2);
		await expect(page.locator('.surface-patch-card').first()).toContainText('工作台已更新');

		// Open the workbench from the projection card.
		await page.locator('.surface-patch-card button').first().click();
		await page.waitForSelector('.surface-view');

		// The fold applied batch 2 over batch 1: retitle won, the caption exists,
		// and batch-1 statements resolved across batches.
		await expect(page.locator('.surface-text-title')).toHaveText('日志筛选(已更新)');
		await expect(page.locator('.surface-text-caption').first()).toContainText('数据截至 10:00');
		await expect(page.locator('.surface-table tbody tr')).toHaveCount(2);

		// Local edit: switch the Select to 30 — pure client state.
		await page.locator('.surface-field select').selectOption('30');

		// @ToAssistant: the confirm turn lands in the conversation with the snapshot.
		await page.locator('.surface-view .surface-button', { hasText: '按当前筛选查询' }).click();
		await expect(page.locator('.conversation-transcript')).toContainText('按当前筛选重新查询');
		await expect(page.locator('.conversation-transcript')).toContainText('$days = "30"');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await app?.close();
	}
});
