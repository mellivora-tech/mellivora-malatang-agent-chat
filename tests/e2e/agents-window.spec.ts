/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';

async function createDataDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-e2e-'));
}

interface ISessionFixture {
	readonly sessionId: string;
	readonly projectId?: string;
	readonly title: string;
	readonly status: number;
	readonly interactivity: 'full' | 'read-only' | 'hidden';
	readonly workspace?: { label: string; description?: string; branchName?: string };
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messages: readonly { id: string; role: 'user' | 'assistant' | 'tool'; text: string; detail?: string }[];
}

async function writeSessionFixture(dataDir: string, fixture: ISessionFixture): Promise<void> {
	const dir = fixture.projectId ? join(dataDir, 'projects', fixture.projectId, 'sessions') : join(dataDir, 'sessions');
	await mkdir(dir, { recursive: true });
	const lines = [
		JSON.stringify({
			type: 'session',
			version: 1,
			sessionId: fixture.sessionId,
			sessionType: 'agent-chat',
			icon: 'codicon-new-session',
			createdAt: fixture.createdAt,
			interactivity: fixture.interactivity,
			...(fixture.projectId ? { projectId: fixture.projectId } : {}),
			...(fixture.workspace ? { workspace: fixture.workspace } : {}),
		}),
		...fixture.messages.map(message => JSON.stringify({ type: 'message', timestamp: fixture.createdAt, ...message })),
		JSON.stringify({ type: 'state', timestamp: fixture.updatedAt, status: fixture.status, title: fixture.title }),
	];
	await writeFile(join(dir, `${fixture.sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

interface IProjectFixture {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly createdAt: string;
}

async function writeProjectFixture(dataDir: string, fixture: IProjectFixture): Promise<void> {
	const dir = join(dataDir, 'projects', fixture.id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'project.json'), JSON.stringify(fixture), 'utf8');
}

// createdAt order decides sidebar group order (listProjects sorts ascending).
const OBSIDIAN_PROJECT: IProjectFixture = { id: 'obsidian', name: 'Obsidian', path: '/tmp/obsidian', createdAt: '2026-01-01T00:00:00.000Z' };
const ZCODE_PROJECT: IProjectFixture = { id: 'zcodeproject', name: 'ZCodeProject', path: '/tmp/zcodeproject', createdAt: '2026-01-02T00:00:00.000Z' };

const HOUR_MS = 3_600_000;

const IN_PROGRESS_FIXTURE: ISessionFixture = {
	sessionId: 'session-in-progress',
	projectId: 'obsidian',
	title: '梳理下文档',
	status: 2,
	interactivity: 'full',
	workspace: { label: 'Obsidian', description: '~/workspace/code/learning-projects' },
	createdAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
	updatedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
	messages: [
		{ id: 'main-user-1', role: 'user', text: 'Rebuild the agents window shell.' },
		{ id: 'main-assistant-1', role: 'assistant', text: 'I have the layout in place and I am wiring the mock session domain now.' },
		{ id: 'main-tool-1', role: 'tool', text: 'typecheck', detail: 'Workbench services, mock provider, and conversation UI are wired.' },
	],
};

const COMPLETED_FIXTURE: ISessionFixture = {
	sessionId: 'session-completed',
	projectId: 'zcodeproject',
	title: 'Ship settings sidebar cleanup',
	status: 3,
	interactivity: 'read-only',
	workspace: { label: 'ZCodeProject', description: '~/workspace/code/internal' },
	createdAt: new Date(Date.now() - 6 * HOUR_MS).toISOString(),
	updatedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
	messages: [
		{ id: 'done-user-1', role: 'user', text: 'Clean up the settings sidebar.' },
		{ id: 'done-assistant-1', role: 'assistant', text: 'The cleanup shipped with the sidebar refactor.' },
		{ id: 'done-tool-1', role: 'tool', text: 'verify', detail: 'All checks passed.' },
	],
};

const screenshots = [
	{ width: 1440, height: 900, path: 'test-results/agents-window-1440x900.png' },
	{ width: 1280, height: 720, path: 'test-results/agents-window-1280x720.png' },
] as const;

test('agents window shell renders at desktop sizes', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		const dataDir = await createDataDir();
		await writeProjectFixture(dataDir, OBSIDIAN_PROJECT);
		await writeProjectFixture(dataDir, ZCODE_PROJECT);
		await writeSessionFixture(dataDir, IN_PROGRESS_FIXTURE);
		await writeSessionFixture(dataDir, COMPLETED_FIXTURE);
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
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

		await assertSidebarToggle(page);

		await page.locator('.sessions-list-row').first().click();
		await expect(page.locator('.session-view')).toBeVisible();
		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/mode-conversation/);
		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).not.toHaveClass(/mode-session-detail/);
		await expect(page.locator('.conversation-tabs-bar')).toHaveCount(0);
		await expect(page.locator('.session-chat-tabs-bar')).toHaveCount(0);
		await expect(page.locator('.part.auxiliarybar')).toBeHidden();
		await expect(page.locator('.sessions-command-center')).toHaveCount(0);

		await assertTitlebarControls(page);
		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('starting a conversation creates a running session shell', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000', AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await assertRunningConversationShell(page);

		// A session with no workspace lands in the Chat section — a top-level peer of Pinned and Projects.
		const chatSection = page.locator('[data-session-group="chat"]');
		await expect(chatSection.locator('.sessions-tree-section-label')).toHaveText('Chat');
		await expect(chatSection.locator('.sessions-project-task-title')).toHaveText('hello');
		await expect(page.locator('.sessions-sidebar-tree-section > .sessions-tree-section-toggle')).toHaveText(['Projects', 'Chat']);

		await assertRightSidePaneInteraction(page);
		await page.screenshot({ path: 'test-results/agents-window-running-session.png', fullPage: true });

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('project picker threads the seeded project into a new session', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	const projectDir = join(dataDir, 'projects', 'aaaa1111');
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		join(projectDir, 'project.json'),
		JSON.stringify({ id: 'aaaa1111', name: 'Seeded Project', path: '/tmp/seeded-project', createdAt: '2026-07-06T00:00:00.000Z' }),
		'utf8',
	);

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000', AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await expect(page.locator('.new-session-composer-context')).toContainText('Seeded Project');

		await page.locator('.new-session-composer-context').click();
		await expect(page.locator('.new-session-project-menu')).toBeVisible();
		const seededItem = page.locator('.new-session-project-item').filter({ hasText: 'Seeded Project' });
		await expect(seededItem).toBeVisible();
		await expect(seededItem.locator('.codicon-check')).not.toHaveClass(/project-check-hidden/);
		await expect(page.locator('.new-session-project-add')).toContainText('Add project');
		await page.keyboard.press('Escape');
		await expect(page.locator('.new-session-project-menu')).toHaveCount(0);

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.conversation-context-workspace').first()).toContainText('Seeded Project');

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('first launch creates the projects root and shows the empty picker state', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.waitForSelector('.sessions-new-session-view');
		await expect(page.locator('.new-session-composer-context')).toContainText('Select project');

		const stats = await stat(join(dataDir, 'projects'));
		expect(stats.isDirectory()).toBe(true);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('sessions persist across app relaunch', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	const rendererErrors: string[] = [];
	const launch = async () => {
		const app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '500', AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));
		await page.setViewportSize({ width: 1600, height: 997 });
		return { app, page };
	};

	let app: ElectronApplication | undefined;
	try {
		const first = await launch();
		app = first.app;
		await first.page.waitForSelector('.sessions-new-session-view');
		await first.page.locator('.new-session-input').fill('persist me');
		await first.page.locator('.new-session-send-button').click();
		await expect(first.page.locator('.conversation-message.assistant .conversation-message-text').last()).toHaveText('Mock response for: persist me');
		await first.app.close();
		app = undefined;

		const files = await readdir(join(dataDir, 'sessions'));
		expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1);

		const second = await launch();
		app = second.app;
		const page = second.page;
		await page.waitForSelector('.sessions-new-session-view');

		const row = page.locator('.sessions-project-task-row').filter({ hasText: 'persist me' });
		await expect(row).toBeVisible();
		await row.click();

		await expect(page.locator('.conversation-context-title')).toHaveText('persist me');
		await expect(page.locator('.conversation-message')).toHaveCount(2);
		await expect(page.locator('.conversation-message.user .conversation-message-bubble')).toHaveText('persist me');
		await expect(page.locator('.conversation-message.assistant .conversation-message-text')).toHaveText('Mock response for: persist me');
		await expect(page.locator('.conversation-view')).toHaveAttribute('data-status', 'needs-input');
		await expect(page.locator('.conversation-thinking-row')).toHaveCount(0);
		await expect(page.locator('.conversation-input')).toBeEnabled();

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('project sessions land under the project directory', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	const projectDir = join(dataDir, 'projects', 'bbbb2222');
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		join(projectDir, 'project.json'),
		JSON.stringify({ id: 'bbbb2222', name: 'Persist Project', path: '/tmp/persist-project', createdAt: '2026-07-07T00:00:00.000Z' }),
		'utf8',
	);

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '500', AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');
		await expect(page.locator('.new-session-composer-context')).toContainText('Persist Project');

		await page.locator('.new-session-input').fill('project session');
		await page.locator('.new-session-send-button').click();
		await expect(page.locator('.conversation-message.assistant .conversation-message-text').last()).toHaveText('Mock response for: project session');
		await expect(page.locator('.conversation-context-workspace').first()).toContainText('Persist Project');

		const files = await readdir(join(projectDir, 'sessions'));
		expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('pin and archive survive an app relaunch', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	await writeProjectFixture(dataDir, OBSIDIAN_PROJECT);
	await writeProjectFixture(dataDir, ZCODE_PROJECT);
	await writeSessionFixture(dataDir, IN_PROGRESS_FIXTURE);
	await writeSessionFixture(dataDir, COMPLETED_FIXTURE);

	const rendererErrors: string[] = [];
	const launch = async () => {
		const app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));
		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-sidebar');
		return { app, page };
	};

	let app: ElectronApplication | undefined;
	try {
		const first = await launch();
		app = first.app;

		const obsidianRow = first.page.locator('[data-project-id="obsidian"] .sessions-project-task-row').filter({ hasText: '梳理下文档' });
		await obsidianRow.hover();
		await obsidianRow.locator('.sessions-project-task-pin').click();
		await expect(first.page.locator('[data-session-group="pinned"] .sessions-project-task-title')).toHaveText('梳理下文档');

		const zcodeRow = first.page.locator('[data-project-id="zcodeproject"] .sessions-project-task-row').filter({ hasText: 'Ship settings sidebar cleanup' });
		await zcodeRow.hover();
		await zcodeRow.locator('.sessions-project-task-action').click();
		await expect(first.page.locator('[data-project-id="zcodeproject"] .sessions-project-empty')).toHaveText('No tasks yet');

		await first.app.close();
		app = undefined;

		const second = await launch();
		app = second.app;

		await expect(second.page.locator('[data-session-group="pinned"] .sessions-project-task-title')).toHaveText('梳理下文档');
		await expect(second.page.locator('[data-project-id="obsidian"] .sessions-project-empty')).toHaveText('No tasks yet');
		await expect(second.page.locator('[data-project-id="zcodeproject"] .sessions-project-empty')).toHaveText('No tasks yet');
		await expect(second.page.locator('.sessions-project-task-row').filter({ hasText: 'Ship settings sidebar cleanup' })).toHaveCount(0);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('deleting a session removes its transcript', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	await writeProjectFixture(dataDir, OBSIDIAN_PROJECT);
	await writeSessionFixture(dataDir, IN_PROGRESS_FIXTURE);

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-sidebar');

		const row = page.locator('[data-project-id="obsidian"] .sessions-project-task-row').filter({ hasText: '梳理下文档' });
		await row.hover();
		await row.locator('.sessions-project-task-delete').click();

		await expect(page.locator('[data-project-id="obsidian"] .sessions-project-empty')).toHaveText('No tasks yet');
		await expect
			.poll(async () => {
				const files = await readdir(join(dataDir, 'projects', 'obsidian', 'sessions'));
				return files.filter(file => file.endsWith('.jsonl')).length;
			})
			.toBe(0);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('the active project is restored after relaunch', async () => {
	await mkdir('test-results', { recursive: true });

	const dataDir = await createDataDir();
	await writeProjectFixture(dataDir, OBSIDIAN_PROJECT);
	await writeProjectFixture(dataDir, ZCODE_PROJECT);

	const rendererErrors: string[] = [];
	const launch = async () => {
		const app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('pageerror', error => rendererErrors.push(error.message));
		await page.waitForSelector('.sessions-new-session-view');
		return { app, page };
	};

	let app: ElectronApplication | undefined;
	try {
		const first = await launch();
		app = first.app;

		await expect(first.page.locator('.new-session-composer-context')).toContainText('Obsidian');
		await first.page.locator('.new-session-composer-context').click();
		await first.page.locator('.new-session-project-item').filter({ hasText: 'ZCodeProject' }).click();
		await expect(first.page.locator('.new-session-composer-context')).toContainText('ZCodeProject');

		await expect
			.poll(() =>
				stat(join(dataDir, 'state.json')).then(
					() => true,
					() => false,
				),
			)
			.toBe(true);
		await first.app.close();
		app = undefined;

		const second = await launch();
		app = second.app;
		await expect(second.page.locator('.new-session-composer-context')).toContainText('ZCodeProject');

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('enter starts a session from the new session landing', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000', AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello enter');
		await page.locator('.new-session-input').press('Enter');

		await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/mode-conversation/);
		await expect(page.locator('.conversation-context-title')).toHaveText('hello enter');

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('conversation supports stop and follow-up turns', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '500', AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.conversation-message.assistant .conversation-message-text').last()).toHaveText('Mock response for: hello');
		await expect(page.locator('.conversation-send-button')).toBeVisible();
		await expect(page.locator('.conversation-stop-button')).toBeHidden();

		await page.locator('.conversation-input').fill('follow up');
		await page.locator('.conversation-input').press('Enter');
		await expect(page.locator('.conversation-message.user .conversation-message-bubble').last()).toHaveText('follow up');
		await expect(page.locator('.conversation-message.assistant .conversation-message-text').last()).toHaveText('Mock response for: follow up');

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('stop button ends the running state', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000', AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('hello');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.conversation-stop-button')).toBeVisible();
		await page.locator('.conversation-stop-button').click();

		await expect(page.locator('.conversation-send-button')).toBeVisible();
		await expect(page.locator('.conversation-stop-button')).toBeHidden();
		await expect(page.locator('.conversation-thinking-row')).toHaveCount(0);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('starting multiple conversations keeps a single active conversation page', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_MOCK_DELAY_MS: '120000', AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		await page.locator('.new-session-input').fill('first task');
		await page.locator('.new-session-send-button').click();
		await expect(page.locator('.session-view')).toHaveCount(1);
		await expect(page.locator('.conversation-context-title')).toHaveText('first task');

		await page.locator('.sessions-sidebar-header .action-item').filter({ hasText: 'New task' }).click();
		await expect(page.locator('.sessions-new-session-view')).toBeVisible();

		await page.locator('.new-session-input').fill('second task');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.session-view')).toHaveCount(1);
		await expect(page.locator('.conversation-context-title')).toHaveText('second task');
		await expect(page.locator('.sessions-project-task-row').filter({ hasText: 'first task' })).toBeVisible();
		await expect(page.locator('.sessions-project-task-row.active').filter({ hasText: 'second task' })).toBeVisible();

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('historical conversation messages align by role', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		const dataDir = await createDataDir();
		await writeSessionFixture(dataDir, IN_PROGRESS_FIXTURE);
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-sidebar');
		await page.locator('.sessions-project-task-row').filter({ hasText: '梳理下文档' }).click();

		await expect(page.locator('.conversation-message')).toHaveCount(3);
		await expect(page.locator('.conversation-message.user .conversation-message-bubble')).toHaveText('Rebuild the agents window shell.');
		await expect(page.locator('.conversation-message.assistant .conversation-message-text')).toContainText('I have the layout in place');
		await expect(page.locator('.conversation-message.tool .conversation-tool-detail')).toContainText('Workbench services');
		await assertHistoricalConversationMessageLayout(page, 'needs-input', 'full', false);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('completed conversation shows read-only idle message state', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		const dataDir = await createDataDir();
		await writeSessionFixture(dataDir, COMPLETED_FIXTURE);
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: dataDir },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-sidebar');
		await page.locator('.sessions-project-task-row').filter({ hasText: 'Ship settings sidebar cleanup' }).click();

		await expect(page.locator('.conversation-context-title')).toHaveText('Ship settings sidebar cleanup');
		await expect(page.locator('.conversation-view')).toHaveAttribute('data-status', 'completed');
		await expect(page.locator('.conversation-view')).toHaveAttribute('data-interactivity', 'read-only');
		await expect(page.locator('.conversation-message')).toHaveCount(3);
		await expect(page.locator('.conversation-working-row')).toHaveCount(0);
		await expect(page.locator('.conversation-thinking-row')).toHaveCount(0);
		await expect(page.locator('.conversation-composer')).toHaveAttribute('data-state', 'idle');
		await expect(page.locator('.conversation-composer')).not.toHaveClass(/running/);
		await expect(page.locator('.conversation-input')).toHaveAttribute('placeholder', 'Session is read-only');
		await expect(page.locator('.conversation-input')).toBeDisabled();
		await expect(page.locator('.conversation-reconnect-status')).toBeHidden();
		await expect(page.locator('.conversation-stop-button')).toBeHidden();
		await expect(page.locator('.conversation-send-button')).toBeVisible();
		await expect(page.locator('.conversation-send-button')).toBeDisabled();
		await assertHistoricalConversationMessageLayout(page, 'completed', 'read-only', false);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

test('empty new-session submit keeps focus in the landing composer', async () => {
	await mkdir('test-results', { recursive: true });

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];

	try {
		app = await electron.launch({
			args: ['dist/main/main.js'],
			env: { ...process.env, AGENT_CHAT_DATA_DIR: await createDataDir() },
		});
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));

		await page.setViewportSize({ width: 1600, height: 997 });
		await page.waitForSelector('.sessions-new-session-view');

		const input = page.locator('.new-session-input');
		await input.fill('   ');
		await page.locator('.new-session-send-button').click();

		await expect(page.locator('.sessions-new-session-view')).toBeVisible();
		await expect(input).toBeFocused();

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
	}
});

async function captureAndAssert(page: Page, screenshot: { readonly width: number; readonly height: number; readonly path: string }): Promise<void> {
	await page.setViewportSize({ width: screenshot.width, height: screenshot.height });
	await page.waitForSelector('.monaco-workbench.agent-sessions-workbench');

	for (const selector of ['.monaco-workbench.agent-sessions-workbench', '.part.titlebar', '.part.sidebar', '.part.sessionspart', '.sessions-new-session-view']) {
		await expect(page.locator(selector)).toBeVisible();
	}

	await assertThemeTokens(page);
	await assertShellLayout(page, screenshot.width, screenshot.height);
	await assertTitlebarControls(page);
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();
	await expect(page.locator('.sessions-command-center')).toHaveCount(0);
	await assertSidebarLayout(page);
	await expect(page.locator('.new-session-watermark')).toBeVisible();
	await expect(page.locator('.new-session-watermark')).toHaveText('');
	await expect(page.locator('.new-session-heading')).toHaveText('Morning, how can I help?');
	// The shell test seeds two projects; the first becomes active by default.
	await expect(page.locator('.new-session-composer-context')).toContainText('Obsidian');
	await expect(page.locator('.new-session-input')).toHaveAttribute('placeholder', /Ask ZCode anything/);
	await expect(page.locator('.new-session-input')).toBeVisible();
	await expect(page.locator('.new-session-access')).toContainText('Full access');
	await expect(page.locator('.new-session-model')).toContainText('GLM-5.2');
	await expect(page.locator('.new-session-agent')).toContainText('Max');

	const boxes = await page.locator('.part.sessionspart, .part.sidebar').evaluateAll(nodes =>
		nodes.map(node => {
			const rect = node.getBoundingClientRect();
			return {
				width: rect.width,
				height: rect.height,
				text: node.textContent?.trim().length ?? 0,
			};
		}),
	);

	expect(boxes).toHaveLength(2);
	for (const box of boxes) {
		expect(box.width).toBeGreaterThan(100);
		expect(box.height).toBeGreaterThan(100);
		expect(box.text).toBeGreaterThan(0);
	}

	await page.mouse.move(screenshot.width - 4, screenshot.height - 4);
	await page.screenshot({ path: screenshot.path, fullPage: true });
}

async function assertShellLayout(page: Page, width: number, height: number): Promise<void> {
	const metrics = await page.locator('.monaco-workbench.agent-sessions-workbench').evaluate(
		(root, viewport) => {
			const workbench = root as HTMLElement;
			const sidebar = workbench.querySelector<HTMLElement>('.part.sidebar');
			const stage = workbench.querySelector<HTMLElement>('.part.sessionspart');
			const titlebar = workbench.querySelector<HTMLElement>('.part.titlebar');
			if (!sidebar || !stage || !titlebar) {
				throw new Error('Shell parts were not found');
			}

			const style = getComputedStyle(workbench);
			const sidebarRect = sidebar.getBoundingClientRect();
			const stageRect = stage.getBoundingClientRect();
			const titlebarRect = titlebar.getBoundingClientRect();

			return {
				viewport,
				sidebarX: Math.round(sidebarRect.x),
				sidebarY: Math.round(sidebarRect.y),
				sidebarWidth: Math.round(sidebarRect.width),
				sidebarHeight: Math.round(sidebarRect.height),
				stageX: Math.round(stageRect.x),
				stageY: Math.round(stageRect.y),
				stageWidth: Math.round(stageRect.width),
				stageHeight: Math.round(stageRect.height),
				titlebarX: Math.round(titlebarRect.x),
				titlebarY: Math.round(titlebarRect.y),
				titlebarHeight: Math.round(titlebarRect.height),
				titlebarZIndex: Number(getComputedStyle(titlebar).zIndex),
				sidebarWidthToken: style.getPropertyValue('--vscode-agents-size-sidebar-width').trim(),
				stageMarginToken: style.getPropertyValue('--vscode-agents-size-stage-margin').trim(),
				stageRadius: getComputedStyle(stage).borderTopLeftRadius,
				stageBackground: getComputedStyle(stage).backgroundColor,
				stageBackgroundToken: normalizeColor(style.getPropertyValue('--vscode-agents-color-stage-background').trim()),
			};

			function normalizeColor(value: string): string {
				const probe = document.createElement('span');
				probe.style.color = value;
				document.body.appendChild(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			}
		},
		{ width, height },
	);

	expect(metrics.sidebarWidthToken).toBe('270px');
	expect(metrics.stageMarginToken).toBe('4px');
	expect(metrics.sidebarX).toBe(0);
	expect(metrics.sidebarY).toBe(0);
	expect(metrics.sidebarWidth).toBe(270);
	expect(metrics.sidebarHeight).toBe(height);
	expect(metrics.stageX).toBe(274);
	expect(metrics.stageY).toBeGreaterThanOrEqual(4);
	expect(metrics.stageY).toBeLessThanOrEqual(8);
	expect(metrics.stageWidth).toBeGreaterThan(width - 280);
	expect(metrics.stageHeight).toBeGreaterThan(height - 16);
	expect(metrics.titlebarX).toBe(0);
	expect(metrics.titlebarY).toBe(0);
	expect(metrics.titlebarHeight).toBe(52);
	expect(metrics.titlebarZIndex).toBeGreaterThan(10);
	expect(metrics.stageRadius).toBe('10px');
	expect(metrics.stageBackground).toBe(metrics.stageBackgroundToken);
}

async function assertThemeTokens(page: Page): Promise<void> {
	const themeTokens = await page.locator('.monaco-workbench.agent-sessions-workbench').evaluate(element => {
		const workbench = element as HTMLElement;
		const styles = getComputedStyle(workbench);
		return {
			theme: workbench.dataset['agentsTheme'],
			panelBackground: styles.getPropertyValue('--vscode-agents-color-panel-background').trim(),
			sidebarBackground: styles.getPropertyValue('--vscode-agents-color-sidebar-background').trim(),
			stageBackground: styles.getPropertyValue('--vscode-agents-color-stage-background').trim(),
			textPrimary: styles.getPropertyValue('--vscode-agents-color-text-primary').trim(),
			focusBorder: styles.getPropertyValue('--vscode-agents-color-focusBorder').trim(),
			titlebarHeight: styles.getPropertyValue('--vscode-agents-size-titlebar-height').trim(),
			sidebarWidth: styles.getPropertyValue('--vscode-agents-size-sidebar-width').trim(),
			sidebarGutter: styles.getPropertyValue('--vscode-agents-size-sidebar-gutter').trim(),
			conversationWidth: styles.getPropertyValue('--vscode-agents-size-conversation-width').trim(),
			composerWidth: styles.getPropertyValue('--vscode-agents-size-composer-width').trim(),
			composerContextHeight: styles.getPropertyValue('--vscode-agents-size-composer-contextHeight').trim(),
			composerInputHeight: styles.getPropertyValue('--vscode-agents-size-composer-inputHeight').trim(),
			composerToolbarHeight: styles.getPropertyValue('--vscode-agents-size-composer-toolbarHeight').trim(),
			composerContextGap: styles.getPropertyValue('--vscode-agents-space-composer-contextGap').trim(),
			controlRadius: styles.getPropertyValue('--vscode-agents-radius-control').trim(),
			legacyPanelBackground: styles.getPropertyValue('--vscode-agentsPanel-background').trim(),
		};
	});

	expect(themeTokens).toEqual({
		theme: 'dark',
		panelBackground: '#252526',
		sidebarBackground: '#24343a',
		stageBackground: '#1a1a1a',
		textPrimary: '#cccccc',
		focusBorder: '#0078d4',
		titlebarHeight: '52px',
		sidebarWidth: '270px',
		sidebarGutter: '14px',
		conversationWidth: '950px',
		composerWidth: '640px',
		composerContextHeight: '28px',
		composerInputHeight: '106px',
		composerToolbarHeight: '42px',
		composerContextGap: '6px',
		controlRadius: '5px',
		legacyPanelBackground: '#252526',
	});
}

async function assertSidebarLayout(page: Page): Promise<void> {
	await assertSidebarHeaderToolbar(page);
	await assertSidebarSessionGroups(page);
	await assertSidebarFooterAndSettings(page);
}

async function assertSidebarHeaderToolbar(page: Page): Promise<void> {
	const toolbar = page.locator('.sessions-sidebar-header .monaco-toolbar');
	const actionBar = toolbar.locator('.monaco-action-bar');
	const actionItems = actionBar.locator('.actions-container > .action-item');

	await expect(toolbar).toBeVisible();
	await expect(actionBar).toBeVisible();
	await expect(actionItems).toHaveCount(3);
	await expect(actionItems.nth(0).locator('.action-label')).toContainText('New task');
	await expect(actionItems.nth(0).locator('.action-icon')).toHaveClass(/codicon-new-session/);
	await expect(actionItems.nth(0).locator('.action-icon')).not.toHaveClass(/codicon-circle-add/);
	await expect(actionItems.nth(0).locator('.keybinding')).toHaveText('⌘ N');
	await expect(actionItems.nth(1).locator('.action-label')).toContainText('Search');
	await expect(actionItems.nth(1).locator('.action-icon')).toHaveClass(/codicon-search/);
	await expect(actionItems.nth(1).locator('.keybinding')).toHaveText('⌘ K');
	await expect(actionItems.nth(2).locator('.action-label')).toContainText('Skills');
	await expect(actionItems.nth(2).locator('.action-icon')).toHaveClass(/codicon-wand/);
	await expect(page.locator('.sessions-sidebar-new-button')).toHaveCount(0);
	await expect(page.locator('.sessions-sidebar-icon-button')).toHaveCount(0);

	const toolbarMetrics = await toolbar.evaluate(element => {
		const header = element.closest('.sessions-sidebar-header');
		const sidebar = element.closest('.sessions-sidebar');
		const labels = [...element.querySelectorAll<HTMLElement>('.action-label')];
		const [newAction, searchAction, skillsAction] = labels;
		const headerRect = header?.getBoundingClientRect();
		const sidebarRect = sidebar?.getBoundingClientRect();
		const newRect = newAction?.getBoundingClientRect();
		const searchRect = searchAction?.getBoundingClientRect();
		const skillsRect = skillsAction?.getBoundingClientRect();
		const firstIcon = newAction?.querySelector<HTMLElement>('.action-icon');
		const firstText = newAction?.querySelector<HTMLElement>('.action-label-text');
		const firstKeybinding = newAction?.querySelector<HTMLElement>('.keybinding');
		const firstIconStyle = firstIcon ? getComputedStyle(firstIcon) : undefined;
		const root = document.querySelector<HTMLElement>('.agent-sessions-workbench');
		const rootStyle = root ? getComputedStyle(root) : undefined;
		return {
			headerHeight: header instanceof HTMLElement ? Math.round(header.getBoundingClientRect().height) : 0,
			sidebarGutter: rootStyle?.getPropertyValue('--vscode-agents-size-sidebar-gutter').trim() ?? '',
			headerTopToSidebar: sidebarRect && headerRect ? Math.round(headerRect.top - sidebarRect.top) : 0,
			headerLeftInset: headerRect && newRect ? Math.round(newRect.left - headerRect.left) : 0,
			headerRightInset: headerRect && newRect ? Math.round(headerRect.right - newRect.right) : 0,
			headerLeftToSidebar: sidebarRect && newRect ? Math.round(newRect.left - sidebarRect.left) : 0,
			headerRightToSidebar: sidebarRect && newRect ? Math.round(sidebarRect.right - newRect.right) : 0,
			newHeight: newRect ? Math.round(newRect.height) : 0,
			newWidth: newRect ? Math.round(newRect.width) : 0,
			searchWidth: searchRect ? Math.round(searchRect.width) : 0,
			searchHeight: searchRect ? Math.round(searchRect.height) : 0,
			skillsWidth: skillsRect ? Math.round(skillsRect.width) : 0,
			skillsHeight: skillsRect ? Math.round(skillsRect.height) : 0,
			gapAfterNew: newRect && searchRect ? Math.round(searchRect.top - newRect.bottom) : 0,
			gapAfterSearch: searchRect && skillsRect ? Math.round(skillsRect.top - searchRect.bottom) : 0,
			iconLeft: newRect && firstIcon ? Math.round(firstIcon.getBoundingClientRect().left - newRect.left) : 0,
			textLeft: newRect && firstText ? Math.round(firstText.getBoundingClientRect().left - newRect.left) : 0,
			keybindingRight: newRect && firstKeybinding ? Math.round(newRect.right - firstKeybinding.getBoundingClientRect().right) : 0,
			firstIconBorderRadius: firstIconStyle?.borderRadius ?? '',
			firstIconBorderWidth: firstIconStyle?.borderTopWidth ?? '',
		};
	});

	expect(toolbarMetrics.headerHeight).toBe(172);
	expect(toolbarMetrics.sidebarGutter).toBe('14px');
	expect(toolbarMetrics.headerTopToSidebar).toBe(0);
	expect(toolbarMetrics.headerLeftInset).toBe(14);
	expect(toolbarMetrics.headerRightInset).toBe(14);
	expect(toolbarMetrics.headerLeftToSidebar).toBe(14);
	expect(toolbarMetrics.headerRightToSidebar).toBe(14);
	expect(toolbarMetrics.newHeight).toBe(30);
	expect(toolbarMetrics.newWidth).toBe(242);
	expect(toolbarMetrics.searchWidth).toBe(toolbarMetrics.newWidth);
	expect(toolbarMetrics.searchHeight).toBe(30);
	expect(toolbarMetrics.skillsWidth).toBe(toolbarMetrics.newWidth);
	expect(toolbarMetrics.skillsHeight).toBe(30);
	expect(toolbarMetrics.gapAfterNew).toBe(5);
	expect(toolbarMetrics.gapAfterSearch).toBe(5);
	expect(toolbarMetrics.iconLeft).toBe(8);
	expect(toolbarMetrics.textLeft).toBeGreaterThanOrEqual(30);
	expect(toolbarMetrics.textLeft).toBeLessThanOrEqual(34);
	expect(toolbarMetrics.keybindingRight).toBe(12);
	expect(toolbarMetrics.firstIconBorderRadius).toBe('0px');
	expect(toolbarMetrics.firstIconBorderWidth).toBe('0px');
}

async function assertSidebarSessionGroups(page: Page): Promise<void> {
	await expect(page.locator('.sessions-sidebar-view-switcher')).toHaveCount(0);
	await expect(page.locator('.sessions-sidebar-chip')).toHaveCount(0);
	await expect(page.locator('.sessions-sidebar-view-action')).toHaveCount(0);

	const pinned = page.locator('[data-session-group="pinned"]');
	const projectsSection = page.locator('[data-session-group="projects"]');
	const projects = projectsSection.locator('.sessions-project-browser');

	// Pinned and Chat sections stay hidden while empty; only Projects shows here.
	await expect(page.locator('.sessions-sidebar-tree-section')).toHaveCount(1);
	await expect(page.locator('.sessions-sidebar-tree-section > .sessions-tree-section-toggle')).toHaveText(['Projects']);
	await expect(page.locator('[data-session-group="chat"]')).toHaveCount(0);
	await expect(pinned).toHaveCount(0);
	await assertCollapsibleSidebarSection(projectsSection, 'Projects');

	await expect(projects.locator('.sessions-project-group')).toHaveCount(2);
	await expect(projects.locator('[data-project-id="obsidian"] .sessions-project-name')).toHaveText('Obsidian');
	await expect(projects.locator('[data-project-id="zcodeproject"] .sessions-project-name')).toHaveText('ZCodeProject');
	await expect(projects.locator('[data-project-id="obsidian"] .sessions-project-count')).toHaveText('1');
	await expect(projects.locator('[data-project-id="zcodeproject"] .sessions-project-count')).toHaveText('1');
	await expect(projects.locator('.sessions-project-chevron')).toHaveCount(0);
	await expect(projects.locator('.codicon-chevron-down, .codicon-chevron-right')).toHaveCount(0);
	await assertProjectListSpacingAndIconInset(projects);

	const firstProject = projects.locator('.sessions-project-group').first();
	await expect(firstProject.locator('.sessions-project-toggle')).toHaveAttribute('aria-expanded', 'true');
	await expect(firstProject.locator('.sessions-project-session-list .sessions-list-row')).toHaveCount(1);
	await expect(firstProject.locator('.sessions-list-row-title')).toHaveText('梳理下文档');
	await assertProjectTaskRowInteraction(firstProject);
	await assertPinMovesProjectTaskToPinned(page);
	await firstProject.locator('.sessions-project-toggle').click();
	await expect(firstProject.locator('.sessions-project-toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(firstProject.locator('.sessions-project-session-list')).toBeHidden();
	await firstProject.locator('.sessions-project-toggle').click();
	await expect(firstProject.locator('.sessions-project-toggle')).toHaveAttribute('aria-expanded', 'true');
	const secondProject = projects.locator('[data-project-id="zcodeproject"]');
	await expect(secondProject.locator('.sessions-project-empty')).toHaveCount(0);
	await expect(secondProject.locator('.sessions-project-session-list .sessions-list-row')).toHaveCount(1);
	await expect(secondProject.locator('.sessions-list-row-title')).toHaveText('Ship settings sidebar cleanup');
	await expect(secondProject.locator('.sessions-project-task-time')).toHaveText('3h ago');

	const sidebarMetrics = await firstProject
		.locator('.sessions-list-row')
		.first()
		.evaluate(row => {
			const title = row.querySelector('.sessions-list-row-title');
			const time = row.querySelector('.sessions-project-task-time');
			const status = row.querySelector('.sessions-list-status');
			const sidebarContent = document.querySelector('.sessions-sidebar-content');
			const sidebar = row.closest('.sessions-sidebar');
			const rect = row.getBoundingClientRect();
			const sidebarRect = sidebar?.getBoundingClientRect();
			const titleRect = title?.getBoundingClientRect();
			return {
				rowHeight: Math.round(rect.height),
				titleLeftToSidebar: sidebarRect && titleRect ? Math.round(titleRect.left - sidebarRect.left) : 0,
				titleFontSize: title ? getComputedStyle(title).fontSize : '',
				timeFontSize: time ? getComputedStyle(time).fontSize : '',
				statusDisplay: status instanceof HTMLElement ? getComputedStyle(status).display : '',
				sidebarScrollbarWidth: sidebarContent instanceof HTMLElement ? sidebarContent.offsetWidth - sidebarContent.clientWidth : -1,
			};
		});

	expect(sidebarMetrics.rowHeight).toBeGreaterThanOrEqual(30);
	expect(sidebarMetrics.rowHeight).toBeLessThanOrEqual(34);
	expect(sidebarMetrics.titleLeftToSidebar).toBeGreaterThanOrEqual(44);
	expect(sidebarMetrics.titleLeftToSidebar).toBeLessThanOrEqual(50);
	expect(sidebarMetrics.titleFontSize).toBe('13px');
	expect(sidebarMetrics.timeFontSize).toBe('12px');
	expect(sidebarMetrics.statusDisplay).toBe('none');
	expect(sidebarMetrics.sidebarScrollbarWidth).toBeLessThanOrEqual(1);
}

async function assertProjectListSpacingAndIconInset(projects: Locator): Promise<void> {
	const metrics = await projects.evaluate(browser => {
		const sidebar = browser.closest<HTMLElement>('.sessions-sidebar');
		const list = browser.querySelector<HTMLElement>('.sessions-project-list');
		const firstGroup = browser.querySelector<HTMLElement>('[data-project-id="obsidian"]');
		const secondGroup = browser.querySelector<HTMLElement>('[data-project-id="zcodeproject"]');
		const firstIcon = firstGroup?.querySelector<HTMLElement>('.sessions-project-icon');
		const firstTitle = firstGroup?.querySelector<HTMLElement>('.sessions-project-name');
		if (!sidebar || !list || !firstGroup || !secondGroup || !firstIcon || !firstTitle) {
			throw new Error('Project list spacing nodes were not found');
		}

		const sidebarRect = sidebar.getBoundingClientRect();
		const firstRect = firstGroup.getBoundingClientRect();
		const secondRect = secondGroup.getBoundingClientRect();
		const iconRect = firstIcon.getBoundingClientRect();
		const titleRect = firstTitle.getBoundingClientRect();

		return {
			projectListGap: getComputedStyle(list).gap,
			projectGroupGap: Math.round(secondRect.top - firstRect.bottom),
			projectIconLeft: Math.round(iconRect.left - sidebarRect.left),
			projectTitleLeft: Math.round(titleRect.left - sidebarRect.left),
		};
	});

	expect(metrics.projectListGap).toBe('4px');
	expect(metrics.projectGroupGap).toBeLessThanOrEqual(6);
	expect(metrics.projectIconLeft).toBe(22);
	expect(metrics.projectTitleLeft).toBe(48);
}

async function assertCollapsibleSidebarSection(section: Locator, title: string): Promise<void> {
	const toggle = section.locator('.sessions-tree-section-toggle');
	const content = section.locator('.sessions-tree-section-content');

	await expect(toggle).toHaveText(title);
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(content).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(content).toBeHidden();
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(content).toBeVisible();
}

async function assertProjectTaskRowInteraction(firstProject: Locator): Promise<void> {
	const taskRow = firstProject.locator('.sessions-project-task-row').first();
	const action = taskRow.locator('.sessions-project-task-action');
	const deleteAction = taskRow.locator('.sessions-project-task-delete');
	const time = taskRow.locator('.sessions-project-task-time');

	await expect(taskRow).toBeVisible();
	await expect(time).toHaveText('2h ago');
	await expect(action).toHaveAttribute('title', 'Archive task');
	await expect(action).toHaveAttribute('aria-label', 'Archive 梳理下文档');
	await expect(action.locator('.sessions-project-task-tooltip')).toHaveText('梳理下文档');
	await expect(deleteAction).toHaveAttribute('title', 'Delete task');
	await expect(deleteAction).toHaveAttribute('aria-label', 'Delete 梳理下文档');

	const beforeHover = await taskRow.evaluate(row => {
		const action = row.querySelector<HTMLElement>('.sessions-project-task-action');
		const pin = row.querySelector<HTMLElement>('.sessions-project-task-pin');
		const time = row.querySelector<HTMLElement>('.sessions-project-task-time');
		return {
			actionOpacity: action ? getComputedStyle(action).opacity : '',
			pinOpacity: pin ? getComputedStyle(pin).opacity : '',
			timeOpacity: time ? getComputedStyle(time).opacity : '',
		};
	});

	expect(beforeHover.actionOpacity).toBe('0');
	expect(beforeHover.pinOpacity).toBe('0');
	expect(beforeHover.timeOpacity).toBe('1');

	const rowBox = await taskRow.boundingBox();
	expect(rowBox).not.toBeNull();
	await taskRow.locator('.sessions-project-task-main').focus();
	await expect.poll(async () => taskRow.evaluate(row => getComputedStyle(row).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
	const afterHover = await taskRow.evaluate(row => {
		const action = row.querySelector<HTMLElement>('.sessions-project-task-action');
		const pin = row.querySelector<HTMLElement>('.sessions-project-task-pin');
		const time = row.querySelector<HTMLElement>('.sessions-project-task-time');
		return {
			backgroundColor: getComputedStyle(row).backgroundColor,
			actionOpacity: action ? getComputedStyle(action).opacity : '',
			pinOpacity: pin ? getComputedStyle(pin).opacity : '',
			timeOpacity: time ? getComputedStyle(time).opacity : '',
		};
	});

	expect(afterHover.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
	expect(afterHover.actionOpacity).toBe('1');
	expect(afterHover.pinOpacity).toBe('1');
	expect(afterHover.timeOpacity).toBe('0');

	const actionBox = await action.boundingBox();
	expect(actionBox).not.toBeNull();
	await action.focus();
	await expect.poll(async () => action.locator('.sessions-project-task-tooltip').evaluate(tooltip => getComputedStyle(tooltip).opacity)).toBe('1');
	const tooltipMetrics = await action.locator('.sessions-project-task-tooltip').evaluate(tooltip => ({
		opacity: getComputedStyle(tooltip).opacity,
		visibility: getComputedStyle(tooltip).visibility,
	}));
	expect(tooltipMetrics.opacity).toBe('1');
	expect(tooltipMetrics.visibility).toBe('visible');
}

async function assertPinMovesProjectTaskToPinned(page: Page): Promise<void> {
	const projects = page.locator('.sessions-project-browser');
	const pinned = page.locator('[data-session-group="pinned"]');
	const obsidian = projects.locator('[data-project-id="obsidian"]');
	const row = obsidian.locator('.sessions-project-task-row').filter({ hasText: '梳理下文档' });

	await expect(pinned).toHaveCount(0);
	await expect(row).toHaveCount(1);

	await row.hover();
	await row.locator('.sessions-project-task-pin').click();

	await expect(pinned).toBeVisible();
	await expect(pinned.locator('.sessions-project-task-row')).toHaveCount(1);
	await expect(pinned.locator('.sessions-project-task-title')).toHaveText('梳理下文档');
	await expect(obsidian.locator('.sessions-project-task-row')).toHaveCount(0);
	await expect(obsidian.locator('.sessions-project-empty')).toHaveText('No tasks yet');
	await assertSidebarListTitleAlignment(page);

	await pinned.locator('.sessions-project-task-row').hover();
	await pinned.locator('.sessions-project-task-pin').click();

	await expect(pinned).toHaveCount(0);
	await expect(obsidian.locator('.sessions-project-task-row')).toHaveCount(1);
	await expect(obsidian.locator('.sessions-project-empty')).toHaveCount(0);
}

async function assertSidebarListTitleAlignment(page: Page): Promise<void> {
	const metrics = await page.locator('.sessions-sidebar').evaluate(sidebar => {
		const sidebarRect = sidebar.getBoundingClientRect();
		const titleOffsetToken = getComputedStyle(sidebar).getPropertyValue('--vscode-agents-size-sidebar-listTitleOffset').trim();
		const left = (selector: string): number => {
			const element = document.querySelector<HTMLElement>(selector);
			if (!element) {
				throw new Error(`Missing sidebar alignment selector: ${selector}`);
			}

			return Math.round(element.getBoundingClientRect().left - sidebarRect.left);
		};

		return {
			titleOffsetToken,
			pinnedTitleLeft: left('[data-session-group="pinned"] .sessions-project-task-title'),
			obsidianNameLeft: left('[data-project-id="obsidian"] .sessions-project-name'),
			obsidianEmptyLeft: left('[data-project-id="obsidian"] .sessions-project-empty'),
			zcodeNameLeft: left('[data-project-id="zcodeproject"] .sessions-project-name'),
			zcodeTaskTitleLeft: left('[data-project-id="zcodeproject"] .sessions-project-task-title'),
		};
	});

	expect(metrics.titleOffsetToken).toBe('48px');
	expect(metrics.pinnedTitleLeft).toBe(48);
	expect(metrics.obsidianNameLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.obsidianEmptyLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.zcodeNameLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.zcodeTaskTitleLeft).toBe(metrics.pinnedTitleLeft);
}

async function assertSidebarFooterAndSettings(page: Page): Promise<void> {
	const footer = page.locator('.sessions-sidebar-footer');
	await expect(footer).toBeVisible();
	await expect(footer.locator('.sessions-sidebar-user-button')).toContainText('Chao Wang');
	await expect(footer.locator('.sessions-sidebar-settings-button')).toBeVisible();

	await footer.locator('.sessions-sidebar-settings-button').click();
	const dialog = page.locator('.sessions-settings-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.sessions-settings-title')).toHaveText('Agent Customizations for Copilot CLI');
	await expect(dialog.locator('[data-settings-nav-id="mcp-servers"]')).toHaveClass(/active/);
	await assertSettingsDialogThemeTokens(page);
	await expect(dialog.locator('.sessions-settings-main h2')).toHaveText('MCP Servers');
	await expect(dialog.locator('.sessions-settings-search')).toHaveAttribute('placeholder', 'Type to search...');
	await expect(dialog.locator('.sessions-settings-marketplace')).toContainText('Browse Marketplace');
	await expect(dialog.locator('[data-settings-group="workspace"] .sessions-settings-group-title')).toContainText('Workspace');
	await expect(dialog.locator('[data-settings-group="user"] .sessions-settings-group-title')).toContainText('User');
	await expect(dialog.locator('[data-settings-group="builtin"] .sessions-settings-group-title')).toContainText('Built-In');
	await dialog.locator('.sessions-settings-close').click();
	await expect(dialog).toBeHidden();
}

async function assertSettingsDialogThemeTokens(page: Page): Promise<void> {
	const metrics = await page.locator('.sessions-settings-dialog').evaluate(dialog => {
		function normalizeColor(value: string): string {
			const probe = document.createElement('span');
			probe.style.color = value;
			document.body.appendChild(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		}

		const root = document.querySelector<HTMLElement>('.agent-sessions-workbench');
		const backdrop = dialog.closest<HTMLElement>('.sessions-settings-dialog-backdrop');
		const search = dialog.querySelector<HTMLElement>('.sessions-settings-search');
		const nav = dialog.querySelector<HTMLElement>('.sessions-settings-nav');
		const content = dialog.querySelector<HTMLElement>('.sessions-settings-main-content');

		if (!root || !backdrop || !search || !nav || !content) {
			throw new Error('Settings dialog theme nodes were not found');
		}

		const rootStyle = getComputedStyle(root);
		const dialogStyle = getComputedStyle(dialog);
		const backdropStyle = getComputedStyle(backdrop);
		const searchStyle = getComputedStyle(search);
		const navStyle = getComputedStyle(nav);
		const contentStyle = getComputedStyle(content);

		return {
			theme: root.dataset['agentsTheme'],
			dialogBackground: dialogStyle.backgroundColor,
			dialogBackgroundToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-modal-background').trim()),
			dialogColor: dialogStyle.color,
			dialogColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-text-primary').trim()),
			dialogBorderColor: dialogStyle.borderColor,
			dialogBorderColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-panel-border').trim()),
			backdropBackground: backdropStyle.backgroundColor,
			backdropBackgroundToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-scrim').trim()),
			searchBackground: searchStyle.backgroundColor,
			searchBackgroundToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-input-background').trim()),
			searchOutlineColor: searchStyle.outlineColor,
			searchOutlineColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-focusBorder').trim()),
			navBorderColor: navStyle.borderRightColor,
			navBorderColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-divider').trim()),
			contentBorderColor: contentStyle.borderColor,
			contentBorderColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-panel-border').trim()),
		};
	});

	expect(metrics.theme).toBe('dark');
	expect(metrics.dialogBackground).toBe(metrics.dialogBackgroundToken);
	expect(metrics.dialogColor).toBe(metrics.dialogColorToken);
	expect(metrics.dialogBorderColor).toBe(metrics.dialogBorderColorToken);
	expect(metrics.backdropBackground).toBe(metrics.backdropBackgroundToken);
	expect(metrics.searchBackground).toBe(metrics.searchBackgroundToken);
	expect(metrics.searchOutlineColor).toBe(metrics.searchOutlineColorToken);
	expect(metrics.navBorderColor).toBe(metrics.navBorderColorToken);
	expect(metrics.contentBorderColor).toBe(metrics.contentBorderColorToken);
}

async function assertSidebarToggle(page: Page): Promise<void> {
	await page.locator('.sessions-sidebar-toggle').click();
	await expect(page.locator('.part.sidebar')).toBeHidden();
	await expect(page.locator('.sessions-titlebar-new-task')).toBeVisible();
	await expect(page.locator('.sessions-titlebar-new-task .codicon')).toHaveClass(/codicon-new-session/);
	await expect(page.locator('.sessions-titlebar-new-task .codicon')).not.toHaveClass(/codicon-circle-add/);
	const sessionsBox = await page.locator('.part.sessionspart').boundingBox();
	expect(sessionsBox).not.toBeNull();
	expect(Math.round(sessionsBox!.x)).toBe(4);
	await page.locator('.sessions-sidebar-toggle').click();
	await expect(page.locator('.part.sidebar')).toBeVisible();
	await expect(page.locator('.sessions-titlebar-new-task')).toBeHidden();
}

async function assertTitlebarControls(page: Page): Promise<void> {
	await expect(page.locator('.sessions-sidebar-toggle')).toBeVisible();
	await expect(page.locator('.sessions-titlebar-nav-action[aria-label="Back"]')).toBeVisible();
	await expect(page.locator('.sessions-titlebar-nav-action[aria-label="Forward"]')).toBeVisible();
	await expect(page.locator('.sessions-titlebar-new-task')).toBeHidden();
	await expect(page.locator('.sessions-titlebar-help')).toBeVisible();

	const isDarwin = await page.locator('.agent-sessions-workbench.platform-darwin').count();
	if (!isDarwin) {
		return;
	}

	const toggleBox = await page.locator('.sessions-sidebar-toggle').boundingBox();
	expect(toggleBox).not.toBeNull();
	expect(toggleBox!.x).toBeGreaterThan(94);
	expect(Math.round(toggleBox!.y)).toBe(7);
	expect(Math.round(toggleBox!.height)).toBe(22);

	const centers = await page.locator('.titlebar-left .sessions-titlebar-nav-action').evaluateAll(nodes =>
		nodes
			.filter(node => getComputedStyle(node).display !== 'none')
			.map(node => {
				const rect = node.getBoundingClientRect();
				return Math.round(rect.y + rect.height / 2);
			}),
	);
	expect(new Set(centers)).toEqual(new Set([18]));
}

async function assertRunningConversationShell(page: Page): Promise<void> {
	await expect(page.locator('.sessions-new-session-view')).toBeHidden();
	await expect(page.locator('.session-view')).toBeVisible();
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();

	const activeRow = page.locator('.sessions-project-task-row.active').filter({ hasText: 'hello' });
	await expect(activeRow).toBeVisible();
	await expect(activeRow.locator('.sessions-project-task-title')).toHaveText('hello');
	await expect(activeRow.locator('.sessions-project-task-time')).toHaveText('just now');
	await expect(activeRow.locator('.sessions-project-task-spinner')).toBeVisible();
	await expect(activeRow.locator('.sessions-project-task-pin')).toHaveCount(1);
	await expect(activeRow.locator('.sessions-project-task-action')).toHaveCount(1);
	await expect(activeRow.locator('.sessions-project-task-delete')).toHaveCount(1);

	await expect(page.locator('.conversation-context-title')).toHaveText('hello');
	await expect(page.locator('.conversation-context-workspace').first()).toContainText('No workspace');
	await expect(page.locator('.conversation-context-branch')).toContainText('main');
	await expect(page.locator('.conversation-context-more')).toBeVisible();
	await expect(page.locator('.conversation-composer > .conversation-context-bar')).toHaveCount(1);
	await expect(page.locator('.conversation-transcript > .conversation-context-bar')).toHaveCount(0);
	await expect(page.locator('.session-view > .conversation-context-bar')).toHaveCount(0);
	await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/mode-conversation/);
	await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).not.toHaveClass(/mode-session-detail/);
	await expect(page.locator('.chat-view, [class*="chat-view-"]')).toHaveCount(0);

	const headerPosition = await page.locator('.conversation-composer').evaluate(composer => {
		const header = composer.querySelector('.conversation-context');
		const inputWrap = composer.querySelector('.conversation-input-wrap');
		const composerRect = composer.getBoundingClientRect();
		const headerRect = header?.getBoundingClientRect();
		const inputWrapRect = inputWrap?.getBoundingClientRect();
		const headerStyle = header ? getComputedStyle(header) : undefined;
		const root = document.querySelector<HTMLElement>('.agent-sessions-workbench');
		const rootStyle = root ? getComputedStyle(root) : undefined;

		return {
			state: (composer as HTMLElement).dataset['state'],
			headerInsideComposer: header?.parentElement?.parentElement === composer,
			headerTop: headerRect ? Math.round(headerRect.top - composerRect.top) : null,
			headerBottom: headerRect ? Math.round(headerRect.bottom - composerRect.top) : null,
			headerLeft: headerRect ? Math.round(headerRect.left) : null,
			headerRight: headerRect ? Math.round(headerRect.right) : null,
			headerWidth: headerRect ? Math.round(headerRect.width) : null,
			headerHeight: headerRect ? Math.round(headerRect.height) : null,
			inputWrapTop: inputWrapRect ? Math.round(inputWrapRect.top - composerRect.top) : null,
			inputWrapLeft: inputWrapRect ? Math.round(inputWrapRect.left) : null,
			inputWrapRight: inputWrapRect ? Math.round(inputWrapRect.right) : null,
			inputWrapWidth: inputWrapRect ? Math.round(inputWrapRect.width) : null,
			inputWrapHeight: inputWrapRect ? Math.round(inputWrapRect.height) : null,
			borderBottomWidth: headerStyle?.borderBottomWidth,
			composerWidthToken: rootStyle?.getPropertyValue('--vscode-agents-size-composer-width').trim() ?? '',
			contextHeightToken: rootStyle?.getPropertyValue('--vscode-agents-size-composer-contextHeight').trim() ?? '',
			inputHeightToken: rootStyle?.getPropertyValue('--vscode-agents-size-composer-inputHeight').trim() ?? '',
			contextGapToken: rootStyle?.getPropertyValue('--vscode-agents-space-composer-contextGap').trim() ?? '',
		};
	});
	expect(headerPosition.state).toBe('running');
	expect(headerPosition.headerInsideComposer).toBe(true);
	expect(headerPosition.headerTop).not.toBeNull();
	expect(headerPosition.headerBottom).not.toBeNull();
	expect(headerPosition.inputWrapTop).not.toBeNull();
	expect(headerPosition.headerWidth).not.toBeNull();
	expect(headerPosition.inputWrapWidth).not.toBeNull();
	expect(headerPosition.headerTop!).toBeLessThan(headerPosition.inputWrapTop!);
	expect(headerPosition.inputWrapTop! - headerPosition.headerBottom!).toBe(6);
	expect(headerPosition.headerLeft).toBe(headerPosition.inputWrapLeft);
	expect(headerPosition.headerRight).toBe(headerPosition.inputWrapRight);
	expect(headerPosition.headerWidth).toBe(headerPosition.inputWrapWidth);
	expect(headerPosition.headerHeight).toBe(28);
	expect(headerPosition.inputWrapHeight).toBe(106);
	expect(headerPosition.composerWidthToken).toBe('640px');
	expect(headerPosition.contextHeightToken).toBe('28px');
	expect(headerPosition.inputHeightToken).toBe('106px');
	expect(headerPosition.contextGapToken).toBe('6px');
	expect(headerPosition.borderBottomWidth).toBe('0px');

	await expect(page.locator('.conversation-message.user .conversation-message-bubble')).toHaveText('hello');
	await expect(page.locator('.conversation-working-label')).toHaveText(/Working for \d+s|Working for \d+m \d+s/);
	await expect(page.locator('.conversation-thinking-row')).toContainText('Thinking');
	await assertRunningConversationMessageLayout(page);

	const composer = page.locator('.conversation-composer.running');
	await expect(composer).toBeVisible();
	await expect(composer.locator('.conversation-input')).toHaveAttribute('placeholder', 'Keep typing to queue follow-up changes');
	await expect(composer.locator('.conversation-access')).toContainText('Full access');
	await expect(composer.locator('.conversation-model')).toContainText('GLM-5.2');
	await expect(composer.locator('.conversation-agent')).toContainText('Max');
	await expect(composer.locator('.conversation-reconnect-status')).toContainText(/Reconnecting\.\.\. \d+\/10/);
	await expect(composer.locator('.conversation-stop-button')).toBeVisible();
	await assertConversationToolbarInteraction(composer);
}

async function assertConversationToolbarInteraction(composer: Locator): Promise<void> {
	const metrics = await composer.evaluate(element => {
		const controls = [
			'.conversation-access',
			'.conversation-reconnect-status',
			'.conversation-model',
			'.conversation-agent',
			'.conversation-stop-button',
			'.conversation-send-button',
		] as const;
		const read = (selector: string) => {
			const node = element.querySelector<HTMLElement>(selector);
			if (!node) {
				throw new Error(`Missing composer control: ${selector}`);
			}

			const rect = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			return {
				display: style.display,
				hidden: node.hidden,
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				backgroundColor: style.backgroundColor,
				borderRadius: style.borderRadius,
			};
		};

		return {
			toolbarHeight: Math.round(element.querySelector<HTMLElement>('.conversation-composer-toolbar')?.getBoundingClientRect().height ?? 0),
			controls: Object.fromEntries(controls.map(selector => [selector, read(selector)])),
			leftGap: getComputedStyle(element.querySelector<HTMLElement>('.conversation-toolbar-left')!).gap,
			rightGap: getComputedStyle(element.querySelector<HTMLElement>('.conversation-toolbar-right')!).gap,
		};
	});

	expect(metrics.toolbarHeight).toBe(42);
	expect(metrics.leftGap).toBe('4px');
	expect(metrics.rightGap).toBe('4px');
	const control = (selector: string) => metrics.controls[selector]!;
	expect(control('.conversation-access').height).toBe(28);
	expect(control('.conversation-reconnect-status').height).toBe(28);
	expect(control('.conversation-model').height).toBe(28);
	expect(control('.conversation-agent').height).toBe(28);
	expect(control('.conversation-stop-button').width).toBe(28);
	expect(control('.conversation-stop-button').height).toBe(28);
	expect(control('.conversation-send-button').hidden).toBe(true);
	expect(control('.conversation-send-button').width).toBe(0);
	expect(control('.conversation-access').borderRadius).toBe('5px');

	const access = composer.locator('.conversation-access');
	const beforeHover = await access.evaluate(node => getComputedStyle(node).backgroundColor);
	const accessBox = await access.boundingBox();
	expect(accessBox).not.toBeNull();
	await composer.page().mouse.move(0, 0);
	await composer.page().mouse.move(accessBox!.x + accessBox!.width / 2, accessBox!.y + accessBox!.height / 2);
	expect(beforeHover).toBe('rgba(0, 0, 0, 0)');
	await expect.poll(async () => access.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(beforeHover);
}

async function assertRunningConversationMessageLayout(page: Page): Promise<void> {
	const metrics = await page.locator('.conversation-view').evaluate(view => {
		const inputWrap = document.querySelector<HTMLElement>('.conversation-input-wrap');
		const userBubble = view.querySelector<HTMLElement>('.conversation-message.user .conversation-message-bubble');
		const workingRow = view.querySelector<HTMLElement>('.conversation-working-row');
		const workingLabel = view.querySelector<HTMLElement>('.conversation-working-label');
		const thinkingRow = view.querySelector<HTMLElement>('.conversation-thinking-row');
		const thinkingSpinner = thinkingRow?.querySelector<HTMLElement>('.codicon-loading');
		const thinkingLabel = thinkingRow?.querySelector<HTMLElement>('span:last-child');
		if (!inputWrap || !userBubble || !workingRow || !workingLabel || !thinkingRow || !thinkingSpinner || !thinkingLabel) {
			throw new Error('Running conversation layout nodes were not found');
		}

		const inputRect = inputWrap.getBoundingClientRect();
		const userBubbleRect = userBubble.getBoundingClientRect();
		const workingRowRect = workingRow.getBoundingClientRect();
		const workingLabelRect = workingLabel.getBoundingClientRect();
		const thinkingSpinnerRect = thinkingSpinner.getBoundingClientRect();
		const thinkingLabelRect = thinkingLabel.getBoundingClientRect();
		return {
			status: (view as HTMLElement).dataset['status'],
			interactivity: (view as HTMLElement).dataset['interactivity'],
			userRole: userBubble.closest<HTMLElement>('.conversation-message')?.dataset['role'],
			userBubbleRight: Math.round(userBubbleRect.right),
			inputRight: Math.round(inputRect.right),
			messageColumnRight: Math.round(workingRowRect.right),
			workingLabelLeft: Math.round(workingLabelRect.left),
			thinkingLabelLeft: Math.round(thinkingLabelRect.left),
			thinkingSpinnerLeft: Math.round(thinkingSpinnerRect.left),
		};
	});

	expect(metrics.status).toBe('in-progress');
	expect(metrics.interactivity).toBe('full');
	expect(metrics.userRole).toBe('user');
	// User bubble right-aligns to the message column (wider than the composer).
	expect(metrics.userBubbleRight).toBe(metrics.messageColumnRight);
	expect(metrics.userBubbleRight).toBeGreaterThan(metrics.inputRight);
	expect(metrics.workingLabelLeft).toBe(metrics.thinkingLabelLeft);
	expect(metrics.thinkingSpinnerLeft).toBeLessThan(metrics.thinkingLabelLeft);
}

async function assertHistoricalConversationMessageLayout(page: Page, expectedStatus: string, expectedInteractivity: string, expectRunningRows: boolean): Promise<void> {
	const metrics = await page.locator('.conversation-view').evaluate(view => {
		const inputWrap = document.querySelector<HTMLElement>('.conversation-input-wrap');
		const rows = [...view.querySelectorAll<HTMLElement>('.conversation-message')];
		const read = (role: string) => {
			const row = rows.find(candidate => candidate.dataset['role'] === role);
			if (!row) {
				throw new Error(`Missing ${role} message row`);
			}

			const avatar = row.querySelector<HTMLElement>('.conversation-message-avatar');
			const body = row.querySelector<HTMLElement>('.conversation-message-body');
			const bubble = row.querySelector<HTMLElement>('.conversation-message-bubble');
			const text = row.querySelector<HTMLElement>('.conversation-message-text');
			const detail = row.querySelector<HTMLElement>('.conversation-tool-detail');
			const rowRect = row.getBoundingClientRect();
			const avatarRect = avatar?.getBoundingClientRect();
			const bodyRect = body?.getBoundingClientRect();
			const bubbleRect = bubble?.getBoundingClientRect();
			const textRect = text?.getBoundingClientRect();
			const detailRect = detail?.getBoundingClientRect();
			return {
				role: row.dataset['role'],
				rowLeft: Math.round(rowRect.left),
				rowRight: Math.round(rowRect.right),
				avatarLeft: avatarRect ? Math.round(avatarRect.left) : null,
				avatarCenter: avatarRect ? Math.round(avatarRect.left + avatarRect.width / 2) : null,
				bodyLeft: bodyRect ? Math.round(bodyRect.left) : null,
				bubbleRight: bubbleRect ? Math.round(bubbleRect.right) : null,
				textLeft: textRect ? Math.round(textRect.left) : null,
				detailLeft: detailRect ? Math.round(detailRect.left) : null,
			};
		};

		const inputRect = inputWrap?.getBoundingClientRect();
		const workingLabel = view.querySelector<HTMLElement>('.conversation-working-label');
		const thinkingRow = view.querySelector<HTMLElement>('.conversation-thinking-row');
		const thinkingSpinner = thinkingRow?.querySelector<HTMLElement>('.codicon-loading');
		const thinkingLabel = thinkingRow?.querySelector<HTMLElement>('span:last-child');
		return {
			status: (view as HTMLElement).dataset['status'],
			interactivity: (view as HTMLElement).dataset['interactivity'],
			roles: rows.map(row => row.dataset['role']),
			inputRight: inputRect ? Math.round(inputRect.right) : null,
			user: read('user'),
			assistant: read('assistant'),
			tool: read('tool'),
			workingLabelLeft: workingLabel ? Math.round(workingLabel.getBoundingClientRect().left) : null,
			thinkingSpinnerLeft: thinkingSpinner ? Math.round(thinkingSpinner.getBoundingClientRect().left) : null,
			thinkingSpinnerCenter: thinkingSpinner ? Math.round(thinkingSpinner.getBoundingClientRect().left + thinkingSpinner.getBoundingClientRect().width / 2) : null,
			thinkingLabelLeft: thinkingLabel ? Math.round(thinkingLabel.getBoundingClientRect().left) : null,
		};
	});

	expect(metrics.status).toBe(expectedStatus);
	expect(metrics.interactivity).toBe(expectedInteractivity);
	expect(metrics.roles).toEqual(['user', 'assistant', 'tool']);
	// User bubble right-aligns to the message column (same right edge as the assistant row), not the narrower composer.
	expect(metrics.user.rowRight).toBe(metrics.assistant.rowRight);
	expect(metrics.user.bubbleRight).toBe(metrics.user.rowRight);
	expect(metrics.assistant.bodyLeft).toBe(metrics.tool.bodyLeft);
	expect(metrics.assistant.textLeft).toBe(metrics.assistant.bodyLeft);
	expect(metrics.tool.textLeft).toBe(metrics.tool.bodyLeft);
	expect(metrics.tool.detailLeft).toBe(metrics.tool.bodyLeft);
	if (expectRunningRows) {
		expect(metrics.workingLabelLeft).toBe(metrics.assistant.bodyLeft);
		expect(metrics.thinkingLabelLeft).toBe(metrics.assistant.bodyLeft);
		expect(metrics.thinkingSpinnerCenter).toBe(metrics.assistant.avatarCenter);
	} else {
		expect(metrics.workingLabelLeft).toBeNull();
		expect(metrics.thinkingLabelLeft).toBeNull();
		expect(metrics.thinkingSpinnerCenter).toBeNull();
	}
}

async function assertRightSidePaneInteraction(page: Page): Promise<void> {
	const toggle = page.locator('.sessions-titlebar-side-pane-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle.locator('.codicon')).toHaveClass(/codicon-layout-sidebar-right/);

	await toggle.click();
	await expect(page.locator('.part.auxiliarybar')).toBeVisible();
	await expect(toggle).toHaveClass(/active/);
	await expect(page.locator('.auxiliary-empty-title')).toHaveText('Open tab');
	await expect(page.locator('.auxiliary-empty-description')).toHaveText('Choose a tab to open in the side pane.');
	await expect(page.locator('.auxiliary-empty-card')).toHaveText(['Review', 'Terminal', 'Browser']);
	await expect(page.locator('.auxiliary-tabs')).toHaveCount(0);

	await page.locator('.auxiliary-empty-card').filter({ hasText: 'Review' }).click();
	await assertSidePaneTab(page, 'review', 'Review');
	const changesView = page.locator('.auxiliary-view[data-tab-id="review"] .changes-view');
	await expect(changesView).toBeVisible();
	await expect(changesView.locator('.changes-view-subtitle')).toHaveText('hello');
	await expect(changesView.locator('.changes-summary-stat.files .changes-summary-value')).toHaveText('5');

	await expect(page.locator('.monaco-workbench.agent-sessions-workbench')).toHaveClass(/side-pane-open/);
	await assertSidePaneDockedToStage(page);
	await page.screenshot({ path: 'test-results/agents-window-side-pane.png', fullPage: true });

	await page.locator('.auxiliary-tab[data-tab-id="terminal"]').click();
	await assertSidePaneTab(page, 'terminal', 'Terminal', 'No terminal session started');

	await page.locator('.auxiliary-tab[data-tab-id="browser"]').click();
	await assertSidePaneTab(page, 'browser', 'Browser', 'No browser preview open');

	await toggle.click();
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();
	await expect(toggle).not.toHaveClass(/active/);
}

async function assertSidePaneDockedToStage(page: Page): Promise<void> {
	const geometry = await page.evaluate(() => {
		const stage = document.querySelector('.part.sessionspart');
		const aux = document.querySelector('.part.auxiliarybar');
		if (!stage || !aux) {
			return undefined;
		}

		const stageRect = stage.getBoundingClientRect();
		const auxRect = aux.getBoundingClientRect();
		return {
			stageRight: Math.round(stageRect.right),
			auxLeft: Math.round(auxRect.left),
			stageTop: Math.round(stageRect.top),
			auxTop: Math.round(auxRect.top),
			stageBottom: Math.round(stageRect.bottom),
			auxBottom: Math.round(auxRect.bottom),
		};
	});

	expect(geometry).toBeDefined();
	// Flush at the seam (single divider) and aligned top/bottom (one shared frame).
	expect(Math.abs(geometry!.stageRight - geometry!.auxLeft)).toBeLessThanOrEqual(1);
	expect(Math.abs(geometry!.stageTop - geometry!.auxTop)).toBeLessThanOrEqual(1);
	expect(Math.abs(geometry!.stageBottom - geometry!.auxBottom)).toBeLessThanOrEqual(1);
}

async function assertSidePaneTab(page: Page, tabId: string, title: string, bodyText?: string): Promise<void> {
	const root = page.locator('.auxiliary-bar');
	await expect(root).toBeVisible();
	await expect(root).not.toHaveClass(/auxiliary-empty/);
	await expect(page.locator('.auxiliary-empty-content')).toHaveCount(0);
	await expect(page.locator('.auxiliary-tabs')).toBeVisible();
	await expect(page.locator('.auxiliary-tab')).toHaveText(['Review', 'Terminal', 'Browser']);

	const activeTab = page.locator(`.auxiliary-tab[data-tab-id="${tabId}"]`);
	await expect(activeTab).toHaveAttribute('aria-selected', 'true');
	await expect(activeTab).toHaveClass(/active/);
	await expect(page.locator(`.auxiliary-view[data-tab-id="${tabId}"]`)).toBeVisible();
	await expect(page.locator(`.auxiliary-view[data-tab-id="${tabId}"] .auxiliary-view-title`)).toHaveText(title);
	if (bodyText !== undefined) {
		await expect(page.locator(`.auxiliary-view[data-tab-id="${tabId}"] .auxiliary-view-body`)).toContainText(bodyText);
	}
}
