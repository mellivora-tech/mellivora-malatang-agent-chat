/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type { IEnvironmentsService } from '../../services/environments/browser/environmentsService.js';
import { defaultPort, formatCoordinates, type IDataSource, type IDataSourceInput, type IDataSourceView, type IEnvironment, type IWorkspaceConfigView } from '../../services/environments/common/environments.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { ICodeRootView, IRemoteRepoView } from '../../services/projects/common/projects.js';
import { Dropdown } from './dropdown.js';
import { settingsButton, settingsCardGrid, settingsEmptyCard, settingsPageHeader, settingsSection } from './settingsControls.js';

/** Kinds with a sub-type get a type-card catalog (pick a type to add); others use a plain add button. */
const KIND_SUBTYPES: Partial<Record<'database' | 'redis' | 'mq' | 'nacos' | 'elasticsearch' | 'server', readonly { driver: string; title: string; description: string }[]>> = {
	database: [
		{ driver: 'mysql', title: 'MySQL', description: 'MySQL 及兼容协议(MariaDB 等)' },
		{ driver: 'postgres', title: 'PostgreSQL', description: 'PostgreSQL' },
	],
	mq: [
		{ driver: 'kafka', title: 'Kafka', description: 'Apache Kafka' },
		{ driver: 'rabbitmq', title: 'RabbitMQ', description: 'RabbitMQ' },
	],
};

const DATABASE_DRIVERS: readonly { value: string; label: string }[] = [
	{ value: 'mysql', label: 'MySQL' },
	{ value: 'postgres', label: 'PostgreSQL' },
];
const MQ_DRIVERS: readonly { value: string; label: string }[] = [
	{ value: 'kafka', label: 'Kafka' },
	{ value: 'rabbitmq', label: 'RabbitMQ' },
];

interface ICoordinateFields {
	readonly host: string;
	readonly port: number;
	readonly driver: string | undefined;
	readonly database: string;
	readonly db: number;
	readonly namespace: string;
	readonly group: string;
	readonly index: string;
	readonly user: string;
	readonly auth: string;
}

/** Assemble the per-kind coordinates object from the form fields. */
function buildCoordinates(kind: DataSourceSectionId, f: ICoordinateFields): IDataSource['coordinates'] {
	switch (kind) {
		case 'database':
			return { driver: f.driver === 'postgres' ? 'postgres' : 'mysql', host: f.host, port: f.port, database: f.database };
		case 'redis':
			return { host: f.host, port: f.port, db: f.db };
		case 'mq':
			return { driver: f.driver === 'rabbitmq' ? 'rabbitmq' : 'kafka', host: f.host, port: f.port };
		case 'nacos':
			return { host: f.host, port: f.port, namespace: f.namespace, group: f.group };
		case 'elasticsearch':
			return { host: f.host, port: f.port, index: f.index };
		case 'server':
			return { host: f.host, port: f.port, user: f.user, auth: f.auth === 'key' ? 'key' : 'password' };
	}
}

/** Left-nav sections. `env: true` sections carry the environment tab strip. */
type SectionId = 'code' | 'knowledge' | 'database' | 'redis' | 'mq' | 'nacos' | 'elasticsearch' | 'server';
/** The env-scoped section ids are exactly the connection kinds. */
type DataSourceSectionId = 'database' | 'redis' | 'mq' | 'nacos' | 'elasticsearch' | 'server';
interface ISectionDef {
	readonly id: SectionId;
	readonly icon: string;
	readonly label: string;
	readonly group: number;
	readonly env: boolean;
	readonly description: string;
	/** Not wired to real config yet — shown as a "coming soon" empty state. */
	readonly placeholder?: boolean;
}

const SECTIONS: readonly ISectionDef[] = [
	{ id: 'code', icon: 'codicon-file-code', label: '代码', group: 1, env: false, description: '代码是环境无关的,跟随项目,不随 dev/test/prod 变化。Agent 的文件工具作用于这些代码来源。' },
	{ id: 'knowledge', icon: 'codicon-book', label: '知识库', group: 1, env: false, placeholder: true, description: '把项目知识库接入 Agent。与环境无关,跟随项目。' },
	{ id: 'database', icon: 'codicon-database', label: '数据库', group: 2, env: true, description: '配置各环境下的数据库连接,供 Agent 按环境获取对应的数据。' },
	{ id: 'redis', icon: 'codicon-server', label: 'Redis', group: 2, env: true, description: '各环境的 Redis 连接。' },
	{ id: 'mq', icon: 'codicon-broadcast', label: 'MQ', group: 2, env: true, description: '各环境的消息队列连接(Kafka / RabbitMQ)。' },
	{ id: 'nacos', icon: 'codicon-settings-gear', label: 'Nacos', group: 2, env: true, description: '各环境的配置中心连接。' },
	{ id: 'elasticsearch', icon: 'codicon-search', label: 'Elasticsearch', group: 2, env: true, description: '各环境的 Elasticsearch 连接。' },
	{ id: 'server', icon: 'codicon-vm', label: '服务器', group: 2, env: true, description: '各环境的服务器(SSH),Agent 可登录执行命令。' },
];

type EditState =
	| { readonly kind: 'none' }
	| { readonly kind: 'ds'; readonly ds?: IDataSourceView; readonly driver?: string }
	| { readonly kind: 'cred'; readonly ds: IDataSourceView };

const EMPTY_VIEW: IWorkspaceConfigView = { environments: [], dataSources: [] };

