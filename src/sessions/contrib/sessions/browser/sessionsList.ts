/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveLocale, localize, resolveLocale, type LocalePreference } from '../../../common/i18n/i18n.js';
import { formatTimestamp } from '../../../common/relativeTime.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { append, clearNode } from '../../../base/browser/dom.js';
import { SearchPalette, type ISearchPaletteAction, type ISearchPaletteRecentChanges, type ISearchPaletteTask } from '../../search/browser/searchPalette.js';
import { ToolBar } from '../../../base/browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { ModelSettingsView } from '../../../browser/parts/modelSettingsView.js';
import { SkillSettingsView } from '../../../browser/parts/skillSettingsView.js';
import { ProjectConfigView } from '../../../browser/parts/projectConfigView.js';
import { settingsButton, settingsDropdown, settingsRow, settingsSection, settingsToggle } from '../../../browser/parts/settingsControls.js';
import { readPreferences, resolveActiveSeed, resolveActiveSlot, updatePreferences, type IAppearancePrefs } from '../../../browser/parts/settingsPrefs.js';
import { findThemePreset, presetsForPolarity } from '../../../common/themePresets.js';
import type { IThemeSeed } from '../../../common/themeSeed.js';
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
	agents: { icon: 'codicon-extensions', title: localize('settings.agents'), description: localize('settings.placeholder.agents.desc') },
	skills: { icon: 'codicon-lightbulb', title: localize('sidebar.skills'), description: localize('settings.placeholder.skills.desc') },
	'mcp-servers': { icon: 'codicon-server', title: localize('settings.mcpServers'), description: localize('settings.placeholder.mcp.desc') },
	tools: { icon: 'codicon-tools', title: localize('settings.tools'), description: localize('settings.placeholder.tools.desc') },
};

