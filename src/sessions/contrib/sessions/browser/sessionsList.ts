/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ToolBar } from '../../../base/browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { SessionStatus, type IActiveSession, type ISession, type ISessionChangesSummary, type ISessionWorkspace } from '../../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface ISessionsListOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

type SessionLike = ISession | IActiveSession;
type SidebarTreeSectionId = 'pinned' | 'projects';

interface ISessionListRow {
	readonly id: string;
	readonly icon: string;
	readonly status: SessionStatus;
	readonly title: string;
	readonly workspace?: ISessionWorkspace;
	readonly changesSummary?: ISessionChangesSummary;
	readonly updatedAt: Date;
	readonly description?: string;
	readonly meta?: ISessionListRowMeta;
	readonly isActive?: boolean;
	readonly isUnread?: boolean;
	readonly isPinned?: boolean;
	readonly onClick?: () => void;
	readonly onPin?: () => void;
	readonly onArchive?: () => void;
}

interface ISessionListRowMeta {
	readonly icon?: string;
	readonly changesSummary?: ISessionChangesSummary;
	readonly timeLabel: string;
}

interface ISidebarProjectGroup {
	readonly id: string;
	readonly name: string;
	readonly count: number;
	readonly expanded: boolean;
	readonly rows: readonly ISessionListRow[];
}

interface ISidebarTask {
	readonly id: string;
	readonly projectId: string;
	readonly icon: string;
	readonly status: SessionStatus;
	readonly title: string;
	readonly timeLabel: string;
	readonly openSessionId: string;
	isPinned: boolean;
	isArchived: boolean;
}

export class SessionsList extends Disposable {
	private readonly rowSubscriptions = this._register(new DisposableStore());
	private readonly collapsedSidebarSections = new Set<SidebarTreeSectionId>();
	private readonly sidebarTasks: ISidebarTask[] = [
		{
			id: 'project-obsidian-docs',
			projectId: 'obsidian',
			icon: 'codicon-circle-filled',
			status: SessionStatus.InProgress,
			title: '梳理下文档',
			timeLabel: '2h',
			openSessionId: 'session-in-progress',
			isPinned: false,
			isArchived: false,
		},
		{
			id: 'project-zcode-settings-cleanup',
			projectId: 'zcodeproject',
			icon: 'codicon-check',
			status: SessionStatus.Completed,
			title: 'Ship settings sidebar cleanup',
			timeLabel: '3d',
			openSessionId: 'session-completed',
			isPinned: false,
			isArchived: false,
		},
	];

	constructor(
		private readonly container: HTMLElement,
		private readonly options: ISessionsListOptions = {},
	) {
		super();
		this.bind();
		this.render();
	}

	private bind(): void {
		const visibleSessions = this.options.sessionsService?.visibleSessions ?? this.options.sessionsPartService?.visibleSessions;
		const activeSession = this.options.sessionsService?.activeSession ?? this.options.sessionsPartService?.activeSession;
		const mode = this.options.sessionsPartService?.mode;

		if (visibleSessions) {
			this._register(visibleSessions.subscribe(() => this.render()));
		}

		if (activeSession) {
			this._register(activeSession.subscribe(() => this.render()));
		}

		if (mode) {
			this._register(mode.subscribe(() => this.render()));
		}
	}

	private render(): void {
		this.rowSubscriptions.clear();
		this.container.textContent = '';

		const root = document.createElement('div');
		root.className = 'sessions-sidebar';
		this.container.appendChild(root);

		this.renderHeader(root);

		const content = document.createElement('div');
		content.className = 'sessions-sidebar-content';
		root.appendChild(content);

		const sessions = this.getSessions();
		this.renderNavigationSections(content, sessions);
		if (sessions.length > 0) {
			this.bindRows(sessions);
		}

		this.renderFooter(root);
	}

	private renderHeader(container: HTMLElement): void {
		const header = document.createElement('div');
		header.className = 'sessions-sidebar-header';

		const actions = document.createElement('div');
		actions.className = 'sessions-sidebar-header-actions';
		const toolbar = this.rowSubscriptions.add(
			new ToolBar(actions, {
				ariaLabel: 'Sessions actions',
				extraClassName: 'sessions-sidebar-toolbar',
			}),
		);
		toolbar.setActions(this.createHeaderActions());
		header.appendChild(actions);

		container.appendChild(header);
	}

