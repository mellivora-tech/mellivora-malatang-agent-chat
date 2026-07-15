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

		// Table list comes from the (fake) catalog with row estimates, and the tab
		// chip picks up the browse context as its label.
		await expect(page.locator('.data-browser-table option')).toHaveText(['shop.orders（约 120 行）', 'shop.users（约 7 行）']);
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('dev·orders');

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

test('side pane tabs are instances: + menu, close, and view keep-alive', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);

		// Put the grid in a non-default state: page 2.
		await expect(page.locator('.data-browser-status-text')).toContainText('100 行+');
		await page.locator('.data-browser-button[title="下一页"]').click();
		await expect(page.locator('.data-browser-page')).toHaveText('第 2 页');

		// Open a second tab through the "+" menu.
		await page.locator('.auxiliary-tab-add').click();
		await expect(page.locator('.auxiliary-add-menu-item')).toHaveText(['评审', '数据', '终端', '浏览器']);
		await page.locator('.auxiliary-add-menu-item[data-tab-id="terminal"]').click();
		await expect(page.locator('.auxiliary-tab .auxiliary-tab-label')).toHaveText(['dev·orders', '终端']);
		await expect(page.locator('.auxiliary-view[data-tab-id="data"]')).toBeHidden();

		// Switch back: the data view was kept mounted — still page 2, no requery,
		// and the rows actually PAINT (Tabulator redraws after being display:none).
		await page.locator('.auxiliary-tab[data-tab-id="data"]').click();
		await expect(page.locator('.data-browser-page')).toHaveText('第 2 页');
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-101');
		await expect(grid.locator('.tabulator-row').first()).toBeVisible();
		await page.screenshot({ path: 'test-results/data-browser-tabs.png', fullPage: true });

		// Close the active data tab: terminal takes over; closing it re-opens the picker.
		await page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-close').click();
		await expect(page.locator('.auxiliary-tab .auxiliary-tab-label')).toHaveText(['终端']);
		await expect(page.locator('.auxiliary-view[data-tab-id="terminal"]')).toBeVisible();
		await page.locator('.auxiliary-tab[data-tab-id="terminal"] .auxiliary-tab-close').click();
		await expect(page.locator('.auxiliary-empty-title')).toHaveText('打开标签页');
	} finally {
		await app?.close();
	}
});

test('side pane sash: drag pins a user width, double-click returns to automatic', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);

		const pane = page.locator('.part.auxiliarybar');
		const sash = page.locator('.workbench-sash');
		await expect(sash).toBeVisible();
		const before = (await pane.boundingBox())!.width;

		// Drag the seam 120px to the left → the pane widens by 120 (pinned).
		const box = (await sash.boundingBox())!;
		const centerX = box.x + box.width / 2;
		const centerY = box.y + box.height / 2;
		await page.mouse.move(centerX, centerY);
		await page.mouse.down();
		await page.mouse.move(centerX - 120, centerY, { steps: 6 });
		await page.mouse.up();
		const pinned = (await pane.boundingBox())!.width;
		expect(Math.round(pinned - before)).toBe(120);
		// The persisted value lives in the grid's width domain (visual + part margins).
		const stored = await page.evaluate(() => localStorage.getItem('agentChat.sidePaneWidth'));
		expect(Math.abs(Number(stored) - pinned)).toBeLessThanOrEqual(8);

		// Double-click the sash: back to automatic allocation, persistence cleared.
		await sash.dblclick();
		const reset = (await pane.boundingBox())!.width;
		expect(Math.round(reset)).toBe(Math.round(before));
		expect(await page.evaluate(() => localStorage.getItem('agentChat.sidePaneWidth'))).toBeNull();
	} finally {
		await app?.close();
	}
});