export class SessionsList extends Disposable {
	private readonly rowSubscriptions = this._register(new DisposableStore());
	private readonly collapsedSidebarSections = new Set<SidebarTreeSectionId>();
	/** Project groups the user collapsed, by projectId — the render is a full
	 *  DOM rebuild (any session's status/isRead/changesSummary change triggers
	 *  it), so collapse state must live OUTSIDE the DOM or every rebuild pops
	 *  collapsed groups back open (same family as the 5ed5bff scroll fix). */
	private readonly collapsedProjectGroups = new Set<string>();
	private settingsSection = 'general';
	private closeSettings: (() => void) | undefined;
	private settingsNavElement: HTMLElement | undefined;
	private settingsMainElement: HTMLElement | undefined;
	private modelSettingsView: ModelSettingsView | undefined;
	private skillSettingsView: SkillSettingsView | undefined;
	private readonly searchPalette: SearchPalette;
	private sidebarContentScrollTop = 0;

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
			{ id: 'new-task', label: localize('sidebar.newTask'), icon: 'codicon-add', group: 'suggested', keybinding: '⌘ N', run: () => partService?.showNewSession() },
			{ id: 'settings', label: localize('sidebar.settings'), icon: 'codicon-settings-gear', group: 'suggested', run: () => this.openSettingsDialog() },
		];
		if (this.options.onToggleSidebar) {
			actions.push({
				id: 'toggle-sidebar',
				label: localize('sidebar.toggle'),
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
		const previousContent = this.container.querySelector<HTMLElement>('.sessions-sidebar-content');
		this.sidebarContentScrollTop = previousContent?.scrollTop ?? this.sidebarContentScrollTop;
		this.container.textContent = '';

		const root = document.createElement('div');
		root.className = 'sessions-sidebar';
		this.container.appendChild(root);

		this.renderHeader(root);

		const content = document.createElement('div');
		content.className = 'sessions-sidebar-content';
		content.scrollTop = this.sidebarContentScrollTop;
		root.appendChild(content);

		const sessions = this.getSessions();
		this.renderNavigationSections(content, sessions);
		if (sessions.length > 0) {
			this.bindRows(sessions);
		}

		this.renderFooter(root);
		content.scrollTop = this.sidebarContentScrollTop;
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
				label: localize('sidebar.newTask'),
				icon: 'codicon-new-session',
				class: `sessions-sidebar-menu-action${newTaskActive ? ' active' : ''}`,
				keybinding: '⌘ N',
				tooltip: localize('sidebar.newTask'),
				run: () => this.options.sessionsPartService?.showNewSession(),
			},
			{
				id: 'sessions.sidebar.search',
				label: localize('sidebar.search'),
				icon: 'codicon-search',
				class: 'sessions-sidebar-menu-action',
				keybinding: '⌘ K',
				run: () => this.searchPalette.open(),
			},
			{
				id: 'sessions.sidebar.skills',
				label: localize('sidebar.skills'),
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
			projects.push({ id: project.id, name: project.name, count: rows.length, expanded: !this.collapsedProjectGroups.has(project.id), rows });
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
		this.renderRowsSection(container, 'chat', localize('sidebar.chat'), rows, localize('sidebar.noChats'));
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

		this.renderSidebarTreeSection(container, 'projects', localize('sidebar.projects'), browser);
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
		addTask.title = localize('sidebar.newTaskIn', project.name);
		addTask.setAttribute('aria-label', localize('sidebar.newTaskIn', project.name));
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
		more.setAttribute('aria-label', localize('sidebar.projectActions', project.name));
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
			empty.textContent = localize('sidebar.noTasks');
			rows.appendChild(empty);
		} else {
			for (const row of project.rows) {
				rows.appendChild(this.renderProjectTaskRow(row));
			}
		}

		toggle.addEventListener('click', () => {
			const expanded = toggle.getAttribute('aria-expanded') !== 'true';
			// Record the choice BEFORE touching the DOM — the widget-level Set is
			// what survives the next full rebuild; the attribute flip is just the
			// immediate visual response.
			if (expanded) {
				this.collapsedProjectGroups.delete(project.id);
			} else {
				this.collapsedProjectGroups.add(project.id);
			}
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

		addItem('codicon-settings-gear', localize('sidebar.projectConfig'), () => this.openProjectConfig(projectId, projectName));
		if (this.options.projectsService?.revealInFolder) {
			addItem('codicon-folder-opened', localize('sidebar.revealInFinder'), () => void this.options.projectsService!.revealInFolder!(projectId));
		}
		if (this.options.projectsService?.deleteProject) {
			addItem('codicon-trash', localize('sidebar.deleteProject'), () => this.confirmDeleteProject(projectId, projectName));
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
		dialog.setAttribute('aria-label', localize('sidebar.deleteProject'));
		const header = append(dialog, document.createElement('div'));
		header.className = 'sessions-discover-header';
		append(header, document.createElement('span')).textContent = localize('sidebar.deleteProject');
		const body = append(dialog, document.createElement('div'));
		body.className = 'sessions-discover-body';
		body.textContent = localize('sidebar.deleteProjectConfirm', projectName);

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
		confirmButton.textContent = localize('sidebar.delete');
		confirmButton.addEventListener('click', () => {
			close();
			void service.deleteProject(projectId);
		});
		const cancelButton = append(footer, document.createElement('button')) as HTMLButtonElement;
		cancelButton.className = 'sessions-settings-btn';
		cancelButton.type = 'button';
		cancelButton.textContent = localize('sidebar.cancel');
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
			rename.title = localize('sidebar.renameTask');
			rename.setAttribute('aria-label', localize('sidebar.renameNamed', row.title));
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
			archive.title = localize('sidebar.archiveTask');
			archive.setAttribute('aria-label', localize('sidebar.archiveNamed', row.title));
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
			remove.title = localize('sidebar.deleteTask');
			remove.setAttribute('aria-label', localize('sidebar.deleteNamed', row.title));
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
		dialog.setAttribute('aria-label', localize('sidebar.renameTask'));
		backdrop.appendChild(dialog);

		const heading = document.createElement('h3');
		heading.className = 'sessions-rename-title';
		heading.textContent = localize('sidebar.renameTask');
		dialog.appendChild(heading);

		const input = document.createElement('input');
		input.className = 'sessions-rename-input';
		input.value = row.title;
		input.setAttribute('aria-label', localize('sidebar.taskName'));
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
		cancel.textContent = localize('sidebar.cancel');
		cancel.addEventListener('click', close);
		actions.appendChild(cancel);

		const save = document.createElement('button');
		save.className = 'sessions-settings-btn sessions-rename-save';
		save.type = 'button';
		save.textContent = localize('sidebar.rename');
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
		userButton.title = localize('sidebar.account');
		userButton.setAttribute('aria-label', localize('sidebar.account'));
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
		settings.title = localize('sidebar.settings');
		settings.setAttribute('aria-label', localize('sidebar.settings'));
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
		dialog.setAttribute('aria-label', localize('settings.aria'));
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
		closeButton.title = localize('sidebar.close');
		closeButton.setAttribute('aria-label', localize('sidebar.close'));
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
		nav.setAttribute('aria-label', localize('settings.aria'));
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
		back.appendChild(document.createTextNode(localize('settings.back')));
		back.addEventListener('click', () => this.closeSettings?.());
		nav.appendChild(back);

		const rows: readonly { id: string; icon: string; label: string; group: number; placeholder?: boolean }[] = [
			{ id: 'general', icon: 'codicon-settings-gear', label: localize('settings.general'), group: 1 },
			{ id: 'appearance', icon: 'codicon-color-mode', label: localize('settings.appearance'), group: 1 },
			{ id: 'models', icon: 'codicon-server-environment', label: localize('settings.models'), group: 2 },
			{ id: 'agents', icon: 'codicon-extensions', label: localize('settings.agents'), group: 3, placeholder: true },
			{ id: 'skills', icon: 'codicon-lightbulb', label: localize('sidebar.skills'), group: 3 },
			{ id: 'mcp-servers', icon: 'codicon-server', label: localize('settings.mcpServers'), group: 3, placeholder: true },
			{ id: 'tools', icon: 'codicon-tools', label: localize('settings.tools'), group: 3, placeholder: true },
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
		title.textContent = localize('settings.general');

		const prefs = readPreferences();
		const card = settingsSection(page, localize('settings.behavior'));
		const motion = settingsRow(card, { title: localize('settings.reduceMotion'), description: localize('settings.reduceMotion.desc') });
		settingsToggle(motion, prefs.reduceMotion, value => updatePreferences({ reduceMotion: value }));

		return page;
	}

	private renderAppearanceSettings(): HTMLElement {
		const page = document.createElement('div');
		page.className = 'sessions-settings-page';
		const title = page.appendChild(document.createElement('h2'));
		title.className = 'sessions-settings-page-title';
		title.textContent = localize('settings.appearance');

		// #8 P3 (Codex-shaped): mode selector + one preset slot per polarity +
		// live seed editing for the ACTIVE slot. Everything below rebuilds from
		// prefs on each change — the card body is cheap to re-derive.
		const card = settingsSection(page, localize('settings.theme'));
		const body = card.appendChild(document.createElement('div'));

		const rebuildAppearance = (): void => {
			const prefs = readPreferences();
			const appearance = prefs.appearance;
			body.replaceChildren();

			const mode = settingsRow(body, { title: localize('appearance.mode'), description: localize('appearance.mode.desc') });
			settingsDropdown(
				mode,
				[
					{ value: 'system', label: localize('appearance.mode.system') },
					{ value: 'light', label: localize('appearance.mode.light') },
					{ value: 'dark', label: localize('appearance.mode.dark') },
				],
				appearance.mode,
				value => {
					updatePreferences({ appearance: { ...readPreferences().appearance, mode: value as IAppearancePrefs['mode'] } });
					rebuildAppearance();
				},
			);

			// One preset slot per polarity — each slot picks independently
			// (GitHub Light + Gruvbox Dark is a legal pair). The dirty state
			// (slot.seed present) tags the selected option.
			for (const polarity of ['light', 'dark'] as const) {
				const slot = appearance[polarity];
				const row = settingsRow(body, {
					title: polarity === 'light' ? localize('appearance.slot.light') : localize('appearance.slot.dark'),
					description: localize('appearance.slot.desc'),
				});
				settingsDropdown(
					row,
					presetsForPolarity(polarity).map(preset => ({
						value: preset.id,
						label: preset.id === slot.presetId && slot.seed !== undefined ? localize('appearance.modified', preset.label) : preset.label,
					})),
					slot.presetId,
					value => {
						// Picking a preset clears the slot's customization — the
						// preset IS the new seed.
						updatePreferences({ appearance: { ...readPreferences().appearance, [polarity]: { presetId: value } } });
						rebuildAppearance();
					},
				);
				const effective = slot.seed ?? findThemePreset(slot.presetId)?.seed;
				if (effective) {
					body.appendChild(renderSeedSwatch(effective));
				}
			}

			// Customize the ACTIVE slot (what the mode currently renders).
			const { polarity: activePolarity, slot: activeSlot } = resolveActiveSlot(appearance);
			const activeSeed = resolveActiveSeed(appearance);
			const writeSeed = (patch: Partial<IThemeSeed>): void => {
				const seed: IThemeSeed = { ...activeSeed, ...patch };
				updatePreferences({ appearance: { ...readPreferences().appearance, [activePolarity]: { presetId: activeSlot.presetId, seed } } });
				rebuildAppearance();
			};

			const customTitle = localize('appearance.customize', activePolarity === 'light' ? localize('appearance.mode.light') : localize('appearance.mode.dark'));
			const custom = settingsRow(body, { title: customTitle, description: localize('appearance.customize.desc') });
			custom.classList.add('sessions-appearance-colors');
			for (const [key, labelKey] of [
				['background', 'appearance.background'],
				['foreground', 'appearance.foreground'],
				['accent', 'appearance.accent'],
			] as const) {
				const wrap = custom.appendChild(document.createElement('label'));
				wrap.className = 'sessions-appearance-color';
				const caption = wrap.appendChild(document.createElement('span'));
				caption.textContent = localize(labelKey);
				const input = wrap.appendChild(document.createElement('input'));
				input.type = 'color';
				input.value = activeSeed[key];
				input.addEventListener('change', () => writeSeed({ [key]: input.value }));
			}

			const contrastRow = settingsRow(body, { title: localize('appearance.contrast'), description: localize('appearance.contrast.desc') });
			const slider = contrastRow.appendChild(document.createElement('input'));
			slider.type = 'range';
			slider.min = '0';
			slider.max = '100';
			slider.value = String(activeSeed.contrast ?? 50);
			slider.className = 'sessions-appearance-slider';
			slider.addEventListener('change', () => writeSeed({ contrast: Number(slider.value) }));

			const fontsRow = settingsRow(body, { title: localize('appearance.fonts'), description: localize('appearance.fonts.desc') });
			fontsRow.classList.add('sessions-appearance-fonts');
			for (const [key, placeholderKey] of [
				['uiFont', 'appearance.uiFont'],
				['codeFont', 'appearance.codeFont'],
			] as const) {
				const input = fontsRow.appendChild(document.createElement('input'));
				input.type = 'text';
				input.className = 'sessions-appearance-font-input';
				input.placeholder = localize(placeholderKey);
				input.value = activeSeed[key] ?? '';
				input.addEventListener('change', () => writeSeed({ [key]: input.value.trim() === '' ? undefined : input.value.trim() }));
			}

			const actionsRow = settingsRow(body, { title: localize('appearance.seed'), description: localize('appearance.seed.desc') });
			if (activeSlot.seed !== undefined) {
				settingsButton(actionsRow, localize('appearance.resetPreset'), () => {
					updatePreferences({ appearance: { ...readPreferences().appearance, [activePolarity]: { presetId: activeSlot.presetId } } });
					rebuildAppearance();
				});
			}
			const copy = settingsButton(actionsRow, localize('appearance.copySeed'), () => {
				void navigator.clipboard?.writeText(JSON.stringify(activeSeed, null, 2)).then(() => {
					copy.textContent = localize('appearance.copied');
					setTimeout(() => (copy.textContent = localize('appearance.copySeed')), 1500);
				});
			});

			const importRow = body.appendChild(document.createElement('div'));
			importRow.className = 'sessions-appearance-import';
			const importInput = importRow.appendChild(document.createElement('input'));
			importInput.type = 'text';
			importInput.placeholder = localize('appearance.importPlaceholder');
			importInput.className = 'sessions-appearance-font-input';
			settingsButton(importRow, localize('appearance.importSeed'), () => {
				try {
					const parsed = JSON.parse(importInput.value) as Partial<IThemeSeed>;
					if (typeof parsed.background !== 'string' || typeof parsed.foreground !== 'string' || typeof parsed.accent !== 'string') {
						throw new Error('missing anchors');
					}
					writeSeed(parsed as IThemeSeed);
				} catch {
					importInput.value = localize('appearance.importInvalid');
				}
			});
		};
		rebuildAppearance();

		// #9 P2: language. The active locale resolves once at module load
		// (same reload model the theme restyle effectively has), so the row's
		// description says a change applies on next launch — no silent
		// half-translated in-between state.
		const languageCard = settingsSection(page, localize('settings.language'));
		const language = settingsRow(languageCard, { title: localize('settings.language.pick'), description: localize('settings.language.desc') });
		settingsDropdown(
			language,
			[
				{ value: 'system', label: localize('settings.language.system') },
				{ value: 'zh-CN', label: '中文（简体）' },
				{ value: 'en-US', label: 'English (US)' },
			],
			readPreferences().locale,
			value => {
				const preference = value as LocalePreference;
				updatePreferences({ locale: preference });
				// Hot switch (#9 follow-up): the active locale resolves once at
				// module load, so a live renderer reload re-boots every surface
				// in the new language (~1s, VS Code's model). The unload hook
				// flushes in-flight run state first (same path as app quit).
				if (resolveLocale(preference) !== getActiveLocale()) {
					location.reload();
				}
			},
		);

		return page;
	}

	private getModelSettingsView(): HTMLElement {
		if (!this.options.modelsService) {
			const placeholder = document.createElement('div');
			placeholder.className = 'sessions-settings-main-content';
			placeholder.textContent = localize('settings.modelUnavailable');
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
			placeholder.textContent = localize('settings.skillUnavailable');
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
		badge.textContent = localize('settings.comingSoon');
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
			return localize('status.untitled');
		case SessionStatus.InProgress:
			return localize('status.inProgress');
		case SessionStatus.NeedsInput:
			return localize('status.needsInput');
		case SessionStatus.Completed:
			return localize('status.completed');
		case SessionStatus.Error:
			return localize('status.error');
	}
}

/** Compact relative time for list rows: "now", "27m", "1h", "4d"; dates past a week. */
/** Aa card + accent/status dots straight from a seed — the preview costs nothing because a preset IS its colors (#8 P3). */
function renderSeedSwatch(seed: IThemeSeed): HTMLElement {
	const strip = document.createElement('div');
	strip.className = 'sessions-appearance-swatch';
	const sample = strip.appendChild(document.createElement('span'));
	sample.className = 'sessions-appearance-swatch-sample';
	sample.style.background = seed.background;
	sample.style.color = seed.foreground;
	sample.style.borderColor = seed.accent;
	sample.textContent = 'Aa';
	for (const color of [seed.accent, seed.success, seed.danger, seed.warning].filter((value): value is string => typeof value === 'string')) {
		const dot = strip.appendChild(document.createElement('span'));
		dot.className = 'sessions-appearance-swatch-dot';
		dot.style.background = color;
	}
	return strip;
}
