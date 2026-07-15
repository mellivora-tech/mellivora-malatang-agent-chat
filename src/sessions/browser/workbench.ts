/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchGrid } from '../base/browser/grid.js';
import { auxiliaryBarWidthPx, editorWidthPx, panelHeightPx, sidebarWidthPx, titlebarHeightPx } from '../common/sizes.js';
import { DisposableStore, toDisposable, type IDisposable } from '../base/common/lifecycle.js';
import { registerFileSessionsProvider } from '../contrib/fileProvider/browser/fileSessions.contribution.js';
import { ServiceCollection } from '../platform/instantiation/instantiation.js';
import { applyThemeTokens } from '../platform/theme/theme.js';
import { applyUiPreferences } from './parts/settingsPrefs.js';
import type { IAgentBridge } from '../services/agent/common/agent.js';
import { ModelsService } from '../services/models/browser/modelsService.js';
import type { IModelsBridge } from '../services/models/common/models.js';
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { EditorPart } from './parts/editorPart.js';
import { PanelPart } from './parts/panelPart.js';
import { SessionsPart } from './parts/sessionsPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { TitlebarPart } from './parts/titlebarPart.js';
import type { IAppStateBridge } from '../services/appState/common/appState.js';
import { IProjectsService, ProjectsService } from '../services/projects/browser/projectsService.js';
import type { IProjectsBridge } from '../services/projects/common/projects.js';
import type { ISessionsBridge } from '../services/sessions/common/sessionsBridge.js';
import { ISessionsManagementService, SessionsManagementService } from '../services/sessions/browser/sessionsManagementService.js';
import { ISessionsPartService, SessionsPartService } from '../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, SessionsService } from '../services/sessions/browser/sessionsService.js';
import { SkillsService } from '../services/skills/browser/skillsService.js';
import type { ISkillsBridge } from '../services/skills/common/skills.js';
import { EnvironmentsService } from '../services/environments/browser/environmentsService.js';
import type { IEnvironmentsBridge } from '../services/environments/common/environments.js';

type AgentWindowGlobals = typeof globalThis & {
	readonly agentWindow?: {
		readonly platform?: NodeJS.Platform;
		readonly mockResponseDelayMs?: number;
		readonly projects?: IProjectsBridge;
		readonly sessions?: ISessionsBridge;
		readonly appState?: IAppStateBridge;
		readonly models?: IModelsBridge;
		readonly agent?: IAgentBridge;
		readonly skills?: ISkillsBridge;
		readonly environments?: IEnvironmentsBridge;
	};
};

export class Workbench {
	private readonly root = document.createElement('div');
	private readonly services = new ServiceCollection();
	private readonly projectsService = new ProjectsService((globalThis as AgentWindowGlobals).agentWindow?.projects, (globalThis as AgentWindowGlobals).agentWindow?.appState);
	private readonly modelsService = new ModelsService((globalThis as AgentWindowGlobals).agentWindow?.models);
	private readonly skillsService = new SkillsService((globalThis as AgentWindowGlobals).agentWindow?.skills);
	private readonly environmentsService = new EnvironmentsService((globalThis as AgentWindowGlobals).agentWindow?.environments);
	private readonly providersService = new SessionsProvidersService();
	private readonly managementService = new SessionsManagementService(this.providersService);
	private readonly sessionsPartService = new SessionsPartService();
	private readonly sessionsService = new SessionsService(this.managementService, this.sessionsPartService);
	private readonly titlebarPart = new TitlebarPart({
		sessionsService: this.sessionsService,
		sessionsPartService: this.sessionsPartService,
		onToggleSidebar: () => this.toggleSidebar(),
	});
	private readonly sidebarPart = new SidebarPart({
		sessionsService: this.sessionsService,
		sessionsPartService: this.sessionsPartService,
		projectsService: this.projectsService,
		modelsService: this.modelsService,
		skillsService: this.skillsService,
		environmentsService: this.environmentsService,
		onToggleSidebar: () => this.toggleSidebar(),
	});
	private readonly sessionsPart = new SessionsPart(this.sessionsService, this.projectsService, this.modelsService, this.skillsService);
	private readonly auxiliaryBarPart = new AuxiliaryBarPart({
		sessionsService: this.sessionsService,
		sessionsPartService: this.sessionsPartService,
		environmentsService: this.environmentsService,
	});
	private readonly editorPart = new EditorPart();
	private readonly panelPart = new PanelPart();
	private readonly partSubscriptions = new DisposableStore();
	private readonly agentBridge = (globalThis as AgentWindowGlobals).agentWindow?.agent;
	private readonly grid = new WorkbenchGrid(
		{
			titlebar: this.titlebarPart,
			sidebar: this.sidebarPart,
			sessions: this.sessionsPart,
			editor: this.editorPart,
			auxiliaryBar: this.auxiliaryBarPart,
			panel: this.panelPart,
		},
		{
			sidebar: true,
			sessions: true,
			editor: false,
			auxiliaryBar: true,
			panel: false,
		},
		{
			titlebarHeight: titlebarHeightPx,
			sidebarWidth: sidebarWidthPx,
			auxiliaryBarWidth: auxiliaryBarWidthPx,
			editorWidth: editorWidthPx,
			panelHeight: panelHeightPx,
		},
	);

