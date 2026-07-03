/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const screenshots = [
	{ width: 1440, height: 900, path: 'test-results/agents-window-1440x900.png' },
	{ width: 1280, height: 720, path: 'test-results/agents-window-1280x720.png' }
] as const;

test('agents window shell renders at desktop sizes', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({ args: ['dist/main/main.js'] });
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		for (const screenshot of screenshots) {
			await captureAndAssert(page, screenshot);
		}

		await page.locator('.sessions-list-row').first().click();
		await expect(page.locator('.session-view')).toBeVisible();
		await expect(page.locator('.part.auxiliarybar')).toBeVisible();
		await expect(page.locator('.sessions-command-title')).not.toHaveText('New Session');

		await assertDarwinTrafficLightInset(page);
		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

async function captureAndAssert(
	page: Page,
	screenshot: { readonly width: number; readonly height: number; readonly path: string }
): Promise<void> {
	await page.setViewportSize({ width: screenshot.width, height: screenshot.height });
	await page.waitForSelector('.monaco-workbench.agent-sessions-workbench');

	for (const selector of [
		'.monaco-workbench.agent-sessions-workbench',
		'.part.titlebar',
		'.part.sidebar',
		'.part.sessionspart',
		'.sessions-new-session-view'
	]) {
		await expect(page.locator(selector)).toBeVisible();
	}

	await expect(page.locator('.sessions-command-title')).toHaveText('New Session');
	await expect(page.locator('.sessions-sidebar-header-title')).toHaveText('Sessions');
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();
	await expect(page.locator('.new-session-heading')).toContainText('Start by picking a workspace');
	await expect(page.locator('.new-session-input')).toBeVisible();

	const boxes = await page.locator('.part.sessionspart, .part.sidebar').evaluateAll(nodes =>
		nodes.map(node => {
			const rect = node.getBoundingClientRect();
			return {
				width: rect.width,
				height: rect.height,
				text: node.textContent?.trim().length ?? 0
			};
		})
	);

	expect(boxes).toHaveLength(2);
	for (const box of boxes) {
		expect(box.width).toBeGreaterThan(100);
		expect(box.height).toBeGreaterThan(100);
		expect(box.text).toBeGreaterThan(0);
	}

	await page.screenshot({ path: screenshot.path, fullPage: true });
}

async function assertDarwinTrafficLightInset(page: Page): Promise<void> {
	const isDarwin = await page.locator('.agent-sessions-workbench.platform-darwin').count();
	if (!isDarwin) {
		return;
	}

	const brandBox = await page.locator('.sessions-titlebar-brand').boundingBox();
	expect(brandBox).not.toBeNull();
	expect(brandBox!.x).toBeGreaterThan(72);
}
