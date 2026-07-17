/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const HOUR_MS = 3_600_000;

async function writeSessionFixture(dataDir: string, index: number, projectId?: string, status = 3): Promise<void> {
	const dir = projectId ? join(dataDir, 'projects', projectId, 'sessions') : join(dataDir, 'sessions');
	await mkdir(dir, { recursive: true });
	const createdAt = new Date(Date.now() - (100 - index) * HOUR_MS).toISOString();
	const id = projectId ? `scroll-${projectId}-${index}` : `scroll-${index}`;
	const lines = [
		JSON.stringify({
			type: 'session',
			version: 1,
			sessionId: id,
			sessionType: 'agent-chat',
			icon: 'codicon-new-session',
			createdAt,
			interactivity: 'full',
			...(projectId ? { projectId } : {}),
		}),
		JSON.stringify({ type: 'message', timestamp: createdAt, id: `m-${id}`, role: 'user', text: `hello ${index}` }),
		JSON.stringify({ type: 'state', timestamp: createdAt, status, title: `Scroll ${projectId ?? 'chat'} ${index}` }),
	];
	await writeFile(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

async function writeProjectFixture(dataDir: string, id: string, name: string, createdAt: string): Promise<void> {
	const dir = join(dataDir, 'projects', id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'project.json'), JSON.stringify({ id, name, path: `/tmp/${id}`, createdAt }), 'utf8');
}

// The sidebar list rebuilds its whole DOM on every render (sessionsList.ts
// render()), so opening a session must restore the reader's scroll position —
// without the save/restore in render() the list snapped back to the top.
// The row is clicked by RAW coordinates: locator.click() auto-scrolls its
// target into view and would mask exactly the regression this test guards.
test('sidebar keeps its scroll position when a session is opened', async () => {
	let app: ElectronApplication | undefined;
	try {
		const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-sidebar-scroll-'));
		await writeProjectFixture(dataDir, 'alpha', 'Alpha', '2026-01-01T00:00:00.000Z');
		for (let i = 0; i < 15; i++) {
			await writeSessionFixture(dataDir, i, 'alpha', i % 3 === 0 ? 2 : 3);
		}
		for (let i = 0; i < 25; i++) {
			await writeSessionFixture(dataDir, i);
		}
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		await page.waitForSelector('.sessions-sidebar-content .sessions-list-row');

		const scrolled = await page.evaluate(() => {
			const content = document.querySelector<HTMLElement>('.sessions-sidebar-content')!;
			content.scrollTop = 400;
			return content.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(0);

		// Click the first row that is FULLY visible at this scroll position.
		const target = await page.evaluate(() => {
			const content = document.querySelector<HTMLElement>('.sessions-sidebar-content')!;
			const bounds = content.getBoundingClientRect();
			for (const row of content.querySelectorAll<HTMLElement>('.sessions-list-row')) {
				const rect = row.getBoundingClientRect();
				if (rect.top > bounds.top + 40 && rect.bottom < bounds.bottom - 40 && rect.height > 0) {
					return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
				}
			}
			return undefined;
		});
		expect(target, 'a fully-visible session row after scrolling').toBeTruthy();
		await page.mouse.click(target!.x, target!.y);

		// Immediately after the open-session render burst, and again once the
		// opened transcript has hydrated (messages/isRead renders included).
		const readScroll = () => page.evaluate(() => document.querySelector<HTMLElement>('.sessions-sidebar-content')!.scrollTop);
		expect(await readScroll()).toBe(scrolled);
		await page.waitForTimeout(800);
		expect(await readScroll()).toBe(scrolled);
	} finally {
		await app?.close();
	}
});
