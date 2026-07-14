/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { append, clearNode } from '../../../base/browser/dom.js';
import { SearchPalette, type ISearchPaletteAction, type ISearchPaletteRecentChanges, type ISearchPaletteTask } from '../../search/browser/searchPalette.js';
import { ToolBar } from '../../../base/browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { ModelSettingsView } from '../../../browser/parts/modelSettingsView.js';
import { SkillSettingsView } from '../../../browser/parts/skillSettingsView.js';
import { ProjectConfigView } from '../../../browser/parts/projectConfigView.js';
import { settingsDropdown, settingsRow, settingsSection, settingsToggle } from '../../../browser/parts/settingsControls.js';
import { readPreferences, updatePreferences } from '../../../browser/parts/settingsPrefs.js';
import type { ThemeId } from '../../../platform/theme/theme.js';
import type { IModelsService } from '../../../services/models/browser/modelsService.js';
import { SessionStatus, type IActiveSession, type ISession, type ISessionChangesSummary, type ISessionWorkspace } from '../../../services/sessions/common/session.js';
import type { IProjectsService } from '../../../services/projects/browser/projectsService.js';
import type { ISessionsPartService, WorkbenchMode } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ISkillsService } from '../../../services/skills/browser/skillsService.js';
import type { IEnvironmentsService } from '../../../services/environments/browser/environmentsService.js';

export interface ISessionsListOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	readonly projectsService?: IProjectsService;
	readonly modelsService?: IModelsService;
	readonly skillsService?: ISkillsService;
	readonly environmentsService?: IEnvironmentsService;
	readonly onToggleSidebar?: () => void;
}

type SessionLike = ISession | IActiveSession;
type SidebarTreeSectionId = 'pinned' | 'chat' | 'projects';

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
	readonly onDelete?: () => void;
	readonly onRename?: (title: string) => void;
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

const SETTINGS_PLACEHOLDERS: Readonly<Record<string, { readonly icon: string; readonly title: string; readonly description: string }>> = {
	agents: { icon: 'codicon-extensions', title: 'Agents', description: 'Define reusable agent personas with their own model, prompt, and tools.' },
	skills: { icon: 'codicon-lightbulb', title: 'Skills', description: 'Package task-specific instructions the agent loads on demand.' },
	'mcp-servers': { icon: 'codicon-server', title: 'MCP Servers', description: 'Connect external tools and services over the Model Context Protocol.' },
	tools: { icon: 'codicon-tools', title: 'Tools', description: 'Manage the built-in tools and their approval policy.' },
};

export class SessionsList extends Disposable {
	private readonly rowSubscriptions = this._register(new DisposableStore());
	private readonly collapsedSidebarSections = new Set<SidebarTreeSectionId>();
	private settingsSection = 'general';
	private closeSettings: (() => void) | undefined;
	private settingsNavElement: HTMLElement | undefined;
	private settingsMainElement: HTMLElement | undefined;
	private modelSettingsView: ModelSettingsView | undefined;
	private skillSettingsView: SkillSettingsView | undefined;
	private readonly searchPalette: SearchPalette;

	constructor(
		private readonly container: HTMLElement,
		private readonly options: ISessionsListOptions = {},
	) {
		super();
		this.searchPalette = this._register(
			new SearchPalette({
				getHost: () => document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container,
				getTasks: () => this.getPaletteTasks(),
				openTask: id => this.options.sessionsService?.openSession(id),
				actions: this.buildPaletteActions(),
				getRecentChanges: () => this.getPaletteRecentChanges(),
			}),
		);
		this.registerGlobalShortcuts();
		this.bind();
		this.render();
	}

