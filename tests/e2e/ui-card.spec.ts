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
 * The render_ui card surface: a seeded `role:'ui'` message must render its
 * registered component (migration_preview), degrade to the markdown fallback
 * for an unregistered component, support the edit → confirm review loop, and
 * survive an app relaunch (the fold round-trip in the real app).
 */

const MIGRATION_UI = {
	id: 'ui-1',
	component: 'migration_preview',
	title: '订单表迁移映射',
	props: {
		sourceLabel: 'mysql:legacy_orders',
		targetLabel: 'pg:orders_v2',
		mappings: [
			{ source: 'orders.cust_name', target: 'customers.name', transform: 'trim + title-case' },
			{ source: 'orders.amount_cents', target: 'orders.amount', transform: '分→元' },
		],
		columns: ['name', 'amount'],
		sampleRows: [
			['张三', 12.5],
			['  李四 ', 99.99],
		],
		validations: [{ row: 1, column: 'name', level: 'warning', message: '首尾空白未去除' }],
		totalRowCount: 12340,
	},
};

const UNKNOWN_UI = { id: 'ui-2', component: 'future_widget', title: '未来组件', props: { x: 1 } };

async function seedSession(dataDir: string): Promise<void> {
	const now = new Date().toISOString();
	await mkdir(join(dataDir, 'sessions'), { recursive: true });
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId: 'ui-card-sess', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: now, interactivity: 'full' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'u1', role: 'user', text: '把订单表迁到新库' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'm-ui-1', role: 'ui', text: '## 订单表迁移映射\n\n映射说明。', ui: MIGRATION_UI }),
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

test('migration_preview renders, cells edit, confirm sends the structured turn; unknown components fall back to markdown', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-uicard-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const { page, errors } = await openSeededSession(app);

		// The registered component renders structurally.
		const card = page.locator('.conversation-ui').filter({ hasText: '订单表迁移映射' });
		await expect(card.locator('.migration-endpoints')).toContainText('mysql:legacy_orders');
		await expect(card.locator('.migration-mappings tbody tr')).toHaveCount(2);
		await expect(card.locator('.tabulator-row')).toHaveCount(2);
		await expect(card.locator('.migration-cell-warning')).toHaveCount(1);
		await expect(card.locator('.migration-cell-warning')).toHaveAttribute('title', '首尾空白未去除');

		// The unregistered component degrades to its markdown fallback — no grid, no crash.
		const fallback = page.locator('.conversation-ui').filter({ hasText: '未来组件' });
		await expect(fallback.locator('.conversation-ui-fallback')).toContainText('fallback markdown');
		await expect(fallback.locator('.tabulator')).toHaveCount(0);

		// Edit the flagged cell: warning clears, dirty badge appears.
		await card.locator('.migration-cell-warning').dblclick();
		await card.locator('.tabulator-cell.tabulator-editing input').fill('李四');
		await page.keyboard.press('Enter');
		await expect(card.locator('.migration-dirty')).toHaveText('已修正 1 个单元格');
		await expect(card.locator('.migration-cell-warning')).toHaveCount(0);
		await expect(card.locator('.migration-cell-edited')).toHaveCount(1);

		// Confirm: the structured turn lands as a user message; the card settles.
		await card.locator('.conversation-plan-approve').click();
		const turnBubble = page.locator('.conversation-message.user .conversation-message-bubble').last();
		await expect(turnBubble).toContainText('我确认了迁移映射预览');
		await expect(turnBubble).toContainText('orders.cust_name → customers.name');
		await expect(turnBubble).toContainText('第 2 行 [name]');
		await expect(turnBubble).toContainText('execute_data_source');
		await expect(card.locator('.migration-settled')).toBeVisible();
		await expect(card.locator('.conversation-plan-approve')).toHaveCount(0);

		expect(errors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('ui cards survive an app relaunch — the payload folds back from disk', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-uicard-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const first = await openSeededSession(app);
		await expect(first.page.locator('.conversation-ui')).toHaveCount(2);
		await app.close();
		app = undefined;

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const second = await openSeededSession(app);
		const card = second.page.locator('.conversation-ui').filter({ hasText: '订单表迁移映射' });
		await expect(card.locator('.tabulator-row')).toHaveCount(2, { timeout: 10_000 });
		await expect(card.locator('.migration-cell-warning')).toHaveCount(1);
		expect(second.errors).toEqual([]);
	} finally {
		await app?.close();
	}
});
