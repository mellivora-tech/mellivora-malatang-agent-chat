/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchGrid } from '../base/browser/grid.js';
import { DisposableStore, toDisposable, type IDisposable } from '../base/common/lifecycle.js';
import { registerFileSessionsProvider } from '../contrib/fileProvider/browser/fileSessions.contribution.js';
import { ServiceCollection } from '../platform/instantiation/instantiation.js';
import { applyThemeTokens } from '../platform/theme/theme.js';
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { EditorPart } from './parts/editorPart.js';
import { PanelPart } from './parts/panelPart.js';
import { SessionsPart } from './parts/sessionsPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { TitlebarPart } from './parts/titlebarPart.js';
import { IProjectsService, ProjectsService } from '../services/projects/browser/projectsService.js';
import type { IProjectsBridge } from '../services/projects/common/projects.js';
import type { ISessionsBridge } from '../services/sessions/common/sessionsBridge.js';
import { ISessionsManagementService, SessionsManagementService } from '../services/sessions/browser/sessionsManagementService.js';
import { ISessionsPartService, SessionsPartService } from '../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, SessionsService } from '../services/sessions/browser/sessionsService.js';

const TITLEBAR_HEIGHT = 52;
const SIDEBAR_WIDTH = 270;
const AUXILIARY_WIDTH = 340;
const PANEL_HEIGHT = 300;
const CONTENT_MIN_WIDTH = 640;

type AgentWindowGlobals = typeof globalThis & {
	readonly agentWindow?: {
		readonly platform?: NodeJS.Platform;
		readonly mockResponseDelayMs?: number;
		readonly projects?: IProjectsBridge;
		readonly sessions?: ISessionsBridge;
	};
};

export class Workbench {
	private readonly root = document.createElement('div');
	private readonly services = new ServiceCollection();
	private readonly projectsService = new ProjectsService((globalThis as AgentWindowGlobals).agentWindow?.projects);
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
	});
	private readonly sessionsPart = new SessionsPart(this.sessionsService, this.projectsService);
	private readonly auxiliaryBarPart = new AuxiliaryBarPart({
		sessionsService: this.sessionsService,
		sessionsPartService: this.sessionsPartService,
	});
	private readonly editorPart = new EditorPart();
	private readonly panelPart = new PanelPart();
	private readonly partSubscriptions = new DisposableStore();
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
			titlebarHeight: TITLEBAR_HEIGHT,
			sidebarWidth: SIDEBAR_WIDTH,
			auxiliaryBarWidth: AUXILIARY_WIDTH,
			editorWidth: CONTENT_MIN_WIDTH,
			panelHeight: PANEL_HEIGHT,
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
		this.services.set(ISessionsManagementService, this.managementService);
		this.services.set(ISessionsService, this.sessionsService);
		this.services.set(ISessionsPartService, this.sessionsPartService);
		const agentWindow = (globalThis as AgentWindowGlobals).agentWindow;
		// No sessions bridge → no provider. A silent in-memory fallback would
		// mask a broken preload; the management service reports the absence.
		if (agentWindow?.sessions) {
			const provider = registerFileSessionsProvider(this.providersService, agentWindow.sessions, agentWindow.mockResponseDelayMs === undefined ? {} : { responseDelayMs: agentWindow.mockResponseDelayMs });
			void provider.initialize();
		}

		this.container.replaceChildren(this.root);
		applyThemeTokens(this.root);
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
			this.grid.setPartVisible('auxiliaryBar', this.sessionsPartService.mode.get() === 'conversation' && this.sessionsPartService.sidePaneVisible.get());
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