async function writeSessionWithQueryStep(dataDir: string, projectId: string, sessionId: string): Promise<void> {
	const dir = join(dataDir, 'projects', projectId, 'sessions');
	await mkdir(dir, { recursive: true });
	const createdAt = '2026-01-01T00:00:00.000Z';
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId, sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt, interactivity: 'full', projectId }),
		JSON.stringify({ type: 'message', timestamp: createdAt, id: 'u1', role: 'user', text: '查一下订单' }),
		JSON.stringify({
			type: 'message', timestamp: createdAt, id: 'w1', role: 'work', text: '', durationMs: 5000,
			steps: [{ kind: 'tool', label: 'query_data_source', durationMs: 1200, detail: 'id | name\n1 | a', browse: { source: 'ds-orders', sql: 'SELECT id, name, amount, created_at FROM shop.orders WHERE amount > 0' } }],
		}),
		JSON.stringify({ type: 'message', timestamp: createdAt, id: 'a1', role: 'assistant', text: '查到了 120 行。' }),
		JSON.stringify({ type: 'state', timestamp: createdAt, status: 3, title: '数据浏览' }),
	];
	await writeFile(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

test('chat → panel: a query step opens in the data browser as a paged derived table', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSessionWithQueryStep(dataDir, 'shop', 'session-query');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await page.locator('.sessions-list-row').first().click();
		await expect(page.locator('.session-view')).toBeVisible();

		// The settled work block is collapsed — expand it to reach the step.
		await page.locator('.conversation-work-header').click();
		const browseButton = page.locator('.conversation-work-step-browse');
		await expect(browseButton).toContainText('在数据浏览器打开');
		await browseButton.click();

		// The side pane opens on the data tab in query mode: synthetic table
		// entry, wrapped SQL, rows from the (fake) database, context tab label.
		await expect(page.locator('.part.auxiliarybar')).toBeVisible();
		await expect(page.locator('.auxiliary-view[data-tab-id="data"] .data-browser')).toBeVisible();
		await expect(page.locator('.data-browser-table')).toHaveValue('query');
		await expect(page.locator('.data-browser-table option').first()).toHaveText('查询结果');
		await expect(page.locator('.data-browser-status-sql')).toContainText('AS `_browse` LIMIT 101');
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-001');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('dev·查询');

		// Paging works on the wrapped query too.
		await page.locator('.data-browser-button[title="下一页"]').click();
		await expect(page.locator('.data-browser-status-sql')).toContainText('OFFSET 100');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-101');

		// Picking a real table leaves query mode: the synthetic entry disappears.
		await page.locator('.data-browser-table').selectOption('0');
		await expect(page.locator('.data-browser-status-sql')).toContainText('SELECT * FROM `shop`.`orders` LIMIT 101');
		await expect(page.locator('.data-browser-table option').first()).not.toHaveText('查询结果');
	} finally {
		await app?.close();
	}
});

test('panel → chat: 问 AI drops a structured reference into the composer', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-001');

		// Click a cell (row 2, amount column) then 问 AI: the composer receives
		// the precise coordinates — source, table, SQL, page, and the cell.
		await grid.locator('.tabulator-row').nth(1).locator('.tabulator-cell').nth(2).click();
		await page.locator('.data-browser-ask').click();

		const composer = page.locator('.conversation-input');
		await expect(composer).toBeFocused();
		const text = await composer.inputValue();
		expect(text).toContain('引用数据浏览器当前视图：');
		expect(text).toContain('- 数据源: dev · orders库（mysql shop）');
		expect(text).toContain('- 表: shop.orders（约 120 行）');
		expect(text).toContain('- 当前 SQL: SELECT * FROM `shop`.`orders` LIMIT 101');
		expect(text).toContain('- 位置: 第 1 页 · 每页 100 行');
		expect(text).toContain('- 选中单元格: amount = 20（该行 id=2）');
	} finally {
		await app?.close();
	}
});

test('header filters compile to server-side WHERE and survive sorting', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('1');

		// Type an operator filter into the amount column: the panel re-queries
		// with a WHERE — the fake db evaluates it — and paging resets.
		const amountFilter = grid.locator('.tabulator-col[tabulator-field="c2"] .tabulator-header-filter input');
		await amountFilter.click();
		await amountFilter.pressSequentially('>= 1000');
		await expect(page.locator('.data-browser-status-sql')).toContainText('WHERE (`amount` >= 1000)');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('101');
		await expect(page.locator('.data-browser-page')).toHaveText('第 1 页');
		await expect(page.locator('.data-browser-button[title="下一页"]')).toBeDisabled();

		// A second filter ANDs in; the first survives (input value intact).
		const nameFilter = grid.locator('.tabulator-col[tabulator-field="c1"] .tabulator-header-filter input');
		await nameFilter.click();
		await nameFilter.pressSequentially('item-11');
		await expect(page.locator('.data-browser-status-sql')).toContainText("WHERE (`amount` >= 1000) AND (`name` LIKE '%item-11%')");
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-110');
		await expect(amountFilter).toHaveValue('>= 1000');

		// Sorting rebuilds the header — the typed filters come back and still apply.
		await grid.locator('.tabulator-col-title', { hasText: 'id' }).click();
		await grid.locator('.tabulator-col-title', { hasText: 'id' }).click();
		await expect(page.locator('.data-browser-status-sql')).toContainText('ORDER BY `id` DESC');
		await expect(page.locator('.data-browser-status-sql')).toContainText('WHERE (`amount` >= 1000)');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-119');
		await expect(grid.locator('.tabulator-col[tabulator-field="c2"] .tabulator-header-filter input')).toHaveValue('>= 1000');
	} finally {
		await app?.close();
	}
});

