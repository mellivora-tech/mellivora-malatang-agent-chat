/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * The render_ui fallback contract (the generic UiCard host). A `role:'ui'`
 * message whose component is NOT in the registry — a never-registered name, or
 * one that was RETIRED (migration_preview, removed in #12 M5) — must degrade to
 * the message's markdown text instead of crashing. This is exactly what makes
 * retiring a component safe: an old on-disk session still carrying its card
 * folds back to a readable summary. The live surface_patch rendering path has
 * its own coverage in surface.spec.ts.
 */

// migration_preview: a RETIRED component (no longer registered). future_widget:
// a name this build never knew. Both must hit the same markdown fallback.
const RETIRED_UI = { id: 'ui-1', component: 'migration_preview', title: '订单表迁移映射', props: { sourceLabel: 'x', mappings: [] } };
const UNKNOWN_UI = { id: 'ui-2', component: 'future_widget', title: '未来组件', props: { x: 1 } };

async function seedSession(dataDir: string): Promise<void> {
	const now = new Date().toISOString();
	await mkdir(join(dataDir, 'sessions'), { recursive: true });
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId: 'ui-card-sess', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: now, interactivity: 'full' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'u1', role: 'user', text: '看看老卡片' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'm-ui-1', role: 'ui', text: '## 订单表迁移映射\n\n退役卡片的 markdown 摘要。', ui: RETIRED_UI }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'm-ui-2', role: 'ui', text: '## 未来组件\n\nfallback markdown 内容。', ui: UNKNOWN_UI }),
		JSON.stringify({ type: 'state', timestamp: now, status: 2, title: 'ui card session' }),
	];
	await writeFile(join(dataDir, 'sessions', 'ui-card-sess.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

async function openSeededSession(app: ElectronApplication): Promise<{ page: Page; errors: string[] }> {
	const errors: string[] = [];
	const page = await app.firstWindow();
	page.on('console', message => {
		if (message.type() === 'error') {
			errors.push(message.text());
		}
	});
	page.on('pageerror', error => errors.push(error.message));
	await page.setViewportSize({ width: 1400, height: 1000 });
	await page.waitForSelector('.sessions-sidebar');
	await page.locator('.sessions-project-task-row').filter({ hasText: 'ui card session' }).click();
	await page.waitForSelector('.conversation-ui');
	return { page, errors };
}

test('a retired or never-registered component degrades to its markdown fallback — no crash, no grid', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-uicard-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const { page, errors } = await openSeededSession(app);

		// The retired migration_preview card no longer renders its grid — it falls back to markdown.
		const retired = page.locator('.conversation-ui').filter({ hasText: '订单表迁移映射' });
		await expect(retired.locator('.conversation-ui-fallback')).toContainText('退役卡片的 markdown 摘要');

		// The never-registered component falls back the same way.
		const unknown = page.locator('.conversation-ui').filter({ hasText: '未来组件' });
		await expect(unknown.locator('.conversation-ui-fallback')).toContainText('fallback markdown');

		// No grid, no migration chrome anywhere — the component and its CSS are gone.
		await expect(page.locator('.tabulator')).toHaveCount(0);
		await expect(page.locator('.conversation-ui-migration')).toHaveCount(0);

		expect(errors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('fallback cards survive an app relaunch — the payload folds back from disk', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-uicard-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		await expect((await openSeededSession(app)).page.locator('.conversation-ui')).toHaveCount(2);
		await app.close();

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const second = await openSeededSession(app);
		await expect(second.page.locator('.conversation-ui-fallback')).toHaveCount(2);
		expect(second.errors).toEqual([]);
	} finally {
		await app?.close();
	}
});
