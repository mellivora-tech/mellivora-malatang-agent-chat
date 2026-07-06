/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IProject, IProjectsBridge } from '../common/projects.js';

export const IProjectsService = createDecorator<IProjectsService>('projectsService');

export interface IProjectsService {
	readonly projects: IObservable<readonly IProject[]>;
	readonly activeProject: IObservable<IProject | undefined>;
	initialize(): Promise<void>;
	setActiveProject(projectId: string): void;
	addProjectViaDialog(): Promise<IProject | undefined>;
}

export class ProjectsService implements IProjectsService {
	private readonly projectsValue = observableValue<readonly IProject[]>([]);
	private readonly activeProjectValue = observableValue<IProject | undefined>(undefined);

	readonly projects: IObservable<readonly IProject[]> = this.projectsValue;
	readonly activeProject: IObservable<IProject | undefined> = this.activeProjectValue;

	constructor(private readonly bridge: IProjectsBridge | undefined) {}

	async initialize(): Promise<void> {
		await this.refresh();
	}

	setActiveProject(projectId: string): void {
		const project = this.projectsValue.get().find(candidate => candidate.id === projectId);
		if (project) {
			this.activeProjectValue.set(project);
		}
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