test('SQL console: run a read-only statement, writes are refused by the gate', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first()).toBeVisible();

		// Opening the console prefills the selected table's SELECT — edit and run.
		await page.locator('.data-browser-button[title="SQL 控制台"]').click();
		const input = page.locator('.data-browser-sql-input');
		await expect(input).toHaveValue('SELECT * FROM shop.orders');
		await input.fill('SELECT id, name, amount, created_at FROM shop.orders WHERE (`amount` >= 1100)');
		await page.locator('.data-browser-sql-run').click();

		// Query mode: derived-table wrap, filtered rows, synthetic table entry.
		await expect(page.locator('.data-browser-status-sql')).toContainText('AS `_browse` LIMIT 101');
		await expect(page.locator('.data-browser-table')).toHaveValue('query');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('110');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('dev·查询');

		// A write statement never reaches a driver — the gate answers instead.
		await input.fill('DELETE FROM shop.orders');
		await input.press('Meta+Enter');
		await expect(page.locator('.data-browser-status-text')).toContainText('只允许单条只读查询');
	} finally {
		await app?.close();
	}
});

test('maximize: the pane takes the whole content row and restores cleanly', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1' } });
		const page = await app.firstWindow();
		await openDataTab(page);

		const chat = page.locator('.part.sessionspart');
		const pane = page.locator('.part.auxiliarybar');
		const before = (await pane.boundingBox())!.width;

		await page.locator('.auxiliary-tab-maximize').click();
		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/side-pane-maximized/);
		await expect(chat).toBeHidden();
		await expect(page.locator('.workbench-sash')).toBeHidden();
		const maximized = (await pane.boundingBox())!.width;
		expect(maximized).toBeGreaterThan(before + 200);
		// The grid survives the resize (keep-alive + redraw-on-size).
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('item-001');

		// Restore: chat returns at its previous width.
		await page.locator('.auxiliary-tab-maximize').click();
		await expect(chat).toBeVisible();
		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).not.toHaveClass(/side-pane-maximized/);
		expect(Math.round((await pane.boundingBox())!.width)).toBe(Math.round(before));

		// Closing the pane while maximized restores the chat column too.
		await page.locator('.auxiliary-tab-maximize').click();
		await expect(chat).toBeHidden();
		await page.locator('.sessions-titlebar-side-pane-toggle').click();
		await expect(pane).toBeHidden();
		await expect(chat).toBeVisible();
	} finally {
		await app?.close();
	}
});

test('file provider: csv opens, filters and sorts locally, and hands back to SQL mode', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeWorkspaceConfig(workspace);
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		await writeSession(dataDir, 'shop', 'session-data');
		// A csv fixture: header + 30 rows, with a quoted comma to prove real parsing.
		const csv = ['id,name,amount', ...Array.from({ length: 30 }, (_, i) => `${i + 1},"row, ${String(i + 1).padStart(2, '0')}",${(i + 1) * 5}`)].join('\n');
		const csvPath = join(workspace, 'orders.csv');
		await writeFile(csvPath, `${csv}\n`, 'utf8');

		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_FAKE_DB: '1', MELLIVORA_PICK_FILE: csvPath },
		});
		const page = await app.firstWindow();
		await openDataTab(page);
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-row').first()).toBeVisible();

		// Open the csv (the env seam IS the picker): the file rides the source
		// dropdown, the status bar shows the path, rows parse with quotes intact.
		await page.locator('.data-browser-button[title="打开数据文件（csv / xlsx）"]').click();
		await expect(page.locator('.data-browser-source')).toHaveValue('file');
		await expect(page.locator('.data-browser-source option').first()).toHaveText('orders.csv');
		await expect(page.locator('.data-browser-status-text')).toContainText('30 行 / 共 30 行');
		await expect(page.locator('.data-browser-status-sql')).toContainText('orders.csv');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(1)).toHaveText('row, 01');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('orders.csv');

		// The SAME filter grammar, evaluated locally: > 100 on amount → 10 rows.
		const amountFilter = grid.locator('.tabulator-col[tabulator-field="c2"] .tabulator-header-filter input');
		await amountFilter.click();
		await amountFilter.pressSequentially('> 100');
		await expect(page.locator('.data-browser-status-text')).toContainText('10 行 / 共 10 行');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('21');

		// Local server-side-feel sort: id desc puts 30 first.
		await grid.locator('.tabulator-col-title', { hasText: 'id' }).click();
		await grid.locator('.tabulator-col-title', { hasText: 'id' }).click();
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('30');

		// Picking a real database source exits file mode back to the table browser.
		await page.locator('.data-browser-source').selectOption('ds-orders');
		await expect(page.locator('.data-browser-status-sql')).toContainText('SELECT * FROM `shop`.`orders` LIMIT 101');
		await expect(page.locator('.data-browser-source option').first()).not.toHaveText('orders.csv');
	} finally {
		await app?.close();
	}
});

