/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';

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

		await assertSidebarToggle(page);

		await page.locator('.sessions-list-row').first().click();
		await expect(page.locator('.session-view')).toBeVisible();
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
		app = await electron.launch({ args: ['dist/main/main.js'] });
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
		await assertRightSidePaneInteraction(page);
		await page.screenshot({ path: 'test-results/agents-window-running-session.png', fullPage: true });

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
		app = await electron.launch({ args: ['dist/main/main.js'] });
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

test('empty new-session submit keeps focus in the landing composer', async () => {
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

	await assertThemeTokens(page);
	await assertShellLayout(page, screenshot.width, screenshot.height);
	await assertTitlebarControls(page);
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();
	await expect(page.locator('.sessions-command-center')).toHaveCount(0);
	await assertSidebarLayout(page);
	await expect(page.locator('.new-session-watermark')).toBeVisible();
	await expect(page.locator('.new-session-watermark')).toHaveText('');
	await expect(page.locator('.new-session-heading')).toHaveText('Morning, how can I help?');
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

	await page.mouse.move(screenshot.width - 4, screenshot.height - 4);
	await page.screenshot({ path: screenshot.path, fullPage: true });
}

async function assertShellLayout(page: Page, width: number, height: number): Promise<void> {
	const metrics = await page.locator('.monaco-workbench.agent-sessions-workbench').evaluate((root, viewport) => {
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
			stageBackgroundToken: normalizeColor(style.getPropertyValue('--vscode-agents-color-stage-background').trim())
		};

		function normalizeColor(value: string): string {
			const probe = document.createElement('span');
			probe.style.color = value;
			document.body.appendChild(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		}
	}, { width, height });

	expect(metrics.sidebarWidthToken).toBe('270px');
	expect(metrics.stageMarginToken).toBe('4px');
	expect(metrics.sidebarX).toBe(0);
	expect(metrics.sidebarY).toBe(0);
	expect(metrics.sidebarWidth).toBe(270);
	expect(metrics.sidebarHeight).toBe(height);
	expect(metrics.stageX).toBe(270);
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
				controlRadius: styles.getPropertyValue('--vscode-agents-radius-control').trim(),
				legacyPanelBackground: styles.getPropertyValue('--vscode-agentsPanel-background').trim()
		};
	});

	expect(themeTokens).toEqual({
		theme: 'dark',
		panelBackground: '#252526',
		sidebarBackground: '#24343a',
		stageBackground: '#111111',
		textPrimary: '#cccccc',
		focusBorder: '#0078d4',
			titlebarHeight: '52px',
			sidebarWidth: '270px',
			sidebarGutter: '14px',
			conversationWidth: '950px',
			composerWidth: '640px',
			controlRadius: '5px',
			legacyPanelBackground: '#252526'
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
			firstIconBorderWidth: firstIconStyle?.borderTopWidth ?? ''
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

	await expect(page.locator('.sessions-sidebar-tree-section')).toHaveCount(2);
	await expect(page.locator('.sessions-sidebar-tree-section > .sessions-tree-section-toggle')).toHaveText(['Pinned', 'Projects']);
	await expect(page.locator('[data-session-group="chats"]')).toHaveCount(0);
	await expect(pinned.locator('.sessions-list-empty')).toHaveText('No pinned items');
	await assertCollapsibleSidebarSection(pinned, 'Pinned');
	await assertCollapsibleSidebarSection(projectsSection, 'Projects');

	await expect(projects.locator('.sessions-project-group')).toHaveCount(2);
	await expect(projects.locator('[data-project-id="obsidian"] .sessions-project-name')).toHaveText('Obsidian');
	await expect(projects.locator('[data-project-id="zcodeproject"] .sessions-project-name')).toHaveText('ZCodeProject');
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
	await expect(projects.locator('[data-project-id="zcodeproject"] .sessions-project-empty')).toHaveText('No tasks yet');

	const sidebarMetrics = await firstProject.locator('.sessions-list-row').first().evaluate(row => {
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
			sidebarScrollbarWidth: sidebarContent instanceof HTMLElement ? sidebarContent.offsetWidth - sidebarContent.clientWidth : -1
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
			projectTitleLeft: Math.round(titleRect.left - sidebarRect.left)
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
	const pin = taskRow.locator('.sessions-project-task-pin');
	const time = taskRow.locator('.sessions-project-task-time');

	await expect(taskRow).toBeVisible();
	await expect(time).toHaveText('2h');
	await expect(action).toHaveAttribute('title', 'Archive task');
	await expect(action).toHaveAttribute('aria-label', 'Archive 梳理下文档');
	await expect(action.locator('.sessions-project-task-tooltip')).toHaveText('梳理下文档');

	const beforeHover = await taskRow.evaluate(row => {
		const action = row.querySelector<HTMLElement>('.sessions-project-task-action');
		const pin = row.querySelector<HTMLElement>('.sessions-project-task-pin');
		const time = row.querySelector<HTMLElement>('.sessions-project-task-time');
		return {
			actionOpacity: action ? getComputedStyle(action).opacity : '',
			pinOpacity: pin ? getComputedStyle(pin).opacity : '',
			timeOpacity: time ? getComputedStyle(time).opacity : ''
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
			timeOpacity: time ? getComputedStyle(time).opacity : ''
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
		visibility: getComputedStyle(tooltip).visibility
	}));
	expect(tooltipMetrics.opacity).toBe('1');
	expect(tooltipMetrics.visibility).toBe('visible');
}

async function assertPinMovesProjectTaskToPinned(page: Page): Promise<void> {
	const projects = page.locator('.sessions-project-browser');
	const pinned = page.locator('[data-session-group="pinned"]');
	const obsidian = projects.locator('[data-project-id="obsidian"]');
	const row = obsidian.locator('.sessions-project-task-row').filter({ hasText: '梳理下文档' });

	await expect(pinned).toBeVisible();
	await expect(pinned.locator('.sessions-list-empty')).toHaveText('No pinned items');
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

	await expect(pinned.locator('.sessions-project-task-row')).toHaveCount(0);
	await expect(pinned.locator('.sessions-list-empty')).toHaveText('No pinned items');
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
			zcodeEmptyLeft: left('[data-project-id="zcodeproject"] .sessions-project-empty')
		};
	});

	expect(metrics.titleOffsetToken).toBe('48px');
	expect(metrics.pinnedTitleLeft).toBe(48);
	expect(metrics.obsidianNameLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.obsidianEmptyLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.zcodeNameLeft).toBe(metrics.pinnedTitleLeft);
	expect(metrics.zcodeEmptyLeft).toBe(metrics.pinnedTitleLeft);
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
			contentBorderColorToken: normalizeColor(rootStyle.getPropertyValue('--vscode-agents-color-panel-border').trim())
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
			})
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
	await expect(activeRow.locator('.sessions-project-task-time')).toHaveText('now');
	await expect(activeRow.locator('.sessions-project-task-spinner')).toBeVisible();
	await expect(activeRow.locator('.sessions-project-task-pin')).toHaveCount(0);
	await expect(activeRow.locator('.sessions-project-task-action')).toHaveCount(0);

	await expect(page.locator('.conversation-context-title')).toHaveText('hello');
	await expect(page.locator('.conversation-context-workspace').first()).toContainText('mellivora-malatang');
	await expect(page.locator('.conversation-context-branch')).toContainText('codex/agents-window-rebuild');
	await expect(page.locator('.conversation-context-more')).toBeVisible();
	await expect(page.locator('.conversation-composer > .conversation-context-bar')).toHaveCount(1);
	await expect(page.locator('.conversation-transcript > .conversation-context-bar')).toHaveCount(0);
	await expect(page.locator('.session-view > .conversation-context-bar')).toHaveCount(0);
	await expect(page.locator('.chat-view, [class*="chat-view-"]')).toHaveCount(0);

	const headerPosition = await page.locator('.conversation-composer').evaluate(composer => {
		const header = composer.querySelector('.conversation-context');
		const inputWrap = composer.querySelector('.conversation-input-wrap');
		const composerRect = composer.getBoundingClientRect();
		const headerRect = header?.getBoundingClientRect();
		const inputWrapRect = inputWrap?.getBoundingClientRect();
		const headerStyle = header ? getComputedStyle(header) : undefined;

		return {
			headerInsideComposer: header?.parentElement?.parentElement === composer,
			headerTop: headerRect ? Math.round(headerRect.top - composerRect.top) : null,
			headerBottom: headerRect ? Math.round(headerRect.bottom - composerRect.top) : null,
			headerWidth: headerRect ? Math.round(headerRect.width) : null,
			inputWrapTop: inputWrapRect ? Math.round(inputWrapRect.top - composerRect.top) : null,
			inputWrapWidth: inputWrapRect ? Math.round(inputWrapRect.width) : null,
			borderBottomWidth: headerStyle?.borderBottomWidth
		};
	});
	expect(headerPosition.headerInsideComposer).toBe(true);
	expect(headerPosition.headerTop).not.toBeNull();
	expect(headerPosition.headerBottom).not.toBeNull();
	expect(headerPosition.inputWrapTop).not.toBeNull();
	expect(headerPosition.headerWidth).not.toBeNull();
	expect(headerPosition.inputWrapWidth).not.toBeNull();
	expect(headerPosition.headerTop!).toBeLessThan(headerPosition.inputWrapTop!);
	expect(headerPosition.inputWrapTop! - headerPosition.headerBottom!).toBeLessThanOrEqual(8);
	expect(headerPosition.headerWidth!).toBeLessThanOrEqual(headerPosition.inputWrapWidth! + 2);
	expect(headerPosition.borderBottomWidth).toBe('0px');

	await expect(page.locator('.conversation-message.user .conversation-message-bubble')).toHaveText('hello');
	await expect(page.locator('.conversation-working-label')).toHaveText(/Working for \d+s|Working for \d+m \d+s/);
	await expect(page.locator('.conversation-thinking-row')).toContainText('Thinking');

	const composer = page.locator('.conversation-composer.running');
	await expect(composer).toBeVisible();
	await expect(composer.locator('.conversation-input')).toHaveAttribute('placeholder', 'Keep typing to queue follow-up changes');
	await expect(composer.locator('.conversation-access')).toContainText('Full access');
	await expect(composer.locator('.conversation-model')).toContainText('GLM-5.2');
	await expect(composer.locator('.conversation-agent')).toContainText('Max');
	await expect(composer.locator('.conversation-reconnect-status')).toContainText(/Reconnecting\.\.\. \d+\/10/);
	await expect(composer.locator('.conversation-stop-button')).toBeVisible();
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

	await toggle.click();
	await expect(page.locator('.part.auxiliarybar')).toBeHidden();
	await expect(toggle).not.toHaveClass(/active/);
}
