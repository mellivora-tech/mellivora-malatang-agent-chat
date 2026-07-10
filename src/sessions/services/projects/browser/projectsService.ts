/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IAppStateBridge } from '../../appState/common/appState.js';
import type { IProject, IProjectsBridge } from '../common/projects.js';

export const IProjectsService = createDecorator<IProjectsService>('projectsService');

export interface IProjectsService {
	readonly projects: IObservable<readonly IProject[]>;
	readonly activeProject: IObservable<IProject | undefined>;
	initialize(): Promise<void>;
	setActiveProject(projectId: string): void;
	addProjectViaDialog(): Promise<IProject | undefined>;
	/** Workspace-relative file paths under the project root, for the composer's @-mention picker. Empty when unsupported. */
	listProjectFiles(projectId: string): Promise<readonly string[]>;
	/** Open the project directory in the OS file manager. */
	revealInFolder?(projectId: string): Promise<boolean>;
}

export class ProjectsService implements IProjectsService {
	private readonly projectsValue = observableValue<readonly IProject[]>([]);
	private readonly activeProjectValue = observableValue<IProject | undefined>(undefined);

	readonly projects: IObservable<readonly IProject[]> = this.projectsValue;
	readonly activeProject: IObservable<IProject | undefined> = this.activeProjectValue;

	constructor(
		private readonly bridge: IProjectsBridge | undefined,
		private readonly appState?: IAppStateBridge,
	) {}

	async initialize(): Promise<void> {
		const persisted = await this.appState?.get().catch(() => undefined);
		await this.refresh();

		const restored = persisted?.activeProjectId ? this.projectsValue.get().find(project => project.id === persisted.activeProjectId) : undefined;
		if (restored) {
			this.activeProjectValue.set(restored);
		}
	}

	setActiveProject(projectId: string): void {
		const project = this.projectsValue.get().find(candidate => candidate.id === projectId);
		if (project) {
			this.activeProjectValue.set(project);
			void this.appState?.set({ activeProjectId: project.id }).catch(error => console.error('Failed to persist the active project:', error));
		}
	}

	async listProjectFiles(projectId: string): Promise<readonly string[]> {
		if (!this.bridge?.listFiles) {
			return [];
		}
		try {
			return await this.bridge.listFiles(projectId);
		} catch (error) {
			console.warn(`Listing files failed for project ${projectId}:`, error);
			return [];
		}
	}

	async revealInFolder(projectId: string): Promise<boolean> {
		return (await this.bridge?.revealInFolder(projectId)) ?? false;
	}

	async addProjectViaDialog(): Promise<IProject | undefined> {
		if (!this.bridge) {
			return undefined;
		}

		const project = await this.bridge.pickAndCreate();
		if (!project) {
			return undefined;
		}

		await this.refresh();
		this.setActiveProject(project.id);
		return project;
	}

	private async refresh(): Promise<void> {
		if (!this.bridge) {
			return;
		}

		const projects = await this.bridge.list();
		this.projectsValue.set(projects);

		const active = this.activeProjectValue.get();
		const retained = active && projects.find(project => project.id === active.id);
		this.activeProjectValue.set(retained ?? projects[0]);
	}
}