	private resizeListener: IDisposable | undefined;
	private sidebarVisible = true;

	constructor(private readonly container: HTMLElement) {
		this.root.classList.add('monaco-workbench', 'agent-sessions-workbench', 'shell-gradient-background', `platform-${getPlatform()}`);
	}

	startup(): void {
		this.services.set(IProjectsService, this.projectsService);
		this.services.set(ISessionsProvidersService, this.providersService);
		void this.projectsService.initialize();
		void this.modelsService.initialize();
		void this.skillsService.initialize();
		this.services.set(ISessionsManagementService, this.managementService);
		this.services.set(ISessionsService, this.sessionsService);
		this.services.set(ISessionsPartService, this.sessionsPartService);
		const agentWindow = (globalThis as AgentWindowGlobals).agentWindow;
		// No sessions bridge → no provider. A silent in-memory fallback would
		// mask a broken preload; the management service reports the absence.
		if (agentWindow?.sessions) {
			const provider = registerFileSessionsProvider(
				this.providersService,
				agentWindow.sessions,
				agentWindow.mockResponseDelayMs === undefined ? {} : { responseDelayMs: agentWindow.mockResponseDelayMs },
				this.agentBridge,
				this.modelsService,
			);
			void provider.initialize();
		}

		this.container.replaceChildren(this.root);
		applyThemeTokens(this.root);
		// Re-apply persisted UI preferences (theme, reduced motion) over the default.
		applyUiPreferences();
		this.createParts();
		this.bindPartServices();
		this.installResizeListener();
		this.layout();
	}

	private createParts(): void {
		this.titlebarPart.create(this.root);
		this.sidebarPart.create(this.root);
		this.sessionsPart.create(this.root);
		this.auxiliaryBarPart.create(this.root);
		this.editorPart.create(this.root);
		this.panelPart.create(this.root);
	}

	private bindPartServices(): void {
		this.partSubscriptions.clear();
		const updateSessionsPart = () => {
			this.sessionsPart.updateVisibleSessions(this.sessionsPartService.visibleSessions.get(), this.sessionsPartService.activeSession.get());
		};
		const updateMode = () => {
			const mode = this.sessionsPartService.mode.get();
			this.root.classList.toggle('mode-new-session', mode === 'newSession');
			this.root.classList.toggle('mode-conversation', mode === 'conversation');
			this.sessionsPart.updateWorkbenchMode(mode);
			updateAuxiliaryVisibility();
		};
		const updateAuxiliaryVisibility = () => {
			const auxiliaryVisible = this.sessionsPartService.mode.get() === 'conversation' && this.sessionsPartService.sidePaneVisible.get();
			this.grid.setPartVisible('auxiliaryBar', auxiliaryVisible);
			this.root.classList.toggle('side-pane-open', auxiliaryVisible);
			this.layout();
		};

		this.partSubscriptions.add(this.sessionsPartService.visibleSessions.subscribe(updateSessionsPart));
		this.partSubscriptions.add(this.sessionsPartService.activeSession.subscribe(updateSessionsPart));
		this.partSubscriptions.add(this.sessionsPartService.mode.subscribe(updateMode));
		this.partSubscriptions.add(this.sessionsPartService.sidePaneVisible.subscribe(updateAuxiliaryVisibility));
		updateSessionsPart();
		updateMode();
	}

	private installResizeListener(): void {
		this.resizeListener?.dispose();
		const onResize = () => this.layout();
		window.addEventListener('resize', onResize);
		this.resizeListener = toDisposable(() => window.removeEventListener('resize', onResize));
	}

	private layout(): void {
		const width = this.root.clientWidth || window.innerWidth;
		const height = this.root.clientHeight || window.innerHeight;
		this.grid.layout(width, height);
		// The titlebar's drag overlay retreats from the side pane's tab strip
		// (titlebarpart.css) — keep its width current across every relayout.
		const auxWidth = this.grid.isPartVisible('auxiliaryBar') ? this.auxiliaryBarPart.element.offsetWidth : 0;
		this.root.style.setProperty('--workbench-aux-width', `${auxWidth}px`);
	}

	private toggleSidebar(): void {
		this.sidebarVisible = !this.sidebarVisible;
		this.grid.setPartVisible('sidebar', this.sidebarVisible);
		this.root.classList.toggle('sidebar-hidden', !this.sidebarVisible);
		this.layout();
	}
}

function getPlatform(): NodeJS.Platform {
	return (globalThis as AgentWindowGlobals).agentWindow?.platform ?? 'linux';
}