	private createHeaderActions(): readonly IAction[] {
		return [
			{
				id: 'sessions.sidebar.new',
				label: 'New task',
				icon: 'codicon-new-session',
				class: 'sessions-sidebar-menu-action',
				keybinding: '⌘ N',
				tooltip: 'New task',
				run: () => this.options.sessionsPartService?.showNewSession(),
			},
			{
				id: 'sessions.sidebar.search',
				label: 'Search',
				icon: 'codicon-search',
				class: 'sessions-sidebar-menu-action',
				keybinding: '⌘ K',
				run: () => {},
			},
			{
				id: 'sessions.sidebar.skills',
				label: 'Skills',
				icon: 'codicon-wand',
				class: 'sessions-sidebar-menu-action',
				run: () => {},
			},
		];
	}

	private renderNavigationSections(container: HTMLElement, sessions: readonly SessionLike[]): void {
		const model = this.createSidebarSessionModel(sessions);
		this.renderPinnedSection(container, model.pinned);
		this.renderProjectsSection(container, model.projects);
	}

	private createSidebarSessionModel(sessions: readonly SessionLike[]): {
		readonly pinned: readonly ISessionListRow[];
		readonly projects: readonly ISidebarProjectGroup[];
	} {
		const updatedAt = new Date(0);
		const activeSessionId = this.getActiveSessionId();
		const openSession = (preferredSessionId: string): (() => void) => {
			return () => {
				const fallback = sessions[0]?.sessionId;
				const target = sessions.some(session => session.sessionId === preferredSessionId) ? preferredSessionId : fallback;
				if (target) {
					this.options.sessionsService?.openSession(target);
				}
			};
		};

		const activeTasks = this.sidebarTasks.filter(task => !task.isArchived);
		const toTaskRow = (task: ISidebarTask): ISessionListRow => ({
			id: task.id,
			icon: task.icon,
			status: task.status,
			title: task.title,
			updatedAt,
			meta: { icon: 'codicon-folder', timeLabel: task.timeLabel },
			isPinned: task.isPinned,
			onClick: openSession(task.openSessionId),
			onPin: () => this.togglePinnedTask(task.id),
			onArchive: () => this.archiveTask(task.id),
		});

		const pinned = activeTasks.filter(task => task.isPinned).map(task => toTaskRow(task));

		const startedProjectRows = new Map<string, ISessionListRow[]>();
		for (const session of sessions) {
			if (!session.sessionId.startsWith('session-started-')) {
				continue;
			}

			const workspace = session.workspace.get();
			const workspaceLabel = workspace?.label ?? 'Workspace';
			const rows = startedProjectRows.get(workspaceLabel) ?? [];
			startedProjectRows.set(workspaceLabel, [
				...rows,
				{
					id: `started-${session.sessionId}`,
					icon: session.status.get() === SessionStatus.InProgress ? 'codicon-loading' : session.icon,
					status: session.status.get(),
					title: session.title.get(),
					...(workspace ? { workspace } : {}),
					updatedAt: session.updatedAt.get(),
					meta: { icon: 'codicon-folder', timeLabel: 'now' },
					isActive: session.sessionId === activeSessionId,
					onClick: openSession(session.sessionId),
				},
			]);
		}

		const startedProjects = [...startedProjectRows.entries()].map(([workspaceLabel, rows]) => ({
			id: `started-${workspaceLabel}`,
			name: workspaceLabel,
			count: rows.length,
			expanded: true,
			rows,
		}));

		const projects: readonly ISidebarProjectGroup[] = [
			...startedProjects,
			{
				id: 'obsidian',
				name: 'Obsidian',
				count: activeTasks.filter(task => task.projectId === 'obsidian' && !task.isPinned).length,
				expanded: true,
				rows: activeTasks.filter(task => task.projectId === 'obsidian' && !task.isPinned).map(task => toTaskRow(task)),
			},
			{
				id: 'zcodeproject',
				name: 'ZCodeProject',
				count: activeTasks.filter(task => task.projectId === 'zcodeproject' && !task.isPinned).length,
				expanded: true,
				rows: activeTasks.filter(task => task.projectId === 'zcodeproject' && !task.isPinned).map(task => toTaskRow(task)),
			},
		];

		return { pinned, projects };
	}

