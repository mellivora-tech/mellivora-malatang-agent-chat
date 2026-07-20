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
 * producing message in the conversation. The seed also carries a split long
 * answer (#13 长答案分流): a summarized assistant message with a document
 * attachment whose full markdown lives beside the transcript.
 */

const DOCUMENT_FILE = '部署梳理-deadbeef.md';
const DOCUMENT_FULL_TEXT = '# 部署梳理\n\n完整的梳理内容正文，比摘要长得多。';

// The run-end diff snapshot (#13 P2): persisted per-file detail on the state
// entry (the Review tab's data) plus a change-set index line (the panel row).
const CHANGED_FILES = [
	{ path: 'src/app/main.ts', added: 10, removed: 3 },
	{ path: 'docs/notes.md', added: 2, removed: 0, status: 'untracked' },
];

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
		JSON.stringify({
			type: 'message',
			timestamp: now,
			id: 'm-doc',
			role: 'assistant',
			// A split reply as fileSessionsProvider persists it: summary + note +
			// the transcript marker (the card hides the marker line from humans).
			text: '摘要：部署链路问题在网关配置。\n\n（全文见下方产物卡）\n[完整梳理文档: 部署梳理]',
			attachments: [{ kind: 'document', path: `media/artifacts-sess/${DOCUMENT_FILE}`, label: '部署梳理' }],
		}),
		JSON.stringify({
			type: 'state',
			timestamp: now,
			status: 2,
			title: 'artifacts session',
			changesSummary: { files: 2, additions: 12, deletions: 3, changedFiles: CHANGED_FILES },
		}),
	];
	await writeFile(join(dataDir, 'sessions', 'artifacts-sess.jsonl'), `${lines.join('\n')}\n`, 'utf8');
	// The split answer's full text, exactly where storeSessionDocument puts it.
	await mkdir(join(dataDir, 'sessions', 'media', 'artifacts-sess'), { recursive: true });
	await writeFile(join(dataDir, 'sessions', 'media', 'artifacts-sess', DOCUMENT_FILE), DOCUMENT_FULL_TEXT, 'utf8');
	// A change-set row as the run-end capture appends it (#13 P2). The mount-time
	// rebuild wipes and rescans this index — the row can only survive via the
	// preserved-kinds carry-over, so its presence below proves that logic.
	await writeFile(
		join(dataDir, 'artifacts.jsonl'),
		`${JSON.stringify({
			id: 'artifacts-sess:changeset:deadbeef',
			kind: 'change-set',
			sessionId: 'artifacts-sess',
			title: '2 个文件改动',
			createdAt: now,
			payload: { type: 'change-set', files: CHANGED_FILES.map(({ path, added, removed }) => ({ path, added, removed })) },
		})}\n`,
		'utf8',
	);
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

		// The split answer (#13 长答案分流): the bubble shows the summary but hides
		// the transcript marker line; the document card carries the title and
		// expands to the full markdown loaded from session media.
		const docMessage = page.locator('.conversation-transcript [data-message-id="m-doc"]');
		await expect(docMessage.locator('.conversation-message-text')).toContainText('摘要：部署链路问题在网关配置。');
		await expect(docMessage.locator('.conversation-message-text')).not.toContainText('完整梳理文档');
		const docCard = docMessage.locator('.conversation-document-card');
		await expect(docCard.locator('.codicon-file-text')).toBeVisible();
		await expect(docCard.locator('.conversation-document-title')).toHaveText('部署梳理');
		await expect(docCard.locator('.conversation-document-body')).toBeHidden();
		await docCard.locator('.conversation-document-toggle').click();
		await expect(docCard.locator('.conversation-document-body')).toContainText('完整的梳理内容正文，比摘要长得多。');
		await docCard.locator('.conversation-document-toggle').click();
		await expect(docCard.locator('.conversation-document-body')).toBeHidden();

		// Open the side pane and pick the artifacts tab from the empty-state picker.
		await page.locator('.sessions-titlebar-side-pane-toggle').click();
		await page.locator('.auxiliary-empty-card').filter({ hasText: '产出物' }).click();
		await expect(page.locator('.auxiliary-view[data-tab-id="artifacts"]')).toBeVisible();

		// Message/media rows come from the mount-time rebuild scanning the session
		// transcript (the backfill acceptance); the change-set row rides through
		// the same rebuild only via preservation.
		const group = page.locator('.artifacts-group[data-session-id="artifacts-sess"]');
		await expect(group.locator('.artifacts-group-header')).toHaveText('artifacts session');
		await expect(group.locator('.artifact-row')).toHaveCount(4);

		// The rebuild's media scan regenerates the document row from its .md file.
		const docRow = group.locator('.artifact-row[data-artifact-kind="document"]');
		await expect(docRow.locator('.codicon-file-text')).toBeVisible();
		await expect(docRow.locator('.artifact-row-title')).toHaveText('部署梳理');

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

		// change-set (#13 P2): the row survived the rebuild (preserved kind),
		// wears the diff codicon, and opens the Review tab with the REAL file
		// list — paths and per-file +/− from the persisted summary, no
		// placeholder names.
		const changeSetRow = group.locator('.artifact-row[data-artifact-kind="change-set"]');
		await expect(changeSetRow.locator('.codicon-diff')).toBeVisible();
		await expect(changeSetRow.locator('.artifact-row-title')).toHaveText('2 个文件改动');
		await changeSetRow.click();
		const reviewView = page.locator('.auxiliary-view[data-tab-id="review"]');
		await expect(reviewView).toBeVisible();
		const fileRows = reviewView.locator('.changes-file-row');
		await expect(fileRows).toHaveCount(2);
		await expect(fileRows.nth(0).locator('.changes-file-name')).toHaveText('src/app/main.ts');
		await expect(fileRows.nth(0).locator('.changes-file-added')).toHaveText('+10');
		await expect(fileRows.nth(0).locator('.changes-file-removed')).toHaveText('-3');
		await expect(fileRows.nth(1).locator('.changes-file-name')).toHaveText('docs/notes.md');
		await expect(fileRows.nth(1).locator('.changes-file-added')).toHaveText('+2');
		await expect(reviewView.locator('.changes-summary-stat.additions .changes-summary-value')).toHaveText('+12');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await app?.close();
	}
});