test('file provider: xlsx sheets ride the table dropdown and switch', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeProject(dataDir, 'empty', 'Empty', workspace);
		await writeSession(dataDir, 'empty', 'session-empty');
		// Build a two-sheet workbook with the project's own xlsx dependency.
		const XLSX = await import('xlsx');
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 'x'], [2, 'y']]), '订单');
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['k'], ['only']]), '汇总');
		const xlsxPath = join(workspace, 'book.xlsx');
		XLSX.writeFile(workbook, xlsxPath);

		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_PICK_FILE: xlsxPath },
		});
		const page = await app.firstWindow();
		await openDataTab(page);

		await page.locator('.data-browser-button[title="打开数据文件（csv / xlsx）"]').click();
		await expect(page.locator('.data-browser-table option')).toHaveText(['订单', '汇总']);
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-col-title').nth(0)).toHaveText('a');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('book.xlsx·订单');

		await page.locator('.data-browser-table').selectOption('汇总');
		await expect(grid.locator('.tabulator-col-title').nth(0)).toHaveText('k');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('only');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('book.xlsx·汇总');
	} finally {
		await app?.close();
	}
});

test('render_data chip: an agent-rendered table opens in the panel, replayable after restart', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
		const workspace = await mkdtemp(join(tmpdir(), 'agent-chat-ws-'));
		await writeProject(dataDir, 'shop', 'Shop', workspace);
		// The rendered csv lives in the session's media dir — the readTable gate
		// admits data-dir paths without a picker, so the chip survives restarts.
		const mediaDir = join(dataDir, 'projects', 'shop', 'sessions', 'media', 'session-render');
		await mkdir(mediaDir, { recursive: true });
		const csvPath = join(mediaDir, '汇总-abc123.csv');
		await writeFile(csvPath, 'region,total\n华东,120\n华北,80\n', 'utf8');

		const dir = join(dataDir, 'projects', 'shop', 'sessions');
		const createdAt = '2026-01-01T00:00:00.000Z';
		await writeFile(join(dir, 'session-render.jsonl'), [
			JSON.stringify({ type: 'session', version: 1, sessionId: 'session-render', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt, interactivity: 'full', projectId: 'shop' }),
			JSON.stringify({ type: 'message', timestamp: createdAt, id: 'u1', role: 'user', text: '汇总一下' }),
			JSON.stringify({
				type: 'message', timestamp: createdAt, id: 'w1', role: 'work', text: '', durationMs: 3000,
				steps: [{ kind: 'tool', label: 'render_data', durationMs: 800, detail: '已渲染 2 行 × 2 列到数据面板（汇总-abc123.csv）。', browse: { kind: 'file', path: csvPath, name: '汇总-abc123.csv' } }],
			}),
			JSON.stringify({ type: 'state', timestamp: createdAt, status: 3, title: '渲染表格' }),
		].join('\n') + '\n', 'utf8');

		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		await page.locator('.sessions-list-row').first().click();
		await expect(page.locator('.session-view')).toBeVisible();

		await page.locator('.conversation-work-header').click();
		await page.locator('.conversation-work-step-browse').click();

		await expect(page.locator('.part.auxiliarybar')).toBeVisible();
		await expect(page.locator('.data-browser-source option').first()).toHaveText('汇总-abc123.csv');
		const grid = page.locator('.auxiliary-view[data-tab-id="data"] .data-browser-grid');
		await expect(grid.locator('.tabulator-col-title').nth(0)).toHaveText('region');
		await expect(grid.locator('.tabulator-row').first().locator('.tabulator-cell').nth(0)).toHaveText('华东');
		await expect(grid.locator('.tabulator-row').nth(1).locator('.tabulator-cell').nth(1)).toHaveText('80');
		await expect(page.locator('.auxiliary-tab[data-tab-id="data"] .auxiliary-tab-label')).toHaveText('汇总-abc123.csv');
	} finally {
		await app?.close();
	}
});
