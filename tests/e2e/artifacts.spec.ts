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
 * The artifacts panel (#13 P1): opening the tab backfills the index from
 * pre-existing session transcripts (no artifacts.jsonl is seeded), groups the
 * rows by session, and a message-payload row jumps to — and flashes — the
 * producing message in the conversation.
 */

async function seedSession(dataDir: string): Promise<void> {
	const now = new Date().toISOString();
	await mkdir(join(dataDir, 'sessions'), { recursive: true });
	const lines = [
		JSON.stringify({ type: 'session', version: 1, sessionId: 'artifacts-sess', sessionType: 'agent-chat', icon: 'codicon-new-session', createdAt: now, interactivity: 'full' }),
		JSON.stringify({ type: 'message', timestamp: now, id: 'u1', role: 'user', text: '规划一下迁移' }),
		JSON.stringify({
			type: 'message',
			timestamp: now,
			id: 'm-plan',
			role: 'plan',
			text: '## 迁移方案\n\n分两步走。',
			plan: { id: 'plan-1', version: 1, title: '迁移方案', sections: [], state: 'draft' },
		}),
		JSON.stringify({
			type: 'message',
			timestamp: now,
			id: 'm-ui',
			role: 'ui',
			text: '## 订单表迁移映射\n\nfallback markdown 内容。',
			// An unregistered component renders the markdown fallback — the panel
			// only needs the envelope's title, so the jump target stays stable.
			ui: { id: 'ui-1', component: 'future_widget', title: '订单表迁移映射', props: { x: 1 } },
		}),
		JSON.stringify({ type: 'state', timestamp: now, status: 2, title: 'artifacts session' }),
	];
	await writeFile(join(dataDir, 'sessions', 'artifacts-sess.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

test('artifacts tab backfills existing sessions, groups rows by session, and a ui-card row jumps to the highlighted message', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-artifacts-'));
	await seedSession(dataDir);

	let app: ElectronApplication | undefined;
	const errors: string[] = [];
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		page.on('pageerror', error => errors.push(error.message));
		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.waitForSelector('.sessions-sidebar');
		await page.locator('.sessions-project-task-row').filter({ hasText: 'artifacts session' }).click();
		await page.waitForSelector('.conversation-transcript');

		// Open the side pane and pick the artifacts tab from the empty-state picker.
		await page.locator('.sessions-titlebar-side-pane-toggle').click();
		await page.locator('.auxiliary-empty-card').filter({ hasText: '产出物' }).click();
		await expect(page.locator('.auxiliary-view[data-tab-id="artifacts"]')).toBeVisible();

		// No artifacts.jsonl was seeded — rows can only come from the mount-time
		// rebuild scanning the session transcript (the backfill acceptance).
		const group = page.locator('.artifacts-group[data-session-id="artifacts-sess"]');
		await expect(group.locator('.artifacts-group-header')).toHaveText('artifacts session');
		await expect(group.locator('.artifact-row')).toHaveCount(2);

		// Newest-first inside the group would be ambiguous here (same timestamp)
		// — assert by kind instead: each row wears its own codicon and a time label.
		const planRow = group.locator('.artifact-row[data-artifact-kind="plan"]');
		await expect(planRow.locator('.codicon-checklist')).toBeVisible();
		await expect(planRow.locator('.artifact-row-title')).toHaveText('迁移方案');
		await expect(planRow.locator('.artifact-row-time')).toHaveText('now');
		const uiRow = group.locator('.artifact-row[data-artifact-kind="ui-card"]');
		await expect(uiRow.locator('.codicon-layout')).toBeVisible();
		await expect(uiRow.locator('.artifact-row-title')).toHaveText('订单表迁移映射');

		// The jump: open the producing session and flash the exact message.
		await uiRow.click();
		const target = page.locator('.conversation-transcript [data-message-id="m-ui"]');
		await expect(target).toHaveClass(/artifact-reveal-highlight/);
		await expect(target).toBeInViewport();
		// The flash is temporary — the transcript returns to its normal styling.
		await expect(target).not.toHaveClass(/artifact-reveal-highlight/, { timeout: 5000 });

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await app?.close();
	}
});