/**
 * The per-project configuration page — a full-bleed settings shell (left kind
 * nav + right content), styled like the app Settings dialog: a borderless,
 * centered content column of sections, not a boxed card. Environment-scoped
 * kinds (database / redis / mq / nacos) carry a lightweight environment tab
 * strip; kind-free ones (code / knowledge) do not, matching the ops model where
 * code and knowledge are environment-independent.
 *
 * Write access is two-layered: an environment is writable (layer 1) AND the
 * data source's account is read-write (layer 2). A protected environment forces
 * its sources read-only in the UI.
 */
export class ProjectConfigView extends Disposable {
	readonly element: HTMLElement;
	/** Cleared and rebuilt each render — owns the dropdowns' popovers/listeners. */
	private readonly renderStore = this._register(new DisposableStore());
	private navElement!: HTMLElement;
	private mainElement!: HTMLElement;
	private section: SectionId = 'code';
	private activeEnvId: string | undefined;
	private config: IWorkspaceConfigView = EMPTY_VIEW;
	private codeRoots: readonly ICodeRootView[] = [];
	private remotes: readonly IRemoteRepoView[] = [];
	private edit: EditState = { kind: 'none' };
	private error: string | undefined;

	constructor(
		private readonly projectId: string,
		private readonly projectName: string,
		private readonly service: IEnvironmentsService,
		private readonly projects: IProjectsService | undefined,
		private readonly onClose: () => void,
	) {
		super();
		this.element = this.renderShell();
		void this.reload();
	}

	private renderShell(): HTMLElement {
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-settings-dialog-backdrop';

		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'sessions-settings-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', `Configuration for ${this.projectName}`);

		const dragStrip = append(dialog, document.createElement('div'));
		dragStrip.className = 'sessions-settings-dragstrip';

		const closeButton = append(dialog, document.createElement('button')) as HTMLButtonElement;
		closeButton.className = 'sessions-settings-close';
		closeButton.type = 'button';
		closeButton.title = 'Close';
		closeButton.setAttribute('aria-label', 'Close');
		append(closeButton, document.createElement('span')).className = 'codicon codicon-close';
		this._register({ dispose: () => closeButton.removeEventListener('click', this.onClose) });
		closeButton.addEventListener('click', this.onClose);

		const body = append(dialog, document.createElement('div'));
		body.className = 'sessions-settings-body';
		this.navElement = append(body, document.createElement('nav'));
		this.navElement.className = 'sessions-settings-nav';
		this.navElement.setAttribute('aria-label', 'Project configuration');
		this.mainElement = append(body, document.createElement('main'));
		this.mainElement.className = 'sessions-settings-main';

