import { expect, test, _electron as electron } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

test('desktop app launches and streams a mock response', async () => {
	const app = await electron.launch({ args: [path.resolve('.')] });
	const window = await app.firstWindow();

	await expect(window.getByRole('navigation', { name: 'Sessions' })).toBeVisible();
	await expect(window.getByRole('main', { name: 'Chat' })).toBeVisible();

	await window.getByRole('textbox', { name: 'Message' }).fill('hello from e2e');
	await window.getByRole('button', { name: 'Send Message' }).click();

	await expect(window.locator('.message.user .message-content').last()).toHaveText('hello from e2e');
	await expect(window.locator('.message.assistant .message-content').last()).toContainText('The safest first change is to isolate the UI state');
	await expect(window.locator('.message.assistant .message-content').last()).toContainText('renderer can stay deterministic while the provider streams updates');

	await window.getByRole('tab', { name: 'Files' }).click();
	await expect(window.getByRole('tabpanel', { name: 'Files' })).toContainText('src/auth/redirect.ts');

	await mkdir('test-results', { recursive: true });
	await window.setViewportSize({ width: 1440, height: 900 });
	await window.screenshot({ path: 'test-results/agent-chat-1440x900.png', fullPage: true });
	await window.setViewportSize({ width: 1280, height: 720 });
	await window.screenshot({ path: 'test-results/agent-chat-1280x720.png', fullPage: true });

	await app.close();
});