	private renderPinnedSection(container: HTMLElement, rows: readonly ISessionListRow[]): void {
		const list = document.createElement('div');
		list.className = 'sessions-list-section-rows';

		if (rows.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sessions-list-empty';
			empty.textContent = 'No pinned items';
			list.appendChild(empty);
		} else {
			for (const row of rows) {
				list.appendChild(this.renderProjectTaskRow(row));
			}
		}

		this.renderSidebarTreeSection(container, 'pinned', 'Pinned', list);
	}

	private renderProjectsSection(container: HTMLElement, projects: readonly ISidebarProjectGroup[]): void {
		const browser = document.createElement('div');
		browser.className = 'sessions-project-browser';

		const list = document.createElement('div');
		list.className = 'sessions-project-list';
		browser.appendChild(list);

		for (const project of projects) {
			list.appendChild(this.renderProjectGroup(project));
		}

		this.renderSidebarTreeSection(container, 'projects', 'Projects', browser);
	}

	private renderProjectGroup(project: ISidebarProjectGroup): HTMLElement {
		const group = document.createElement('div');
		group.className = 'sessions-project-group';
		group.dataset.projectId = project.id;

		const toggle = document.createElement('button');
		toggle.className = 'sessions-project-toggle';
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(project.expanded));

		const leading = document.createElement('span');
		leading.className = 'sessions-project-leading';
		leading.setAttribute('aria-hidden', 'true');

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-folder sessions-project-icon';
		leading.appendChild(icon);
		toggle.appendChild(leading);

		const name = document.createElement('span');
		name.className = 'sessions-project-name';
		name.textContent = project.name;
		toggle.appendChild(name);

		const count = document.createElement('span');
		count.className = 'sessions-project-count';
		count.textContent = String(project.count);
		toggle.appendChild(count);

		const rows = document.createElement('div');
		rows.className = 'sessions-project-session-list';
		rows.hidden = !project.expanded;
		if (project.rows.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sessions-project-empty';
			empty.textContent = 'No tasks yet';
			rows.appendChild(empty);
		} else {
			for (const row of project.rows) {
				rows.appendChild(this.renderProjectTaskRow(row));
			}
		}

		toggle.addEventListener('click', () => {
			const expanded = toggle.getAttribute('aria-expanded') !== 'true';
			toggle.setAttribute('aria-expanded', String(expanded));
			rows.hidden = !expanded;
		});