	private registerGlobalShortcuts(): void {
		const onKeydown = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				this.searchPalette.toggle();
			}
		};
		document.addEventListener('keydown', onKeydown, true);
		this._register(toDisposable(() => document.removeEventListener('keydown', onKeydown, true)));
	}

	private buildPaletteActions(): readonly ISearchPaletteAction[] {
		const partService = this.options.sessionsPartService;
		const actions: ISearchPaletteAction[] = [
			{ id: 'new-task', label: 'New task', icon: 'codicon-add', group: 'suggested', keybinding: '⌘ N', run: () => partService?.showNewSession() },
			{ id: 'settings', label: 'Settings', icon: 'codicon-settings-gear', group: 'suggested', run: () => this.openSettingsDialog() },
		];
		if (this.options.onToggleSidebar) {
			actions.push({
				id: 'toggle-sidebar',
				label: 'Toggle sidebar',
				icon: 'codicon-layout-sidebar-left',
				group: 'panels',
				keybinding: '⌘ B',
				run: () => this.options.onToggleSidebar?.(),
			});
		}
		actions.push({ id: 'toggle-side-pane', label: 'Toggle side pane', icon: 'codicon-layout-sidebar-right', group: 'panels', run: () => partService?.toggleSidePane() });
		return actions;
	}

	private getPaletteTasks(): readonly ISearchPaletteTask[] {
		const sessions = this.getSessions().filter(session => !session.isArchived.get());
		return [...sessions]
			.sort((a, b) => b.updatedAt.get().getTime() - a.updatedAt.get().getTime())
			.map(session => ({ id: session.sessionId, title: session.title.get(), timeLabel: formatTimestamp(session.updatedAt.get()) }));
	}

	private getPaletteRecentChanges(): ISearchPaletteRecentChanges | undefined {
		const active = this.getActiveSession();
		const summary = active?.changesSummary.get();
		if (!summary) {
			return undefined;
		}
		return { ...(active ? { taskTitle: active.title.get() } : {}), files: summary.files, additions: summary.additions, deletions: summary.deletions };
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

		const projects = this.options.projectsService?.projects;
		if (projects) {
			this._register(projects.subscribe(() => this.render()));
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
		const newTaskActive = this.getMode() === 'newSession';
		return [
			{
				id: 'sessions.sidebar.new',
				label: 'New task',
				icon: 'codicon-new-session',
				class: `sessions-sidebar-menu-action${newTaskActive ? ' active' : ''}`,
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
				run: () => this.searchPalette.open(),
			},
			{
				id: 'sessions.sidebar.skills',
				label: 'Skills',
				icon: 'codicon-wand',
				class: 'sessions-sidebar-menu-action',
				run: () => this.openSettingsDialog('skills'),
			},
		];
	}

	private renderNavigationSections(container: HTMLElement, sessions: readonly SessionLike[]): void {
		const model = this.createSidebarSessionModel(sessions);
		if (model.pinned.length > 0) {
			this.renderPinnedSection(container, model.pinned);
		}
		this.renderProjectsSection(container, model.projects);
		if (model.chat.length > 0) {
			this.renderChatSection(container, model.chat);
		}
	}

	private createSidebarSessionModel(sessions: readonly SessionLike[]): {
		readonly pinned: readonly ISessionListRow[];
		readonly chat: readonly ISessionListRow[];
		readonly projects: readonly ISidebarProjectGroup[];
	} {
		// A session row reads as active only while its conversation is actually
		// on screen. On the New Session page (mode 'newSession') no row is active,
		// even though a session is still technically the "current" one.
		const activeSessionId = this.getMode() === 'newSession' ? undefined : this.getActiveSessionId();
		const toRow = (session: SessionLike): ISessionListRow => {
			const workspace = session.workspace.get();
			const isPinned = session.isPinned.get();
			return {
				id: session.sessionId,
				icon: session.status.get() === SessionStatus.InProgress ? 'codicon-loading' : session.icon,
				status: session.status.get(),
				title: session.title.get(),
				...(workspace ? { workspace } : {}),
				updatedAt: session.updatedAt.get(),
				isActive: session.sessionId === activeSessionId,
				isPinned,
				onClick: () => this.options.sessionsService?.openSession(session.sessionId),
				onPin: () => void this.options.sessionsService?.setSessionPinned(session.sessionId, !isPinned),
				onArchive: () => void this.options.sessionsService?.setSessionArchived(session.sessionId, true),
				onDelete: () => void this.options.sessionsService?.deleteSession(session.sessionId),
				onRename: title => void this.options.sessionsService?.renameSession(session.sessionId, title),
			};
		};

		const live = sessions.filter(session => !session.isArchived.get());
		const pinned = live.filter(session => session.isPinned.get()).map(toRow);
		const unpinned = live.filter(session => !session.isPinned.get());

		const projects: ISidebarProjectGroup[] = [];
		const knownProjectIds = new Set<string>();
		for (const project of this.options.projectsService?.projects.get() ?? []) {
			knownProjectIds.add(project.id);
			const rows = unpinned.filter(session => session.projectId === project.id).map(toRow);
			projects.push({ id: project.id, name: project.name, count: rows.length, expanded: true, rows });
		}

		// Sessions without a project (or whose project vanished) collect into
		// the Chat section, a top-level peer of Pinned and Projects.
		const chat = unpinned.filter(session => session.projectId === undefined || !knownProjectIds.has(session.projectId)).map(toRow);

		return { pinned, chat, projects };
	}

	private renderPinnedSection(container: HTMLElement, rows: readonly ISessionListRow[]): void {
		this.renderRowsSection(container, 'pinned', 'Pinned', rows, 'No pinned items');
	}

	private renderChatSection(container: HTMLElement, rows: readonly ISessionListRow[]): void {
		this.renderRowsSection(container, 'chat', 'Chat', rows, 'No chats yet');
	}

	private renderRowsSection(container: HTMLElement, id: SidebarTreeSectionId, title: string, rows: readonly ISessionListRow[], emptyText: string): void {
		const list = document.createElement('div');
		list.className = 'sessions-list-section-rows';

		if (rows.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sessions-list-empty';
			empty.textContent = emptyText;
			list.appendChild(empty);
		} else {
			for (const row of rows) {
				list.appendChild(this.renderProjectTaskRow(row));
			}
		}

		this.renderSidebarTreeSection(container, id, title, list);
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

		// Quick new-task for THIS project: pre-selects it and opens the New Task
		// page — no detour through the project picker while another project's
		// session is busy working.
		const addTask = document.createElement('button');
		addTask.className = 'sessions-project-add-task';
		addTask.type = 'button';
		addTask.title = `New task in ${project.name}`;
		addTask.setAttribute('aria-label', `New task in ${project.name}`);
		addTask.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.options.projectsService?.setActiveProject(project.id);
			this.options.sessionsPartService?.showNewSession();
		});
		const addIcon = document.createElement('span');
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');
		addTask.appendChild(addIcon);

		// Overflow menu: project-level actions (configure environments, reveal…).
		const more = document.createElement('button');
		more.className = 'sessions-project-more';
		more.type = 'button';
		more.title = `${project.name} actions`;
		more.setAttribute('aria-label', `${project.name} actions`);
		const moreIcon = document.createElement('span');
		moreIcon.className = 'codicon codicon-ellipsis';
		moreIcon.setAttribute('aria-hidden', 'true');
		more.appendChild(moreIcon);
		more.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.openProjectMenu(more, project.id, project.name);
		});

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

		// The + and ⋯ are siblings of the toggle (a button cannot nest in a button).
		const header = document.createElement('div');
		header.className = 'sessions-project-header';
		header.append(toggle, addTask, more);

		group.append(header, rows);
		return group;
	}

	/** Small anchored menu for a project group: configure environments, reveal in the OS file manager. */
	private openProjectMenu(anchor: HTMLElement, projectId: string, projectName: string): void {
		document.querySelector('.sessions-project-menu')?.remove();

		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;
		const menu = document.createElement('div');
		menu.className = 'sessions-project-menu';
		menu.setAttribute('role', 'menu');

		const close = (): void => {
			menu.remove();
			document.removeEventListener('mousedown', onOutside, true);
		};
		const onOutside = (event: MouseEvent): void => {
			if (event.target instanceof Node && !menu.contains(event.target) && event.target !== anchor) {
				close();
			}
		};

		const addItem = (icon: string, label: string, run: () => void): void => {
			const item = append(menu, document.createElement('button')) as HTMLButtonElement;
			item.className = 'sessions-project-menu-item';
			item.type = 'button';
			item.setAttribute('role', 'menuitem');
			const glyph = append(item, document.createElement('span'));
			glyph.className = `codicon ${icon}`;
			glyph.setAttribute('aria-hidden', 'true');
			append(item, document.createElement('span')).textContent = label;
			item.addEventListener('click', () => {
				close();
				run();
			});
		};

		addItem('codicon-settings-gear', '项目配置', () => this.openProjectConfig(projectId, projectName));
		if (this.options.projectsService?.revealInFolder) {
			addItem('codicon-folder-opened', '在 Finder 中显示', () => void this.options.projectsService!.revealInFolder!(projectId));
		}
		if (this.options.projectsService?.deleteProject) {
			addItem('codicon-trash', '删除项目', () => this.confirmDeleteProject(projectId, projectName));
		}

		host.appendChild(menu);
		const hostRect = host.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		menu.style.top = `${anchorRect.bottom - hostRect.top + 4}px`;
		menu.style.left = `${Math.min(anchorRect.left - hostRect.left, host.clientWidth - menu.offsetWidth - 8)}px`;
		document.addEventListener('mousedown', onOutside, true);
	}

	/** Confirm and delete a project (removes its sessions + config; external code is untouched). */
	private confirmDeleteProject(projectId: string, projectName: string): void {
		const service = this.options.projectsService;
		if (!service?.deleteProject || document.querySelector('.sessions-discover-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-discover-backdrop';
		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'sessions-discover-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', '删除项目');
		const header = append(dialog, document.createElement('div'));
		header.className = 'sessions-discover-header';
		append(header, document.createElement('span')).textContent = '删除项目';
		const body = append(dialog, document.createElement('div'));
		body.className = 'sessions-discover-body';
		body.textContent = `确定删除项目 “${projectName}” 吗?这将移除该项目及其所有会话与配置。本地代码不受影响,不会被删除。`;

		const close = (): void => {
			backdrop.remove();
			document.removeEventListener('keydown', onKey, true);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				close();
			}
		};
		document.addEventListener('keydown', onKey, true);
		backdrop.addEventListener('mousedown', event => {
			if (event.target === backdrop) {
				close();
			}
		});

		const footer = append(dialog, document.createElement('div'));
		footer.className = 'sessions-discover-footer';
		const confirmButton = append(footer, document.createElement('button')) as HTMLButtonElement;
		confirmButton.className = 'sessions-settings-btn sessions-danger-btn';
		confirmButton.type = 'button';
		confirmButton.textContent = '删除';
		confirmButton.addEventListener('click', () => {
			close();
			void service.deleteProject(projectId);
		});
		const cancelButton = append(footer, document.createElement('button')) as HTMLButtonElement;
		cancelButton.className = 'sessions-settings-btn';
		cancelButton.type = 'button';
		cancelButton.textContent = '取消';
		cancelButton.addEventListener('click', close);

		host.appendChild(backdrop);
	}

	/** Open the per-project configuration page (full-bleed settings shell). */
	private openProjectConfig(projectId: string, projectName: string): void {
		const service = this.options.environmentsService;
		if (!service || document.querySelector('.sessions-settings-dialog-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;

		function close(): void {
			document.removeEventListener('keydown', onKeyDown, true);
			view.dispose();
			view.element.remove();
		}
		const view = new ProjectConfigView(projectId, projectName, service, this.options.projectsService, close);
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				close();
			}
		};
		document.addEventListener('keydown', onKeyDown, true);
		host.appendChild(view.element);
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

		// EVERY in-progress session spins, active or not — gating this on
		// isActive made background runs invisible the moment the user switched
		// away, hiding how many sessions were still working.
		if (row.status === SessionStatus.InProgress) {
			const spinner = document.createElement('span');
			spinner.className = 'codicon codicon-loading codicon-modifier-spin sessions-project-task-spinner';
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

		if (row.onRename) {
			const rename = document.createElement('button');
			rename.className = 'sessions-project-task-action sessions-project-task-rename';
			rename.type = 'button';
			rename.title = 'Rename task';
			rename.setAttribute('aria-label', `Rename ${row.title}`);
			rename.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openRenameDialog(row);
			});
			const renameIcon = document.createElement('span');
			renameIcon.className = 'codicon codicon-edit';
			renameIcon.setAttribute('aria-hidden', 'true');
			rename.appendChild(renameIcon);
			wrapper.appendChild(rename);
		}

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

		if (row.onDelete) {
			const remove = document.createElement('button');
			remove.className = 'sessions-project-task-delete';
			remove.type = 'button';
			remove.title = 'Delete task';
			remove.setAttribute('aria-label', `Delete ${row.title}`);
			remove.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				row.onDelete?.();
			});
			const removeIcon = document.createElement('span');
			removeIcon.className = 'codicon codicon-trash';
			removeIcon.setAttribute('aria-hidden', 'true');
			remove.appendChild(removeIcon);
			wrapper.appendChild(remove);
		}

		return wrapper;
	}

	/**
	 * Rename via a small modal dialog — deliberately NOT inline editing: the
	 * row is a grid of absolutely-positioned hover actions and an author-styled
	 * main button, which inline swaps kept fighting (hidden vs display:flex,
	 * grid auto-placement). A dialog owns its layout outright.
	 */
	private openRenameDialog(row: ISessionListRow): void {
		if (document.querySelector('.sessions-rename-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;

		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-rename-backdrop';

		const dialog = document.createElement('div');
		dialog.className = 'sessions-rename-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Rename task');
		backdrop.appendChild(dialog);

		const heading = document.createElement('h3');
		heading.className = 'sessions-rename-title';
		heading.textContent = 'Rename task';
		dialog.appendChild(heading);

		const input = document.createElement('input');
		input.className = 'sessions-rename-input';
		input.value = row.title;
		input.setAttribute('aria-label', 'Task name');
		dialog.appendChild(input);

		const actions = document.createElement('div');
		actions.className = 'sessions-rename-actions';
		dialog.appendChild(actions);

		const close = (): void => backdrop.remove();
		const commit = (): void => {
			const title = input.value.trim();
			close();
			if (title !== '' && title !== row.title) {
				row.onRename?.(title);
			}
		};

		const cancel = document.createElement('button');
		cancel.className = 'sessions-settings-btn';
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', close);
		actions.appendChild(cancel);

		const save = document.createElement('button');
		save.className = 'sessions-settings-btn sessions-rename-save';
		save.type = 'button';
		save.textContent = 'Rename';
		save.addEventListener('click', commit);
		actions.appendChild(save);

		backdrop.addEventListener('mousedown', event => {
			if (event.target === backdrop) {
				close();
			}
		});
		input.addEventListener('keydown', event => {
			if (event.isComposing) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				close();
			}
		});

		host.appendChild(backdrop);
		input.focus();
		input.select();
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

	private openSettingsDialog(section: string = 'general'): void {
		const existing = document.querySelector<HTMLElement>('.sessions-settings-dialog-backdrop');
		if (existing) {
			existing.hidden = false;
			if (section !== this.settingsSection) {
				this.settingsSection = section;
				this.refreshSettingsBody();
			}
			return;
		}

		// Each fresh open lands on the requested section (General by default).
		this.settingsSection = section;
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.container;
		host.appendChild(this.renderSettingsDialog());
	}

	private renderSettingsDialog(): HTMLElement {
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-settings-dialog-backdrop';
		// Click on the scrim (outside the dialog) closes it.
		backdrop.addEventListener('click', event => {
			if (event.target === backdrop) {
				backdrop.remove();
			}
		});

		const dialog = document.createElement('div');
		dialog.className = 'sessions-settings-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Settings');
		backdrop.appendChild(dialog);

		const close = (): void => backdrop.remove();
		this.closeSettings = close;

		// Full-bleed (no header band): a transparent drag strip at the top and a
		// floating close button at the top-right; nav and content run to the edge.
		const dragStrip = document.createElement('div');
		dragStrip.className = 'sessions-settings-dragstrip';
		dialog.appendChild(dragStrip);

		const closeButton = document.createElement('button');
		closeButton.className = 'sessions-settings-close';
		closeButton.type = 'button';
		closeButton.title = 'Close';
		closeButton.setAttribute('aria-label', 'Close');
		closeButton.addEventListener('click', close);
		const closeIcon = document.createElement('span');
		closeIcon.className = 'codicon codicon-close';
		closeIcon.setAttribute('aria-hidden', 'true');
		closeButton.appendChild(closeIcon);
		dialog.appendChild(closeButton);

		const body = document.createElement('div');
		body.className = 'sessions-settings-body';
		const nav = document.createElement('nav');
		nav.className = 'sessions-settings-nav';
		nav.setAttribute('aria-label', 'Settings');
		const main = document.createElement('main');
		main.className = 'sessions-settings-main';
		this.settingsNavElement = nav;
		this.settingsMainElement = main;
		body.append(nav, main);
		dialog.appendChild(body);
		this.refreshSettingsBody();

		return backdrop;
	}

	private refreshSettingsBody(): void {
		const nav = this.settingsNavElement;
		const main = this.settingsMainElement;
		if (!nav || !main) {
			return;
		}

		clearNode(nav);
		clearNode(main);

		const back = document.createElement('button');
		back.className = 'sessions-settings-back';
		back.type = 'button';
		const backIcon = document.createElement('span');
		backIcon.className = 'codicon codicon-arrow-left';
		backIcon.setAttribute('aria-hidden', 'true');
		back.appendChild(backIcon);
		back.appendChild(document.createTextNode('Back'));
		back.addEventListener('click', () => this.closeSettings?.());
		nav.appendChild(back);

		const rows: readonly { id: string; icon: string; label: string; group: number; placeholder?: boolean }[] = [
			{ id: 'general', icon: 'codicon-settings-gear', label: 'General', group: 1 },
			{ id: 'appearance', icon: 'codicon-color-mode', label: 'Appearance', group: 1 },
			{ id: 'models', icon: 'codicon-server-environment', label: 'Models', group: 2 },
			{ id: 'agents', icon: 'codicon-extensions', label: 'Agents', group: 3, placeholder: true },
			{ id: 'skills', icon: 'codicon-lightbulb', label: 'Skills', group: 3 },
			{ id: 'mcp-servers', icon: 'codicon-server', label: 'MCP Servers', group: 3, placeholder: true },
			{ id: 'tools', icon: 'codicon-tools', label: 'Tools', group: 3, placeholder: true },
		];

		let previousGroup: number | undefined;
		for (const row of rows) {
			if (previousGroup !== undefined && row.group !== previousGroup) {
				const separator = document.createElement('div');
				separator.className = 'sessions-settings-nav-sep';
				nav.appendChild(separator);
			}
			previousGroup = row.group;

			const button = document.createElement('button');
			button.className = row.placeholder ? 'sessions-settings-nav-row sessions-settings-nav-row-placeholder' : 'sessions-settings-nav-row';
			if (row.id === this.settingsSection) {
				button.classList.add('active');
			}
			button.type = 'button';
			button.dataset.settingsNavId = row.id;
			button.addEventListener('click', () => {
				this.settingsSection = row.id;
				this.refreshSettingsBody();
			});
			const icon = document.createElement('span');
			icon.className = `codicon ${row.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			const label = document.createElement('span');
			label.textContent = row.label;
			button.appendChild(label);
			nav.appendChild(button);
		}

		main.appendChild(this.renderSettingsSection(this.settingsSection));
	}

	private renderSettingsSection(section: string): HTMLElement {
		switch (section) {
			case 'general':
				return this.renderGeneralSettings();
			case 'appearance':
				return this.renderAppearanceSettings();
			case 'models':
				return this.getModelSettingsView();
			case 'skills':
				return this.getSkillSettingsView();
			default:
				return this.renderComingSoon(section);
		}
	}

	private renderGeneralSettings(): HTMLElement {
		const page = document.createElement('div');
		page.className = 'sessions-settings-page';
		const title = page.appendChild(document.createElement('h2'));
		title.className = 'sessions-settings-page-title';
		title.textContent = 'General';

		const prefs = readPreferences();
		const card = settingsSection(page, 'Behavior');
		const motion = settingsRow(card, { title: 'Reduce motion', description: 'Minimize animations and transitions across the app.' });
		settingsToggle(motion, prefs.reduceMotion, value => updatePreferences({ reduceMotion: value }));

		return page;
	}

	private renderAppearanceSettings(): HTMLElement {
		const page = document.createElement('div');
		page.className = 'sessions-settings-page';
		const title = page.appendChild(document.createElement('h2'));
		title.className = 'sessions-settings-page-title';
		title.textContent = 'Appearance';

		const prefs = readPreferences();
		const card = settingsSection(page, 'Theme');
		const theme = settingsRow(card, { title: 'Color theme', description: 'Choose how the app looks.' });
		settingsDropdown(
			theme,
			[
				{ value: 'dark', label: 'Dark' },
				{ value: 'light', label: 'Light' },
				{ value: 'highContrast', label: 'High Contrast' },
			],
			prefs.theme,
			value => updatePreferences({ theme: value as ThemeId }),
		);

		return page;
	}

	private getModelSettingsView(): HTMLElement {
		if (!this.options.modelsService) {
			const placeholder = document.createElement('div');
			placeholder.className = 'sessions-settings-main-content';
			placeholder.textContent = 'Model management is unavailable.';
			return placeholder;
		}

		if (!this.modelSettingsView) {
			this.modelSettingsView = this._register(new ModelSettingsView(this.options.modelsService));
		}

		return this.modelSettingsView.element;
	}

	private getSkillSettingsView(): HTMLElement {
		if (!this.options.skillsService) {
			const placeholder = document.createElement('div');
			placeholder.className = 'sessions-settings-main-content';
			placeholder.textContent = 'Skill management is unavailable.';
			return placeholder;
		}

		if (!this.skillSettingsView) {
			this.skillSettingsView = this._register(new SkillSettingsView(this.options.skillsService));
		}

		return this.skillSettingsView.element;
	}

	private renderComingSoon(section: string): HTMLElement {
		const info = SETTINGS_PLACEHOLDERS[section] ?? { icon: 'codicon-circle-large-outline', title: section, description: '' };

		const content = document.createElement('div');
		content.className = 'sessions-settings-main-content';

		const empty = document.createElement('div');
		empty.className = 'sessions-settings-coming-soon';
		empty.dataset.settingsPlaceholder = section;

		const icon = document.createElement('span');
		icon.className = `codicon ${info.icon} sessions-settings-coming-soon-icon`;
		icon.setAttribute('aria-hidden', 'true');
		empty.appendChild(icon);

		const title = document.createElement('h2');
		title.textContent = info.title;
		empty.appendChild(title);

		if (info.description) {
			const description = document.createElement('p');
			description.textContent = info.description;
			empty.appendChild(description);
		}

		const badge = document.createElement('span');
		badge.className = 'sessions-settings-coming-soon-badge';
		badge.textContent = 'Coming soon';
		empty.appendChild(badge);

		content.appendChild(empty);
		return content;
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
				session.isPinned,
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

	private getMode(): WorkbenchMode | undefined {
		return this.options.sessionsPartService?.mode.get();
	}
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

/** Compact relative time for list rows: "now", "27m", "1h", "4d"; dates past a week. */
function formatTimestamp(date: Date): string {
	const diff = Date.now() - date.getTime();
	const minutes = Math.max(0, Math.floor(diff / 60000));
	if (minutes < 1) {
		return 'now';
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}

	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}

	return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