		return backdrop;
	}

	private async reload(): Promise<void> {
		this.config = await this.service.get(this.projectId);
		if (this.projects) {
			this.codeRoots = await this.projects.listCodeRoots(this.projectId);
			this.remotes = await this.projects.listRemotes(this.projectId);
		}
		this.ensureActiveEnv();
		this.render();
	}

	private async reloadCodeRoots(op: () => Promise<readonly ICodeRootView[] | undefined>): Promise<void> {
		try {
			const next = await op();
			if (next !== undefined) {
				this.codeRoots = next;
				this.error = undefined;
			}
		} catch (error) {
			this.error = cleanError(error);
		}
		this.render();
	}

	private async reloadRemotes(op: () => Promise<readonly IRemoteRepoView[]>): Promise<void> {
		try {
			this.remotes = await op();
			this.error = undefined;
		} catch (error) {
			this.error = cleanError(error);
		}
		this.render();
	}

	/** Run a mutation, adopt its returned view, drop edit state; surface errors inline. */
	private async mutate(op: () => Promise<IWorkspaceConfigView>): Promise<void> {
		try {
			this.config = await op();
			this.ensureActiveEnv();
			this.edit = { kind: 'none' };
			this.error = undefined;
		} catch (error) {
			this.error = cleanError(error);
		}
		this.render();
	}

	private ensureActiveEnv(): void {
		if (this.activeEnvId === undefined || !this.config.environments.some(environment => environment.id === this.activeEnvId)) {
			this.activeEnvId = this.config.environments[0]?.id;
		}
	}

	private render(): void {
		this.renderNav();
		this.renderMain();
	}

	private renderNav(): void {
		clearNode(this.navElement);

		const back = append(this.navElement, document.createElement('button')) as HTMLButtonElement;
		back.className = 'sessions-settings-back';
		back.type = 'button';
		const backIcon = append(back, document.createElement('span'));
		backIcon.className = 'codicon codicon-arrow-left';
		backIcon.setAttribute('aria-hidden', 'true');
		append(back, document.createElement('span')).textContent = '返回';
		back.addEventListener('click', this.onClose);

		let previousGroup: number | undefined;
		for (const section of SECTIONS) {
			if (previousGroup !== undefined && section.group !== previousGroup) {
				append(this.navElement, document.createElement('div')).className = 'sessions-settings-nav-sep';
			}
			previousGroup = section.group;

			const button = append(this.navElement, document.createElement('button')) as HTMLButtonElement;
			button.className = section.placeholder ? 'sessions-settings-nav-row sessions-settings-nav-row-placeholder' : 'sessions-settings-nav-row';
			button.classList.toggle('active', section.id === this.section);
			button.type = 'button';
			const icon = append(button, document.createElement('span'));
			icon.className = `codicon ${section.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			append(button, document.createElement('span')).textContent = section.label;
			button.addEventListener('click', () => {
				if (this.section !== section.id) {
					this.section = section.id;
					this.edit = { kind: 'none' };
					this.error = undefined;
					this.render();
				}
			});
		}
	}

	private renderMain(): void {
		// Dispose the previous render's dropdowns (popovers + document listeners)
		// before clearing their trigger nodes.
		this.renderStore.clear();
		clearNode(this.mainElement);
		const page = append(this.mainElement, document.createElement('div'));
		page.className = 'sessions-settings-page';

		const def = SECTIONS.find(section => section.id === this.section)!;
		if (def.env && this.edit.kind !== 'none') {
			this.renderEditorPage(page, def);
		} else if (def.env) {
			this.renderEnvSection(page, def);
		} else if (this.section === 'code') {
			this.renderCodeSection(page, def);
		} else {
			settingsPageHeader(page, { title: def.label, description: def.description });
			this.renderError(page);
			settingsEmptyCard(page, { title: '暂未接入知识库', description: 'Notion / 飞书 / 语雀 等连接器即将支持。' });
		}
	}

	private renderError(page: HTMLElement): void {
		if (!this.error) {
			return;
		}
		const error = append(page, document.createElement('div'));
		error.className = 'sessions-skills-error';
		error.setAttribute('role', 'alert');
		error.textContent = this.error;
	}

	// --- code (environment-independent) -----------------------------------------

	private renderCodeSection(page: HTMLElement, def: ISectionDef): void {
		settingsPageHeader(page, { title: def.label, description: def.description });
		this.renderError(page);

		const repos = this.codeRoots.filter(root => root.vcs !== undefined);
		const paths = this.codeRoots.filter(root => root.vcs === undefined);
		this.renderCodeCategory(page, {
			title: '本地仓库',
			hint: '扫描本地发现的 git / svn 仓库。',
			items: repos,
			emptyText: '尚未发现仓库。',
			...(this.projects ? { action: { label: '发现仓库', onClick: (): void => void this.openDiscover() } } : {}),
		});
		this.renderCodeCategory(page, {
			title: '代码路径',
			hint: '手动添加的本地代码目录,Agent 的文件工具作用于此。',
			items: paths,
			emptyText: '尚未添加代码路径。',
			...(this.projects ? { action: { label: '添加路径', onClick: (): void => void this.reloadCodeRoots(() => this.projects!.pickCodeRoot(this.projectId)) } } : {}),
		});
		this.renderRemoteCategory(page);
	}

	private renderRemoteCategory(page: HTMLElement): void {
		const category = append(page, document.createElement('div'));
		category.className = 'sessions-code-cat';
		const head = append(category, document.createElement('div'));
		head.className = 'sessions-code-cat-head';
		const titles = append(head, document.createElement('div'));
		titles.className = 'sessions-code-cat-titles';
		const label = append(titles, document.createElement('div'));
		label.className = 'sessions-settings-section-title';
		label.textContent = '远程仓库';
		const hint = append(titles, document.createElement('div'));
		hint.className = 'sessions-code-cat-hint';
		hint.textContent = '仓库地址,运行时自动下载代码(用系统 git 凭据)。';
		if (this.projects) {
			settingsButton(head, '添加仓库地址', () => this.openAddRemote());
		}

		if (this.remotes.length === 0) {
			const empty = append(category, document.createElement('div'));
			empty.className = 'sessions-code-empty';
			empty.textContent = '尚未添加远程仓库。';
			return;
		}
		const pills = append(category, document.createElement('div'));
		pills.className = 'sessions-code-pills';
		for (const remote of this.remotes) {
			const pill = append(pills, document.createElement('div'));
			pill.className = 'sessions-code-pill';
			pill.title = remote.url;
			const glyph = append(pill, document.createElement('span'));
			glyph.className = 'codicon codicon-cloud sessions-code-pill-icon';
			glyph.setAttribute('aria-hidden', 'true');
			append(pill, document.createElement('span')).textContent = remote.name;
			const state = append(pill, document.createElement('span'));
			state.className = `sessions-code-pill-state ${remote.cloned ? 'is-cloned' : ''}`;
			state.textContent = remote.cloned ? '已克隆' : '未克隆';
			if (this.projects) {
				const clone = append(pill, document.createElement('button')) as HTMLButtonElement;
				clone.className = 'sessions-code-pill-remove';
				clone.type = 'button';
				clone.title = remote.cloned ? '更新' : '克隆';
				clone.setAttribute('aria-label', clone.title);
				append(clone, document.createElement('span')).className = 'codicon codicon-cloud-download';
				clone.addEventListener('click', () => void this.reloadRemotes(() => this.projects!.cloneRemote(this.projectId, remote.id)));
				const remove = append(pill, document.createElement('button')) as HTMLButtonElement;
				remove.className = 'sessions-code-pill-remove';
				remove.type = 'button';
				remove.title = '移除';
				remove.setAttribute('aria-label', `移除 ${remote.name}`);
				append(remove, document.createElement('span')).className = 'codicon codicon-close';
				remove.addEventListener('click', () => void this.reloadRemotes(() => this.projects!.removeRemote(this.projectId, remote.id)));
			}
		}
	}

	/** Small modal to register a remote repo URL. */
	private openAddRemote(): void {
		if (!this.projects || document.querySelector('.sessions-discover-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.element;
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-discover-backdrop';
		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'sessions-discover-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', '添加远程仓库');
		append(append(dialog, document.createElement('div')), document.createElement('span')).textContent = '添加远程仓库';
		dialog.firstElementChild!.className = 'sessions-discover-header';

		const body = append(dialog, document.createElement('div'));
		body.className = 'sessions-discover-body';
		const form = formGrid(body);
		const urlInput = formInput(form, '仓库地址', '', { full: true, placeholder: 'https://github.com/acme/repo.git' });
		const refInput = formInput(form, '分支 / Tag(可选)', '', { full: true, placeholder: '默认分支' });

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
		settingsButton(footer, '添加', () => {
			const url = urlInput.value.trim();
			if (url === '') {
				return;
			}
			const ref = refInput.value.trim();
			// svn:// URLs are subversion; everything else defaults to git.
			const vcs = /^svn(\+ssh)?:/i.test(url) ? 'svn' : 'git';
			void this.reloadRemotes(() => this.projects!.addRemote(this.projectId, { url, vcs, ...(ref ? { ref } : {}) }));
			close();
		});
		settingsButton(footer, '取消', close);

		host.appendChild(backdrop);
		urlInput.focus();
	}

	private renderCodeCategory(page: HTMLElement, opts: { title: string; hint: string; items: readonly ICodeRootView[]; emptyText: string; action?: { label: string; onClick: () => void } }): void {
		const category = append(page, document.createElement('div'));
		category.className = 'sessions-code-cat';
		const head = append(category, document.createElement('div'));
		head.className = 'sessions-code-cat-head';
		const titles = append(head, document.createElement('div'));
		titles.className = 'sessions-code-cat-titles';
		const label = append(titles, document.createElement('div'));
		label.className = 'sessions-settings-section-title';
		label.textContent = opts.title;
		const hintEl = append(titles, document.createElement('div'));
		hintEl.className = 'sessions-code-cat-hint';
		hintEl.textContent = opts.hint;
		if (opts.action) {
			settingsButton(head, opts.action.label, opts.action.onClick);
		}

		if (opts.items.length === 0) {
			const empty = append(category, document.createElement('div'));
			empty.className = 'sessions-code-empty';
			empty.textContent = opts.emptyText;
			return;
		}
		const pills = append(category, document.createElement('div'));
		pills.className = 'sessions-code-pills';
		for (const item of opts.items) {
			const pill = append(pills, document.createElement('div'));
			pill.className = 'sessions-code-pill';
			pill.title = item.path;
			const glyph = append(pill, document.createElement('span'));
			glyph.className = `codicon ${item.vcs ? 'codicon-repo' : 'codicon-folder'} sessions-code-pill-icon`;
			glyph.setAttribute('aria-hidden', 'true');
			append(pill, document.createElement('span')).textContent = item.name;
			if (this.projects) {
				const remove = append(pill, document.createElement('button')) as HTMLButtonElement;
				remove.className = 'sessions-code-pill-remove';
				remove.type = 'button';
				remove.title = '移除';
				remove.setAttribute('aria-label', `移除 ${item.name}`);
				append(remove, document.createElement('span')).className = 'codicon codicon-close';
				remove.addEventListener('click', () => void this.reloadCodeRoots(() => this.projects!.removeCodeRoot(this.projectId, item.path)));
			}
		}
	}

	/** Scan for repos and let the user pick which to add as code roots. */
	private async openDiscover(): Promise<void> {
		if (!this.projects || document.querySelector('.sessions-discover-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.element;
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-discover-backdrop';
		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'sessions-discover-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', '发现仓库');
		const header = append(dialog, document.createElement('div'));
		header.className = 'sessions-discover-header';
		append(header, document.createElement('span')).textContent = '发现仓库';
		const body = append(dialog, document.createElement('div'));
		body.className = 'sessions-discover-body';
		body.textContent = '扫描本地仓库中…';

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
		host.appendChild(backdrop);

		let repos;
		try {
			repos = await this.projects.discoverRepos(this.projectId);
		} catch (error) {
			body.textContent = `扫描失败:${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		const existing = new Set(this.codeRoots.map(root => root.path));
		const selected = new Set<string>();
		clearNode(body);
		if (repos.length === 0) {
			body.textContent = '未发现仓库。';
		} else {
			const list = append(body, document.createElement('div'));
			list.className = 'sessions-discover-list';
			for (const repo of repos) {
				const row = append(list, document.createElement('label'));
				row.className = 'sessions-discover-item';
				const checkbox = append(row, document.createElement('input')) as HTMLInputElement;
				checkbox.type = 'checkbox';
				const added = existing.has(repo.path);
				checkbox.checked = added;
				checkbox.disabled = added;
				checkbox.addEventListener('change', () => (checkbox.checked ? selected.add(repo.path) : selected.delete(repo.path)));
				const glyph = append(row, document.createElement('span'));
				glyph.className = `codicon ${repo.vcs === 'svn' ? 'codicon-versions' : 'codicon-repo'} sessions-code-pill-icon`;
				const text = append(row, document.createElement('div'));
				text.className = 'sessions-discover-item-text';
				const name = append(text, document.createElement('div'));
				name.className = 'sessions-discover-item-name';
				name.textContent = `${repo.name}${added ? '(已添加)' : ''}`;
				const path = append(text, document.createElement('div'));
				path.className = 'sessions-discover-item-path';
				path.textContent = repo.path;
			}
		}

		const footer = append(dialog, document.createElement('div'));
		footer.className = 'sessions-discover-footer';
		settingsButton(footer, '添加所选', () => {
			void (async (): Promise<void> => {
				for (const path of selected) {
					await this.projects!.addCodeRoot(this.projectId, path);
				}
				this.codeRoots = await this.projects!.listCodeRoots(this.projectId);
				close();
				this.render();
			})();
		});
		settingsButton(footer, '取消', close);
	}

	// --- environment-scoped kinds -----------------------------------------------

	private renderEnvSection(page: HTMLElement, def: ISectionDef): void {
		const kind = def.id as DataSourceSectionId;
		const subtypes = KIND_SUBTYPES[kind];
		const environmentReady = this.config.environments.some(environment => environment.id === this.activeEnvId);
		// The per-kind "add" (only for kinds WITHOUT a sub-type) sits left of
		// "环境管理", which stays pinned to the far right on every section.
		const headerActions: { label: string; onClick: () => void }[] = [];
		if (environmentReady && !subtypes) {
			headerActions.push({ label: `添加${def.label}`, onClick: () => this.beginEdit({ kind: 'ds' }) });
		}
		headerActions.push({ label: '环境管理', onClick: () => this.openEnvManager() });
		settingsPageHeader(page, { title: def.label, description: def.description, actions: headerActions });
		this.renderError(page);

		if (this.config.environments.length === 0) {
			settingsEmptyCard(page, { title: '尚无环境', description: '新建一个环境开始(默认已内置 dev / test / prod)。', actionLabel: '新建环境', onAction: () => this.openEnvManager('new') });
			return;
		}

		const environment = this.config.environments.find(candidate => candidate.id === this.activeEnvId);

		// Master-detail: a bordered panel whose LEFT rail is the vertical list of
		// environments and whose RIGHT pane is the active environment's content.
		const panel = append(page, document.createElement('div'));
		panel.className = 'sessions-env-panel';
		const split = append(panel, document.createElement('div'));
		split.className = 'sessions-env-panel-split';

		const rail = append(split, document.createElement('div'));
		rail.className = 'sessions-env-rail';
		for (const candidate of this.config.environments) {
			const tab = append(rail, document.createElement('div'));
			tab.className = 'sessions-env-rail-tab';
			tab.setAttribute('role', 'button');
			tab.tabIndex = 0;
			tab.classList.toggle('active', candidate.id === this.activeEnvId);
			const name = append(tab, document.createElement('span'));
			name.className = 'sessions-env-rail-name';
			name.textContent = candidate.name;
			// The rail only SWITCHES the viewed environment; editing lives in the manager modal.
			const tag = append(tab, document.createElement('span'));
			tag.className = `sessions-env-rail-tag sessions-env-role ${candidate.writable ? 'role-writable' : 'role-protected'}`;
			tag.textContent = candidate.writable ? '可写' : '只读';
			const select = (): void => {
				if (this.activeEnvId !== candidate.id) {
					this.activeEnvId = candidate.id;
					this.edit = { kind: 'none' };
					this.render();
				}
			};
			tab.addEventListener('click', select);
			tab.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					select();
				}
			});
		}
		const add = append(rail, document.createElement('button')) as HTMLButtonElement;
		add.className = 'sessions-env-rail-tab sessions-env-rail-add';
		add.type = 'button';
		add.title = '新建环境';
		add.setAttribute('aria-label', '新建环境');
		append(add, document.createElement('span')).className = 'codicon codicon-add';
		append(add, document.createElement('span')).textContent = '新建环境';
		add.addEventListener('click', () => this.openEnvManager('new'));

		const right = append(split, document.createElement('div'));
		right.className = 'sessions-env-panel-right';
		const body = append(right, document.createElement('div'));
		body.className = 'sessions-env-panel-body';
		if (!environment) {
			return;
		}
		const sources = this.config.dataSources.filter(ds => ds.environmentId === environment.id && ds.kind === kind);
		if (sources.length === 0) {
			this.renderPanelEmpty(body, `${environment.name} 下还没有${def.label}`, subtypes ? `从下方选择类型添加。` : `点击右上角“添加${def.label}”新建。`);
		} else {
			for (const dataSource of sources) {
				this.renderDataSourceRow(body, environment, dataSource);
			}
		}
		if (subtypes) {
			settingsCardGrid(
				page,
				`${def.label}类型`,
				subtypes.map(type => ({
					icon: def.icon,
					title: type.title,
					description: type.description,
					onClick: () => this.beginEdit({ kind: 'ds', driver: type.driver }),
				})),
			);
		}
	}

	private renderPanelEmpty(body: HTMLElement, title: string, description?: string): void {
		const empty = append(body, document.createElement('div'));
		empty.className = 'sessions-env-panel-empty';
		const heading = append(empty, document.createElement('div'));
		heading.className = 'sessions-empty-card-title';
		heading.textContent = title;
		if (description) {
			const desc = append(empty, document.createElement('div'));
			desc.className = 'sessions-empty-card-desc';
			desc.textContent = description;
		}
	}

	/** Secondary page for an add/edit form: a back link + the form, replacing the section list. */
	private renderEditorPage(page: HTMLElement, def: ISectionDef): void {
		const back = append(page, document.createElement('button')) as HTMLButtonElement;
		back.className = 'sessions-page-back';
		back.type = 'button';
		append(back, document.createElement('span')).className = 'codicon codicon-arrow-left';
		append(back, document.createElement('span')).textContent = def.label;
		back.addEventListener('click', () => this.beginEdit({ kind: 'none' }));
		this.renderError(page);

		const environment = this.config.environments.find(candidate => candidate.id === this.activeEnvId);
		if (!environment) {
			return;
		}
		if (this.edit.kind === 'ds') {
			settingsPageHeader(page, { title: `${this.edit.ds ? '编辑' : '添加'}${def.label}` });
			this.renderDataSourceEditor(page, environment, def.id as DataSourceSectionId, this.edit.ds, this.edit.driver);
		} else if (this.edit.kind === 'cred') {
			settingsPageHeader(page, { title: '凭据', description: `${this.edit.ds.label} · ${environment.name}` });
			this.renderCredentialEditor(page, this.edit.ds);
		}
	}

	private renderDataSourceRow(card: HTMLElement, environment: IEnvironment, dataSource: IDataSourceView): void {
		const row = append(card, document.createElement('div'));
		row.className = 'sessions-settings-row';
		const text = append(row, document.createElement('div'));
		text.className = 'sessions-settings-row-text';
		const label = append(text, document.createElement('div'));
		label.className = 'sessions-settings-row-title';
		label.textContent = dataSource.label;
		const coords = append(text, document.createElement('div'));
		coords.className = 'sessions-settings-row-desc';
		coords.textContent = formatCoordinates(dataSource);

		const control = append(row, document.createElement('div'));
		control.className = 'sessions-settings-row-control';
		const badges = append(control, document.createElement('div'));
		badges.className = 'sessions-env-ds-badges';
		if (dataSource.kind !== 'server') {
			const readOnly = !environment.writable || dataSource.access === 'read-only';
			const access = append(badges, document.createElement('span'));
			access.className = `sessions-env-badge ${readOnly ? 'read-only' : 'read-write'}`;
			access.textContent = readOnly ? 'read-only' : 'read-write';
		}
		const cred = append(badges, document.createElement('span'));
		cred.className = `sessions-env-badge ${dataSource.hasCredential ? 'cred-set' : 'cred-missing'}`;
		cred.textContent = dataSource.hasCredential ? 'credential set' : 'no credential';

		settingsButton(control, '凭据', () => this.beginEdit({ kind: 'cred', ds: dataSource }));
		settingsButton(control, '编辑', () => this.beginEdit({ kind: 'ds', ds: dataSource }));
		settingsButton(control, '删除', () => void this.mutate(() => this.service.removeDataSource(this.projectId, dataSource.id)));
	}

	/**
	 * Environment management modal: left = the project's environment tabs (+ new),
	 * right = the selected environment's form (name / writability / front-end +
	 * back-end URLs) with save + delete. Environments are project-level, shared
	 * across every data-source kind.
	 */
	private openEnvManager(mode?: 'new'): void {
		if (document.querySelector('.sessions-env-manager-backdrop')) {
			return;
		}
		const host = document.querySelector<HTMLElement>('.agent-sessions-workbench') ?? this.element;
		const backdrop = document.createElement('div');
		backdrop.className = 'sessions-env-manager-backdrop';
		const dialog = append(backdrop, document.createElement('div'));
		dialog.className = 'sessions-env-manager-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', '环境管理');
		const header = append(dialog, document.createElement('div'));
		header.className = 'sessions-discover-header';
		append(header, document.createElement('span')).textContent = '环境管理';
		const split = append(dialog, document.createElement('div'));
		split.className = 'sessions-env-manager-split';
		const railEl = append(split, document.createElement('div'));
		railEl.className = 'sessions-env-manager-rail';
		const formEl = append(split, document.createElement('div'));
		formEl.className = 'sessions-env-manager-form';

		const store = new DisposableStore();
		let selectedId: string | undefined = mode === 'new' ? undefined : (this.activeEnvId ?? this.config.environments[0]?.id);

		const close = (): void => {
			store.dispose();
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

		const adopt = (view: IWorkspaceConfigView): void => {
			this.config = view;
			this.ensureActiveEnv();
			this.render();
		};

		const rebuild = (): void => {
			store.clear();
			clearNode(railEl);
			clearNode(formEl);

			for (const candidate of this.config.environments) {
				const tab = append(railEl, document.createElement('div'));
				tab.className = 'sessions-env-rail-tab';
				tab.classList.toggle('active', candidate.id === selectedId);
				tab.setAttribute('role', 'button');
				tab.tabIndex = 0;
				append(tab, document.createElement('span')).className = 'sessions-env-rail-name';
				tab.firstElementChild!.textContent = candidate.name;
				const tag = append(tab, document.createElement('span'));
				tag.className = `sessions-env-rail-tag sessions-env-role ${candidate.writable ? 'role-writable' : 'role-protected'}`;
				tag.textContent = candidate.writable ? '可写' : '只读';
				tab.addEventListener('click', () => {
					selectedId = candidate.id;
					rebuild();
				});
			}
			const addTab = append(railEl, document.createElement('button')) as HTMLButtonElement;
			addTab.className = 'sessions-env-rail-tab sessions-env-rail-add';
			addTab.type = 'button';
			addTab.classList.toggle('active', selectedId === undefined);
			append(addTab, document.createElement('span')).className = 'codicon codicon-add';
			append(addTab, document.createElement('span')).textContent = '新建环境';
			addTab.addEventListener('click', () => {
				selectedId = undefined;
				rebuild();
			});

			const environment = selectedId ? this.config.environments.find(candidate => candidate.id === selectedId) : undefined;
			const form = formGrid(formEl);
			const nameInput = formInput(form, '环境名称', environment?.name ?? '', { full: true, placeholder: '如 dev / test / prod / 预发' });
			const writableSelect = this.formSelect(
				form,
				'写权限',
				[
					{ value: 'writable', label: 'writable(允许写入)' },
					{ value: 'protected', label: 'protected(只读,如 prod)' },
				],
				environment ? (environment.writable ? 'writable' : 'protected') : 'writable',
				{ full: true },
				store,
			);
			const frontInput = formInput(form, '前端地址', environment?.frontendUrl ?? '', { full: true, placeholder: '如 https://dev.example.com' });
			const backInput = formInput(form, '后端地址', environment?.backendUrl ?? '', { full: true, placeholder: '如 https://api-dev.example.com' });

			const actions = append(formEl, document.createElement('div'));
			actions.className = 'sessions-skills-actions';
			settingsButton(actions, '保存', () => {
				void (async (): Promise<void> => {
					const view = await this.service.upsertEnvironment(this.projectId, {
						...(environment ? { id: environment.id } : {}),
						name: nameInput.value,
						writable: writableSelect.value === 'writable',
						frontendUrl: frontInput.value.trim(),
						backendUrl: backInput.value.trim(),
					});
					if (!environment) {
						selectedId = view.environments.find(candidate => !this.config.environments.some(prior => prior.id === candidate.id))?.id ?? selectedId;
					}
					adopt(view);
					rebuild();
				})();
			});
			if (environment) {
				settingsButton(actions, '删除环境', () => {
					void (async (): Promise<void> => {
						const view = await this.service.removeEnvironment(this.projectId, environment.id);
						selectedId = view.environments[0]?.id;
						adopt(view);
						rebuild();
					})();
				});
			}
			nameInput.focus();
		};

		rebuild();
		host.appendChild(backdrop);
	}

	private renderDataSourceEditor(page: HTMLElement, environment: IEnvironment, kind: DataSourceSectionId, dataSource: IDataSourceView | undefined, presetDriver?: string): void {
		const editor = append(settingsSection(page), document.createElement('div'));
		editor.className = 'sessions-skills-editor';
		const form = formGrid(editor);

		const nameInput = formInput(form, '名称', dataSource?.label ?? '', { full: true, placeholder: '留空则用 host:port' });
		const envSelect = this.formSelect(
			form,
			'环境',
			this.config.environments.map(candidate => ({ value: candidate.id, label: candidate.name })),
			dataSource?.environmentId ?? environment.id,
		);

		// Kinds with a sub-type get a driver/type select (rendered before host).
		const driverSelect =
			kind === 'database'
				? this.formSelect(form, 'Driver', DATABASE_DRIVERS, dataSource?.kind === 'database' ? dataSource.coordinates.driver : (presetDriver ?? 'mysql'))
				: kind === 'mq'
					? this.formSelect(form, '类型', MQ_DRIVERS, dataSource?.kind === 'mq' ? dataSource.coordinates.driver : (presetDriver ?? 'kafka'))
					: undefined;

		const hostInput = formInput(form, 'Host', dataSource?.coordinates.host ?? '', { placeholder: '如 localhost' });
		const portInput = formInput(form, 'Port', dataSource ? String(dataSource.coordinates.port) : '', { placeholder: String(defaultPort(kind)) });
		portInput.type = 'number';

		// Kind-specific extra fields.
		const dbInput = kind === 'database' ? formInput(form, 'Database', dataSource?.kind === 'database' ? dataSource.coordinates.database : '', { full: true, placeholder: '如 orders' }) : undefined;
		const redisDbInput = kind === 'redis' ? formInput(form, 'DB(库序号)', dataSource?.kind === 'redis' ? String(dataSource.coordinates.db) : '0', { placeholder: '0' }) : undefined;
		if (redisDbInput) {
			redisDbInput.type = 'number';
		}
		const nsInput = kind === 'nacos' ? formInput(form, 'Namespace', dataSource?.kind === 'nacos' ? dataSource.coordinates.namespace : '', { placeholder: 'public' }) : undefined;
		const groupInput = kind === 'nacos' ? formInput(form, 'Group', dataSource?.kind === 'nacos' ? dataSource.coordinates.group : '', { placeholder: 'DEFAULT_GROUP' }) : undefined;
		const indexInput = kind === 'elasticsearch' ? formInput(form, 'Index(可选)', dataSource?.kind === 'elasticsearch' ? dataSource.coordinates.index : '', { full: true, placeholder: '如 logs-*' }) : undefined;
		const userInput = kind === 'server' ? formInput(form, '用户名', dataSource?.kind === 'server' ? dataSource.coordinates.user : 'root', { placeholder: 'root' }) : undefined;
		const authSelect =
			kind === 'server'
				? this.formSelect(
						form,
						'认证方式',
						[
							{ value: 'password', label: '密码' },
							{ value: 'key', label: '私钥' },
						],
						dataSource?.kind === 'server' ? dataSource.coordinates.auth : 'password',
					)
				: undefined;

		// Servers run SSH commands (no read/write-account concept), so no access field.
		const accessSelect =
			kind === 'server'
				? undefined
				: this.formSelect(
						form,
						'账号权限',
						[
							{ value: 'read-only', label: 'read-only' },
							{ value: 'read-write', label: 'read-write' },
						],
						dataSource?.access ?? 'read-only',
						{ full: true },
					);

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, '保存', () => {
			const driver = driverSelect?.value;
			const parsedPort = Number.parseInt(portInput.value, 10);
			const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : defaultPort(kind, driver);
			const host = hostInput.value.trim();
			// Name defaults to host:port (localhost when host is blank).
			const label = nameInput.value.trim() || `${host || 'localhost'}:${port}`;
			const environmentId = envSelect.value;
			// A protected environment forces read-only regardless of the chosen access.
			const targetWritable = this.config.environments.find(candidate => candidate.id === environmentId)?.writable ?? false;
			const access = accessSelect && targetWritable && accessSelect.value === 'read-write' ? 'read-write' : 'read-only';
			const coordinates = buildCoordinates(kind, {
				host,
				port,
				driver,
				database: dbInput?.value.trim() ?? '',
				db: Number.parseInt(redisDbInput?.value ?? '0', 10) || 0,
				namespace: nsInput?.value.trim() || 'public',
				group: groupInput?.value.trim() || 'DEFAULT_GROUP',
				index: indexInput?.value.trim() ?? '',
				user: userInput?.value.trim() || 'root',
				auth: authSelect?.value ?? 'password',
			});
			const input = { ...(dataSource ? { id: dataSource.id } : {}), kind, environmentId, label, access, coordinates } as IDataSourceInput;
			void this.mutate(() => this.service.upsertDataSource(this.projectId, input));
		});
		settingsButton(actions, '取消', () => this.beginEdit({ kind: 'none' }));
		nameInput.focus();
	}

	private renderCredentialEditor(page: HTMLElement, dataSource: IDataSourceView): void {
		const editor = append(settingsSection(page), document.createElement('div'));
		editor.className = 'sessions-skills-editor';

		const isServer = dataSource.kind === 'server';
		const isKeyAuth = dataSource.kind === 'server' && dataSource.coordinates.auth === 'key';

		const heading = append(editor, document.createElement('div'));
		heading.className = 'sessions-env-cred-heading';
		heading.textContent = isServer
			? `${dataSource.label} 的 SSH 凭据 — 加密存储,不会再显示。用户名在连接里配。`
			: `${dataSource.label} 的凭据 — 加密存储,不会再显示。建议使用只读账号。`;

		const form = formGrid(editor);
		// A server's username lives in its coordinates; DB-style sources take a username here.
		const userInput = isServer ? undefined : formInput(form, '用户名', '', { full: true });
		let passInput: HTMLInputElement | undefined;
		let keyInput: HTMLTextAreaElement | undefined;
		if (isKeyAuth) {
			const field = append(form, document.createElement('label'));
			field.className = 'sessions-form-field sessions-form-field--full';
			append(field, document.createElement('span')).className = 'sessions-form-label';
			field.firstElementChild!.textContent = '私钥(PEM)';
			keyInput = append(field, document.createElement('textarea')) as HTMLTextAreaElement;
			keyInput.className = 'sessions-skills-body';
			keyInput.rows = 8;
			keyInput.placeholder = dataSource.hasCredential ? '留空则保持不变' : '-----BEGIN OPENSSH PRIVATE KEY-----';
		} else {
			passInput = formInput(form, '密码', '', { full: true, ...(dataSource.hasCredential ? { placeholder: '留空则保持不变' } : {}) });
			passInput.type = 'password';
		}

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, '保存', () =>
			void this.mutate(() =>
				this.service.setDataSourceCredential(
					this.projectId,
					dataSource.id,
					keyInput ? { privateKey: keyInput.value } : { ...(userInput ? { username: userInput.value.trim() } : {}), password: passInput?.value ?? '' },
				),
			),
		);
		if (dataSource.hasCredential) {
			settingsButton(actions, '清除', () => void this.mutate(() => this.service.setDataSourceCredential(this.projectId, dataSource.id, {})));
		}
		settingsButton(actions, '取消', () => this.beginEdit({ kind: 'none' }));
		(userInput ?? passInput ?? keyInput)?.focus();
	}

	private beginEdit(edit: EditState): void {
		this.edit = edit;
		this.error = undefined;
		this.render();
	}

	/** A themed custom dropdown as a form field; owned by the render store. */
	private formSelect(grid: HTMLElement, label: string, items: readonly { value: string; label: string }[], value: string, field: { full?: boolean; disabled?: boolean } = {}, store: DisposableStore = this.renderStore): Dropdown {
		const wrap = append(grid, document.createElement('div'));
		wrap.className = field.full ? 'sessions-form-field sessions-form-field--full' : 'sessions-form-field';
		const text = append(wrap, document.createElement('span'));
		text.className = 'sessions-form-label';
		text.textContent = label;
		const dropdown = new Dropdown({ items, value, ...(field.disabled ? { disabled: true } : {}) });
		store.add(dropdown);
		wrap.appendChild(dropdown.element);
		return dropdown;
	}
}

/** Strip Electron's "Error invoking remote method '…':" IPC wrapper so the real message shows. */
function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

/** A two-column form grid; fields default to one column, `full` spans both. */
function formGrid(parent: HTMLElement): HTMLElement {
	const grid = append(parent, document.createElement('div'));
	grid.className = 'sessions-form';
	return grid;
}

function formField(grid: HTMLElement, label: string, full: boolean | undefined): HTMLElement {
	const field = append(grid, document.createElement('label'));
	field.className = full ? 'sessions-form-field sessions-form-field--full' : 'sessions-form-field';
	const text = append(field, document.createElement('span'));
	text.className = 'sessions-form-label';
	text.textContent = label;
	return field;
}

interface IFieldOptions {
	readonly full?: boolean;
	readonly placeholder?: string;
}

function formInput(grid: HTMLElement, label: string, value: string, options: IFieldOptions = {}): HTMLInputElement {
	const input = append(formField(grid, label, options.full), document.createElement('input')) as HTMLInputElement;
	input.className = 'sessions-form-input';
	input.value = value;
	if (options.placeholder) {
		input.placeholder = options.placeholder;
	}
	return input;
}

