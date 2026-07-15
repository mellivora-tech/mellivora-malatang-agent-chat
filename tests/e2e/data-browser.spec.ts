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
 * Data browser tab (issue #4 P0). No live database is required: the fixtures
 * cover the no-sources empty state and a configured-but-unreachable source
 * (127.0.0.1:9 refuses instantly), which exercises the whole UI pipeline —
 * source dropdown, table-list fetch, and the status-bar error path.
 */

async function writeProject(dataDir: string, id: string, name: string, path: string): Promise<void> {
	const dir = join(dataDir, 'projects', id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'project.json'), JSON.stringify({ id, name, path, createdAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
}

async function writeSession(dataDir: string, projectId: string, sessionId: string): Promise<void> {
	const dir = join(dataDir, 'projects', projectId, 'sessions');
	await mkdir(dir, { recursive: true });
	const createdAt = '2026-01-01T00:00:00.000Z';
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId, sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt, interactivity: 'full', projectId }),
		JSON.stringify({ type: 'message', timestamp: createdAt, id: 'u1', role: 'user', text: 'browse data' }),
		JSON.stringify({ type: 'state', timestamp: createdAt, status: 3, title: '数据浏览' }),
	];
	await writeFile(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

async function writeWorkspaceConfig(workspacePath: string): Promise<void> {
	await mkdir(join(workspacePath, '.mellivora'), { recursive: true });
	const config = {
		version: 1,
		environments: [{ id: 'env-dev', name: 'dev', writable: true }],
		dataSources: [
			{
				id: 'ds-orders',
				environmentId: 'env-dev',
				label: 'orders库',
				access: 'read-only',
				kind: 'database',
				coordinates: { driver: 'mysql', host: '127.0.0.1', port: 9, database: 'shop' },
			},
		],
	};
	await writeFile(join(workspacePath, '.mellivora', 'project.json'), JSON.stringify(config), 'utf8');
}

async function openDataTab(page: Page): Promise<void> {
	await page.locator('.sessions-list-row').first().click();
	await expect(page.locator('.session-view')).toBeVisible();
	await page.locator('.sessions-titlebar-side-pane-toggle').click();
	await expect(page.locator('.part.auxiliarybar')).toBeVisible();
	await page.locator('.auxiliary-empty-card').filter({ hasText: '数据' }).click();
	await expect(page.locator('.auxiliary-view[data-tab-id="data"] .data-browser')).toBeVisible();
}

test('data tab: unreachable source surfaces the error in the status bar (dark + light shots)', async () => {
	await mkdir('test-results', { recursive: true });
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		await openDataTab(page);

		// The source dropdown carries "env · label"; the table-list fetch against
		// the dead port lands as a readable message in the status bar.
		await expect(page.locator('.data-browser-source')).toHaveValue('ds-orders');
		await expect(page.locator('.data-browser-source option')).toHaveText(['dev · orders库']);
		await expect(page.locator('.data-browser-status-text')).toContainText('Query failed', { timeout: 20_000 });
		await expect(page.locator('.data-browser-status-text')).toContainText('orders库');
		await page.screenshot({ path: 'test-results/data-browser-dark.png', fullPage: true });

		// Flip the persisted theme and reload: same panel, light tokens.
		await page.evaluate(() => localStorage.setItem('agentChat.preferences', JSON.stringify({ theme: 'light' })));
		await page.reload();
		await openDataTab(page);
		await expect(page.locator('.data-browser-status-text')).toContainText('Query failed', { timeout: 20_000 });
		await page.screenshot({ path: 'test-results/data-browser-light.png', fullPage: true });
	} finally {
		await app?.close();
	}
});

test('data tab: project without data sources shows the guidance empty state', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeProject(dataDir, 'empty', 'Empty', workspace);
		await writeSession(dataDir, 'empty', 'session-empty');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		await openDataTab(page);

		await expect(page.locator('.data-browser-status-text')).toHaveText('项目还没有数据库数据源 — 在项目配置里添加一个。');
		await expect(page.locator('.data-browser-source')).toBeDisabled();
		await expect(page.locator('.data-browser-table')).toBeDisabled();
	} finally {
		await app?.close();
	}
});

test('data tab: grid renders rows, pages, and server-side sort (MELLIVORA_FAKE_DB)', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		// MELLIVORA_FAKE_DB swaps only the database driver for a deterministic
		// in-process dataset (fakeDbRunner.ts) — bridge, IPC, read-only gate,
		// row caps, and the whole panel pipeline run for real.
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);

		// Table list comes from the (fake) catalog with row estimates.
		await expect(page.locator('.data-browser-table option')).toHaveText(['shop.orders（约 120 行）', 'shop.users（约 7 行）']);

		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-col-title').nth(0)).toHaveText('id');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-001');
		// NULL renders muted, not as the string "null"; dates render formatted.
		await expect(grid.locator('.data-browser-null').first()).toHaveText('NULL');
		await expect(page.locator('.data-browser-status-text')).toContainText('100 行+ / 约 120 行');
		await expect(page.locator('.data-browser-status-sql')).toContainText('SELECT * FROM `shop`.`orders` LIMIT 101');

		// Next page: the remaining 20 rows; next disables, prev enables.
		await page.locator('.data-browser-button[title="下一页"]').click();
		await expect(page.locator('.data-browser-page')).toHaveText('第 2 页');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-101');
		await expect(page.locator('.data-browser-button[title="下一页"]')).toBeDisabled();
		await expect(page.locator('.data-browser-button[title="上一页"]')).toBeEnabled();

		// Header click cycles asc → desc server-side: SQL gains ORDER BY, the page
		// resets, and the sorted first row comes back from the "database".
		await grid.locator('.tabulator-col-title', { hasText: 'amount' }).click();
		await expect(page.locator('.data-browser-status-sql')).toContainText('ORDER BY `amount` ASC');
		await grid.locator('.tabulator-col-title', { hasText: 'amount' }).click();
		await expect(page.locator('.data-browser-status-sql')).toContainText('ORDER BY `amount` DESC');
		await expect(page.locator('.data-browser-page')).toHaveText('第 1 页');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-120');
		await page.screenshot({ path: 'test-results/data-browser-grid.png', fullPage: true });
	} finally {
		await app?.close();
	}
});
