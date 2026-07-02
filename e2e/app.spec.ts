import { expect, test, _electron as electron } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

test('desktop app launches and streams a mock response', async () => {
	const app = await electron.launch({ args: [path.resolve('.')] });
	try {
		const window = await app.firstWindow();

		await expect(window.getByRole('navigation', { name: 'Sessions' })).toBeVisible();
		await expect(window.getByRole('main', { name: 'Chat' })).toBeVisible();

		const platform = await window.evaluate(() => {
			const bridge = (window as Window & { agentDesktop?: { platform(): string } }).agentDesktop;
			return bridge?.platform() ?? '';
		});
		expect(platform).not.toBe('');

		await window.getByRole('textbox', { name: 'Message' }).fill('hello from e2e');
		await window.getByRole('button', { name: 'Send Message' }).click();

		await expect(window.locator('.message.user .message-content').last()).toHaveText('hello from e2e');
		await expect(window.locator('.message.assistant .message-content').last()).toContainText('The safest first change is to isolate the UI state');
		await expect(window.locator('.message.assistant .message-content').last()).toContainText('renderer can stay deterministic while the provider streams updates');

		await window.getByRole('tab', { name: 'Files' }).click();
		await expect(window.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
		await expect(window.getByRole('tabpanel', { name: 'Files' })).toBeVisible();
		await expect(window.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'false');
		await expect(window.locator('#aux-tabpanel-changes')).toHaveAttribute('hidden', '');
		await expect(window.getByRole('tabpanel', { name: 'Files' })).toContainText('src/auth/redirect.ts');

		await window.getByRole('tab', { name: 'Details' }).click();
		await expect(window.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
		await expect(window.getByRole('tabpanel', { name: 'Details' })).toBeVisible();
		await expect(window.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'false');
		await expect(window.locator('#aux-tabpanel-files')).toHaveAttribute('hidden', '');
		await expect(window.getByRole('tabpanel', { name: 'Details' })).toContainText('Mock Agent');
		await expect(window.getByRole('tabpanel', { name: 'Details' })).toContainText('mellivora-malatang');

		await window.getByRole('tab', { name: 'Changes' }).click();
		await expect(window.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
		await expect(window.getByRole('tabpanel', { name: 'Changes' })).toBeVisible();
		await expect(window.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'false');
		await expect(window.locator('#aux-tabpanel-details')).toHaveAttribute('hidden', '');
		await expect(window.getByRole('tabpanel', { name: 'Changes' })).toContainText('modified • +42 / -18');
		await expect(window.getByRole('tabpanel', { name: 'Changes' })).toContainText('src/auth/redirect.ts');

		await mkdir('test-results', { recursive: true });
		await window.setViewportSize({ width: 1440, height: 900 });
		await window.screenshot({ path: 'test-results/agent-chat-1440x900.png', fullPage: true });
		await window.setViewportSize({ width: 1280, height: 720 });
		await window.screenshot({ path: 'test-results/agent-chat-1280x720.png', fullPage: true });
	} finally {
		await app.close();
	}
});