		group.append(toggle, rows);
		return group;
	}

	private renderSidebarTreeSection(container: HTMLElement, id: SidebarTreeSectionId, title: string, contentElement: HTMLElement): void {
		const section = document.createElement('section');
		section.className = `sessions-list-section sessions-sidebar-tree-section sessions-${id}-section`;
		section.dataset.sessionGroup = id;

		const expanded = !this.collapsedSidebarSections.has(id);
		const toggle = document.createElement('button');
		toggle.className = 'sessions-tree-section-toggle';
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(expanded));

		const chevron = document.createElement('span');
		chevron.className = `codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} sessions-tree-section-chevron`;
		chevron.setAttribute('aria-hidden', 'true');
		toggle.appendChild(chevron);

		const label = document.createElement('span');
		label.className = 'sessions-tree-section-label';
		label.textContent = title;
		toggle.appendChild(label);

		const content = document.createElement('div');
		content.className = 'sessions-tree-section-content';
		content.hidden = !expanded;
		content.appendChild(contentElement);

		toggle.addEventListener('click', () => {
			if (this.collapsedSidebarSections.has(id)) {
				this.collapsedSidebarSections.delete(id);
			} else {
				this.collapsedSidebarSections.add(id);
			}
			this.render();
		});

		section.append(toggle, content);
		container.appendChild(section);
	}

	private renderCustomizations(container: HTMLElement): void {
		const rows = [
			{ id: 'overview', icon: 'codicon-home', label: 'Overview' },
			{ id: 'agents', icon: 'codicon-extensions', label: 'Agents', count: '3' },
			{ id: 'skills', icon: 'codicon-lightbulb', label: 'Skills', count: '44' },
			{ id: 'instructions', icon: 'codicon-book', label: 'Instructions', count: '23' },
			{ id: 'hooks', icon: 'codicon-zap', label: 'Hooks' },
			{ id: 'mcp-servers', icon: 'codicon-server', label: 'MCP Servers', count: '4' },
			{ id: 'plugins', icon: 'codicon-plug', label: 'Plugins' },
			{ id: 'tools', icon: 'codicon-tools', label: 'Tools', count: '12' },
		];

		const section = document.createElement('section');
		section.className = 'sessions-list-section sessions-customizations-section';
		section.dataset.sessionGroup = 'customizations';

		const header = document.createElement('div');
		header.className = 'sessions-list-section-header';
		header.textContent = 'Customizations';
		section.appendChild(header);

		const list = document.createElement('div');
		list.className = 'sessions-customizations-list';
		section.appendChild(list);

		for (const row of rows) {
			const button = document.createElement('button');
			button.className = 'sessions-customization-row';
			button.type = 'button';
			button.dataset.customizationId = row.id;
			const icon = document.createElement('span');
			icon.className = `codicon ${row.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			const label = document.createElement('span');
			label.textContent = row.label;
			button.appendChild(label);
			if (row.count) {
				const count = document.createElement('span');
				count.className = 'sessions-customization-count';
				count.textContent = row.count;
				button.appendChild(count);
			}
			list.appendChild(button);
		}

		container.appendChild(section);
	}

	private renderSessionSections(container: HTMLElement, sessions: readonly SessionLike[]): void {
		const activeSession = this.getActiveSession();
		const activeWorkspace = activeSession?.workspace.get()?.label;
		const activeId = activeSession?.sessionId;
		const visibleIds = new Set(this.getVisibleSessions().map(session => session.sessionId));

		const openSessions = sessions.filter(session => !session.isArchived.get() && session.status.get() !== SessionStatus.Completed);
		const pinnedSessions = sessions.filter(session => visibleIds.has(session.sessionId));
		const workspaceSessions = activeWorkspace
			? sessions.filter(session => session.workspace.get()?.label === activeWorkspace)
			: sessions.filter(session => session.workspace.get()?.label === 'mellivora-malatang-agent-chat');
		const doneSessions = sessions.filter(session => session.isArchived.get() || session.status.get() === SessionStatus.Completed);

		this.renderSection(
			container,
			'Sessions',
			openSessions.map(session => this.toSessionRow(session, activeId)),
		);
		this.renderSection(
			container,
			'Pinned',
			pinnedSessions.map(session => this.toSessionRow(session, activeId)),
		);
		this.renderSection(
			container,
			'agent-chat',
			workspaceSessions.map(session => this.toSessionRow(session, activeId, activeWorkspace)),
		);
		this.renderSection(
			container,
			'Done',
			doneSessions.map(session => this.toSessionRow(session, activeId)),
		);
	}

	private renderFallback(container: HTMLElement): void {
		const now = new Date();
		const workspace: ISessionWorkspace = {
			label: 'mellivora-malatang-agent-chat',
			branchName: 'codex/agents-window-rebuild',
		};

		const rows: readonly ISessionListRow[] = [
			{
				id: 'fallback-active',
				icon: 'codicon-copilot',
				status: SessionStatus.InProgress,
				title: 'Refine onboarding flow',
				workspace,
				updatedAt: now,
				description: 'Mock provider will appear here',
				changesSummary: { files: 4, additions: 96, deletions: 18 },
				isActive: true,
			},
		];

		this.renderSection(container, 'Sessions', rows);
		this.renderSection(container, 'Pinned', rows);
		this.renderSection(
			container,
			'agent-chat',
			rows.map(row => omitWorkspace(row)),
		);
		this.renderSection(container, 'Done', [
			{
				id: 'fallback-done',
				icon: 'codicon-check',
				status: SessionStatus.Completed,
				title: 'Ship settings sidebar cleanup',
				updatedAt: now,
				description: 'Completed',
				changesSummary: { files: 8, additions: 142, deletions: 37 },
			},
		]);
	}

	private renderSection(container: HTMLElement, title: string, rows: readonly ISessionListRow[], groupId?: string): void {
		const section = document.createElement('section');
		section.className = 'sessions-list-section';
		if (groupId) {
			section.dataset.sessionGroup = groupId;
		}

		const header = document.createElement('div');
		header.className = 'sessions-list-section-header';
		header.textContent = title;
		section.appendChild(header);

		const list = document.createElement('div');
		list.className = 'sessions-list-section-rows';
		section.appendChild(list);

		if (rows.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sessions-list-empty';
			empty.textContent = 'No sessions';
			list.appendChild(empty);
		} else {
			for (const row of rows) {
				list.appendChild(this.renderRow(row));
			}
		}

		container.appendChild(section);
	}

	private renderProjectTaskRow(row: ISessionListRow): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = 'sessions-project-task-row';
		wrapper.dataset.sessionRowId = row.id;
		wrapper.classList.toggle('active', Boolean(row.isActive));
		wrapper.classList.toggle('has-action', Boolean(row.onArchive));

		const status = document.createElement('span');
		status.className = 'sessions-list-status';
		status.title = getStatusLabel(row.status);
		status.setAttribute('aria-hidden', 'true');
		wrapper.appendChild(status);

		if (row.onPin) {
			const pin = document.createElement('button');
			pin.className = 'codicon codicon-pinned sessions-project-task-pin';
			pin.type = 'button';
			pin.title = row.isPinned ? `Unpin ${row.title}` : `Pin ${row.title}`;
			pin.setAttribute('aria-label', pin.title);
			pin.setAttribute('aria-pressed', String(Boolean(row.isPinned)));
			if (row.isPinned) {
				pin.classList.add('pinned');
			}
			pin.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				row.onPin?.();
			});
			wrapper.appendChild(pin);
		}

		const main = document.createElement('button');
		main.className = 'sessions-list-row sessions-project-task-main';
		main.type = 'button';
		if (row.onClick) {
			main.addEventListener('click', row.onClick);
		}

		const mainStatus = document.createElement('span');
		mainStatus.className = 'sessions-list-status';
		mainStatus.title = getStatusLabel(row.status);
		mainStatus.setAttribute('aria-hidden', 'true');
		main.appendChild(mainStatus);

		if (row.status === SessionStatus.InProgress && row.isActive) {
			const spinner = document.createElement('span');
			spinner.className = 'codicon codicon-loading sessions-project-task-spinner';
			spinner.setAttribute('aria-hidden', 'true');
			main.appendChild(spinner);
		}

		const title = document.createElement('span');
		title.className = 'sessions-list-row-title sessions-project-task-title';
		title.textContent = row.title;
		main.appendChild(title);

		const time = document.createElement('span');
		time.className = 'sessions-project-task-time';
		time.textContent = row.meta?.timeLabel ?? formatTimestamp(row.updatedAt);
		main.appendChild(time);

		wrapper.appendChild(main);

		if (row.onArchive) {
			const archive = document.createElement('button');
			archive.className = 'sessions-project-task-action';
			archive.type = 'button';
			archive.title = 'Archive task';
			archive.setAttribute('aria-label', `Archive ${row.title}`);
			archive.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				row.onArchive?.();
			});
			const archiveIcon = document.createElement('span');
			archiveIcon.className = 'codicon codicon-archive';
			archiveIcon.setAttribute('aria-hidden', 'true');
			archive.appendChild(archiveIcon);
			const tooltip = document.createElement('span');
			tooltip.className = 'sessions-project-task-tooltip';
			tooltip.textContent = row.title;
			archive.appendChild(tooltip);
			wrapper.appendChild(archive);
		}

		return wrapper;
	}

	private togglePinnedTask(taskId: string): void {
		const task = this.sidebarTasks.find(task => task.id === taskId);
		if (!task) {
			return;
		}

		task.isPinned = !task.isPinned;
		this.render();
	}

	private archiveTask(taskId: string): void {
		const task = this.sidebarTasks.find(task => task.id === taskId);
		if (!task) {
			return;
		}

		task.isArchived = true;
		this.render();
	}

	private renderRow(row: ISessionListRow): HTMLElement {
		const element = document.createElement('button');
		element.className = 'sessions-list-row';
		element.type = 'button';
		element.dataset.sessionRowId = row.id;
		if (row.isActive) {
			element.classList.add('active');
		}
		if (row.isUnread) {
			element.classList.add('unread');
		}
		if (row.onClick) {
			element.addEventListener('click', row.onClick);
		}

		const status = document.createElement('span');
		status.className = 'sessions-list-status';
		status.title = getStatusLabel(row.status);
		status.setAttribute('aria-hidden', 'true');
		element.appendChild(status);

		const body = document.createElement('span');
		body.className = 'sessions-list-row-body';

		const top = document.createElement('span');
		top.className = 'sessions-list-row-top';

		const title = document.createElement('span');
		title.className = 'sessions-list-row-title';
		title.textContent = row.title;
		top.appendChild(title);

		if (row.workspace) {
			const workspace = document.createElement('span');
			workspace.className = 'sessions-list-workspace-badge';
			workspace.textContent = row.workspace.label;
			top.appendChild(workspace);
		}

		if (row.changesSummary) {
			top.appendChild(createDiff(row.changesSummary));
		}

		body.appendChild(top);

		const bottom = document.createElement('span');
		bottom.className = 'sessions-list-row-bottom';
		if (row.meta) {
			renderRowMeta(bottom, row.meta);
		} else {
			bottom.textContent = `${formatTimestamp(row.updatedAt)} - ${row.description ?? getStatusLabel(row.status)}`;
		}
		body.appendChild(bottom);

		element.appendChild(body);
		return element;
	}

	private renderFooter(container: HTMLElement): void {
		const footer = document.createElement('div');
		footer.className = 'sessions-sidebar-footer';

		const userButton = document.createElement('button');
		userButton.className = 'sessions-sidebar-user-button';
		userButton.type = 'button';
		userButton.title = 'Account';
		userButton.setAttribute('aria-label', 'Account');
		const avatar = document.createElement('span');
		avatar.className = 'sessions-sidebar-avatar';
		avatar.textContent = 'C';
		avatar.setAttribute('aria-hidden', 'true');
		userButton.appendChild(avatar);
		const name = document.createElement('span');
		name.className = 'sessions-sidebar-user-name';
		name.textContent = 'Chao Wang';
		userButton.appendChild(name);
		footer.appendChild(userButton);

		const settings = document.createElement('button');
		settings.className = 'sessions-sidebar-settings-button';
		settings.type = 'button';
		settings.title = 'Settings';
		settings.setAttribute('aria-label', 'Settings');
		settings.addEventListener('click', () => this.openSettingsDialog());
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-settings-gear';
		icon.setAttribute('aria-hidden', 'true');
		settings.appendChild(icon);
		footer.appendChild(settings);

		container.appendChild(footer);
	}

	private openSettingsDialog(): void {
		const existing = document.querySelector<HTMLElement>('.sessions-settings-dialog-backdrop');
		if (existing) {
			existing.hidden = false;
			return;
		}

		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;
		host.appendChild(this.renderSettingsDialog());
	}

	private renderSettingsDialog(): HTMLElement {
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-settings-dialog-backdrop';

		const dialog = document.createElement('div');
		dialog.className = 'sessions-settings-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Agent Customizations for Copilot CLI');
		backdrop.appendChild(dialog);

		const header = document.createElement('div');
		header.className = 'sessions-settings-header';
		const title = document.createElement('h1');
		title.className = 'sessions-settings-title';
		title.textContent = 'Agent Customizations for Copilot CLI';
		header.appendChild(title);
		const actions = document.createElement('div');
		actions.className = 'sessions-settings-window-actions';
		for (const action of [
			{ icon: 'codicon-open-preview', label: 'Open' },
			{ icon: 'codicon-screen-full', label: 'Fullscreen' },
			{ icon: 'codicon-close', label: 'Close', close: true },
		]) {
			const button = document.createElement('button');
			button.className = action.close ? 'sessions-settings-close' : 'sessions-settings-window-action';
			button.type = 'button';
			button.title = action.label;
			button.setAttribute('aria-label', action.label);
			if (action.close) {
				button.addEventListener('click', () => {
					backdrop.hidden = true;
				});
			}
			const icon = document.createElement('span');
			icon.className = `codicon ${action.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			actions.appendChild(button);
		}
		header.appendChild(actions);
		dialog.appendChild(header);

		const body = document.createElement('div');
		body.className = 'sessions-settings-body';
		body.append(this.renderSettingsNavigation(), this.renderSettingsMain());
		dialog.appendChild(body);

		return backdrop;
	}

	private renderSettingsNavigation(): HTMLElement {
		const nav = document.createElement('nav');
		nav.className = 'sessions-settings-nav';
		nav.setAttribute('aria-label', 'Agent customizations');

		const rows = [
			{ id: 'overview', icon: 'codicon-home', label: 'Overview' },
			{ id: 'agents', icon: 'codicon-extensions', label: 'Agents', count: '3' },
			{ id: 'skills', icon: 'codicon-lightbulb', label: 'Skills', count: '44' },
			{ id: 'instructions', icon: 'codicon-book', label: 'Instructions', count: '23' },
			{ id: 'hooks', icon: 'codicon-zap', label: 'Hooks' },
			{ id: 'mcp-servers', icon: 'codicon-server', label: 'MCP Servers', count: '4', active: true },
			{ id: 'plugins', icon: 'codicon-plug', label: 'Plugins' },
			{ id: 'tools', icon: 'codicon-tools', label: 'Tools', count: '12' },
		];

		for (const row of rows) {
			const button = document.createElement('button');
			button.className = 'sessions-settings-nav-row';
			if (row.active) {
				button.classList.add('active');
			}
			button.type = 'button';
			button.dataset.settingsNavId = row.id;
			const icon = document.createElement('span');
			icon.className = `codicon ${row.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			const label = document.createElement('span');
			label.textContent = row.label;
			button.appendChild(label);
			if (row.count) {
				const count = document.createElement('span');
				count.className = 'sessions-settings-nav-count';
				count.textContent = row.count;
				button.appendChild(count);
			}
			nav.appendChild(button);
		}

		return nav;
	}

	private renderSettingsMain(): HTMLElement {
		const main = document.createElement('main');
		main.className = 'sessions-settings-main';

		const content = document.createElement('div');
		content.className = 'sessions-settings-main-content';
		main.appendChild(content);

		const title = document.createElement('h2');
		title.textContent = 'MCP Servers';
		content.appendChild(title);

		const description = document.createElement('p');
		description.textContent = 'An open standard that lets AI use external tools and services. MCP servers provide tools for file operations, databases, APIs, and more.';
		content.appendChild(description);

		const link = document.createElement('a');
		link.href = '#';
		link.textContent = 'Learn more about MCP servers';
		content.appendChild(link);

		const controls = document.createElement('div');
		controls.className = 'sessions-settings-controls';
		const search = document.createElement('input');
		search.className = 'sessions-settings-search';
		search.placeholder = 'Type to search...';
		controls.appendChild(search);
		const marketplace = document.createElement('button');
		marketplace.className = 'sessions-settings-marketplace';
		marketplace.type = 'button';
		marketplace.innerHTML = '<span class="codicon codicon-library" aria-hidden="true"></span><span>Browse Marketplace</span>';
		controls.appendChild(marketplace);
		const add = document.createElement('button');
		add.className = 'sessions-settings-add';
		add.type = 'button';
		add.title = 'Add MCP Server';
		add.setAttribute('aria-label', 'Add MCP Server');
		add.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span>';
		controls.appendChild(add);
		content.appendChild(controls);

		const groups = document.createElement('div');
		groups.className = 'sessions-settings-groups';
		content.appendChild(groups);

		for (const group of [
			{ id: 'workspace', title: 'Workspace', count: '2', rows: ['component-explorer', 'vscode-automation-mcp'] },
			{ id: 'user', title: 'User', count: '1', rows: ['Docs by LangChain'] },
			{ id: 'builtin', title: 'Built-In', count: '1', rows: ['GitHub'] },
		]) {
			const section = document.createElement('section');
			section.className = 'sessions-settings-group';
			section.dataset.settingsGroup = group.id;
			const heading = document.createElement('button');
			heading.className = 'sessions-settings-group-title';
			heading.type = 'button';
			heading.innerHTML = `<span>${group.title}</span><span>${group.count}</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span>`;
			section.appendChild(heading);
			const rows = document.createElement('div');
			rows.className = 'sessions-settings-group-rows';
			for (const row of group.rows) {
				const item = document.createElement('div');
				item.className = 'sessions-settings-group-row';
				item.textContent = row;
				rows.appendChild(item);
			}
			section.appendChild(rows);
			groups.appendChild(section);
		}

		return main;
	}

	private toSessionRow(session: SessionLike, activeSessionId: string | undefined, redundantWorkspace?: string): ISessionListRow {
		const workspace = session.workspace.get();
		const changesSummary = session.changesSummary.get();
		const description = session.description.get();
		return {
			id: session.sessionId,
			icon: session.icon,
			status: session.status.get(),
			title: session.title.get(),
			...(workspace && workspace.label !== redundantWorkspace ? { workspace } : {}),
			...(changesSummary ? { changesSummary } : {}),
			updatedAt: session.updatedAt.get(),
			...(description ? { description } : {}),
			isActive: session.sessionId === activeSessionId,
			isUnread: !session.isRead.get(),
			onClick: () => {
				this.options.sessionsService?.openSession(session.sessionId);
			},
		};
	}

	private bindRows(sessions: readonly SessionLike[]): void {
		const seenSessions = new Set<string>();
		for (const session of sessions) {
			if (seenSessions.has(session.sessionId)) {
				continue;
			}
			seenSessions.add(session.sessionId);
			for (const observable of [
				session.workspace,
				session.title,
				session.updatedAt,
				session.status,
				session.description,
				session.changesSummary,
				session.isArchived,
				session.isRead,
				session.messages,
				session.interactivity,
			]) {
				this.rowSubscriptions.add(observable.subscribe(() => this.render()));
			}
		}
	}

	private getSessions(): readonly SessionLike[] {
		const serviceSessions = this.options.sessionsService?.getSessions();
		if (serviceSessions) {
			return serviceSessions;
		}

		return this.getVisibleSessions();
	}

	private getVisibleSessions(): readonly IActiveSession[] {
		const visible = this.options.sessionsService?.visibleSessions.get() ?? this.options.sessionsPartService?.visibleSessions.get() ?? [];
		return visible.filter((session): session is IActiveSession => session !== undefined);
	}

	private getActiveSession(): IActiveSession | undefined {
		return this.options.sessionsService?.activeSession.get() ?? this.options.sessionsPartService?.activeSession.get();
	}

	private getActiveSessionId(): string | undefined {
		return this.getActiveSession()?.sessionId;
	}
}

function createDiff(summary: ISessionChangesSummary): HTMLElement {
	const diff = document.createElement('span');
	diff.className = 'sessions-list-diff';
	diff.title = `${summary.files} changed files`;

	const additions = document.createElement('span');
	additions.className = 'sessions-diff-additions';
	additions.textContent = `+${summary.additions}`;
	diff.appendChild(additions);

	const deletions = document.createElement('span');
	deletions.className = 'sessions-diff-deletions';
	deletions.textContent = `-${summary.deletions}`;
	diff.appendChild(deletions);

	return diff;
}

function renderRowMeta(container: HTMLElement, meta: ISessionListRowMeta): void {
	const fragments: HTMLElement[] = [];

	if (meta.icon) {
		const icon = document.createElement('span');
		icon.className = `codicon ${meta.icon}`;
		icon.setAttribute('aria-hidden', 'true');
		fragments.push(icon);
	}

	if (meta.changesSummary) {
		fragments.push(createDiff(meta.changesSummary));
	}

	const time = document.createElement('span');
	time.className = 'sessions-list-meta-time';
	time.textContent = meta.timeLabel;
	fragments.push(time);

	for (const [index, fragment] of fragments.entries()) {
		if (index > 0) {
			const separator = document.createElement('span');
			separator.className = 'sessions-list-meta-separator';
			separator.textContent = '·';
			container.appendChild(separator);
		}
		container.appendChild(fragment);
	}
}

function omitWorkspace(row: ISessionListRow): ISessionListRow {
	return {
		id: row.id,
		icon: row.icon,
		status: row.status,
		title: row.title,
		...(row.changesSummary ? { changesSummary: row.changesSummary } : {}),
		updatedAt: row.updatedAt,
		...(row.description ? { description: row.description } : {}),
		...(row.meta ? { meta: row.meta } : {}),
		...(row.isActive ? { isActive: true } : {}),
		...(row.isUnread ? { isUnread: true } : {}),
		...(row.onClick ? { onClick: row.onClick } : {}),
	};
}

function getStatusLabel(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled:
			return 'Untitled';
		case SessionStatus.InProgress:
			return 'In progress';
		case SessionStatus.NeedsInput:
			return 'Needs input';
		case SessionStatus.Completed:
			return 'Completed';
		case SessionStatus.Error:
			return 'Error';
	}
}

function formatTimestamp(date: Date): string {
	const diff = Date.now() - date.getTime();
	const minutes = Math.max(0, Math.floor(diff / 60000));
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}

	return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
