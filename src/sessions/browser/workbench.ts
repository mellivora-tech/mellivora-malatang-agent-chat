/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchGrid } from '../base/browser/grid.js';
import { toDisposable, type IDisposable } from '../base/common/lifecycle.js';
import { registerMockSessionsProvider } from '../contrib/mockProvider/browser/mockSessions.contribution.js';
import { ServiceCollection } from '../platform/instantiation/instantiation.js';
import { applyThemeTokens } from '../platform/theme/theme.js';
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { EditorPart } from './parts/editorPart.js';
import { PanelPart } from './parts/panelPart.js';
import { SessionsPart } from './parts/sessionsPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { TitlebarPart } from './parts/titlebarPart.js';
import { ISessionsManagementService, SessionsManagementService } from '../services/sessions/browser/sessionsManagementService.js';
import { ISessionsPartService, SessionsPartService } from '../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, SessionsService } from '../services/sessions/browser/sessionsService.js';

const TITLEBAR_HEIGHT = 35;
const SIDEBAR_WIDTH = 300;
const AUXILIARY_WIDTH = 340;
const PANEL_HEIGHT = 300;
const CONTENT_MIN_WIDTH = 640;

export class Workbench {
	private readonly root = document.createElement('div');
	private readonly titlebarPart = new TitlebarPart();
	private readonly sidebarPart = new SidebarPart();
	private readonly sessionsPart = new SessionsPart();
	private readonly auxiliaryBarPart = new AuxiliaryBarPart();
	private readonly editorPart = new EditorPart();
	private readonly panelPart = new PanelPart();
	private readonly grid = new WorkbenchGrid(
		{
			titlebar: this.titlebarPart,
			sidebar: this.sidebarPart,
			sessions: this.sessionsPart,
			editor: this.editorPart,
			auxiliaryBar: this.auxiliaryBarPart,
			panel: this.panelPart
		},
		{
			sidebar: true,
			sessions: true,
			editor: false,
			auxiliaryBar: true,
			panel: false
		},
		{
			titlebarHeight: TITLEBAR_HEIGHT,
			sidebarWidth: SIDEBAR_WIDTH,
			auxiliaryBarWidth: AUXILIARY_WIDTH,
			editorWidth: CONTENT_MIN_WIDTH,
			panelHeight: PANEL_HEIGHT
		}
	);

	private resizeListener: IDisposable | undefined;
	private services: ServiceCollection | undefined;

	constructor(private readonly container: HTMLElement) {
		this.root.classList.add(
			'monaco-workbench',
			'agent-sessions-workbench',
			'shell-gradient-background'
		);
	}

	startup(): void {
		const services = new ServiceCollection();
		const providers = new SessionsProvidersService();
		const management = new SessionsManagementService(providers);
		const sessionsPartService = new SessionsPartService();
		const sessions = new SessionsService(management, sessionsPartService);
		services.set(ISessionsProvidersService, providers);
		services.set(ISessionsManagementService, management);
		services.set(ISessionsService, sessions);
		services.set(ISessionsPartService, sessionsPartService);
		registerMockSessionsProvider(providers);
		this.services = services;

		this.container.replaceChildren(this.root);
		applyThemeTokens(this.root);
		this.createParts();
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
}
