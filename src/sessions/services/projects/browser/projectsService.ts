/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IAppStateBridge } from '../../appState/common/appState.js';
import type { ICodeRootView, IDiscoveredRepo, IProject, IProjectsBridge, IRemoteRepoInput, IRemoteRepoView } from '../common/projects.js';

export const IProjectsService = createDecorator<IProjectsService>('projectsService');

export interface IProjectsService {
	readonly projects: IObservable<readonly IProject[]>;
	readonly activeProject: IObservable<IProject | undefined>;
	initialize(): Promise<void>;
	setActiveProject(projectId: string): void;
	addProjectViaDialog(): Promise<IProject | undefined>;
	/** Delete a project and refresh the list. */
	deleteProject(projectId: string): Promise<void>;
	/** Workspace-relative file paths under the project root, for the composer's @-mention picker. Empty when unsupported. */
	listProjectFiles(projectId: string): Promise<readonly string[]>;
	/** Open the project directory in the OS file manager. */
	revealInFolder?(projectId: string): Promise<boolean>;
	/** The project's tracked code roots, annotated with detected VCS. */
	listCodeRoots(projectId: string): Promise<readonly ICodeRootView[]>;
	/** Scan for git/svn repos to offer as code roots (defaults to the user's home). */
	discoverRepos(projectId: string, scanRoot?: string): Promise<readonly IDiscoveredRepo[]>;
	addCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]>;
	removeCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]>;
	/** Folder-picker add; resolves to undefined if the user cancels. */
	pickCodeRoot(projectId: string): Promise<readonly ICodeRootView[] | undefined>;
	listRemotes(projectId: string): Promise<readonly IRemoteRepoView[]>;
	listApprovalAllowlist(projectId: string): Promise<readonly string[]>;
	removeApprovalAllowPattern(projectId: string, pattern: string): Promise<readonly string[]>;
	addRemote(projectId: string, input: IRemoteRepoInput): Promise<readonly IRemoteRepoView[]>;
	removeRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]>;
	cloneRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]>;
}

import { reportFailure } from '../../../common/diagnostics.js';
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
			void this.appState?.set({ activeProjectId: project.id }).catch(error => reportFailure('projects.persistActiveProject', error));
		}
	}

	async listProjectFiles(projectId: string): Promise<readonly string[]> {
		if (!this.bridge?.listFiles) {
			return [];
		}
		try {
			return await this.bridge.listFiles(projectId);
		} catch (error) {
			reportFailure('projects.listFiles', error);
			return [];
		}
	}

	async revealInFolder(projectId: string): Promise<boolean> {
		return (await this.bridge?.revealInFolder(projectId)) ?? false;
	}

	async listCodeRoots(projectId: string): Promise<readonly ICodeRootView[]> {
		return (await this.bridge?.listCodeRoots(projectId)) ?? [];
	}

	async discoverRepos(projectId: string, scanRoot?: string): Promise<readonly IDiscoveredRepo[]> {
		return (await this.bridge?.discoverRepos(projectId, scanRoot)) ?? [];
	}

	async addCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]> {
		const roots = (await this.bridge?.addCodeRoot(projectId, path)) ?? [];
		await this.refresh();
		return roots;
	}

	async removeCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]> {
		const roots = (await this.bridge?.removeCodeRoot(projectId, path)) ?? [];
		await this.refresh();
		return roots;
	}

	async pickCodeRoot(projectId: string): Promise<readonly ICodeRootView[] | undefined> {
		const roots = await this.bridge?.pickCodeRoot(projectId);
		if (roots) {
			await this.refresh();
		}
		return roots;
	}

	async listRemotes(projectId: string): Promise<readonly IRemoteRepoView[]> {
		return (await this.bridge?.listRemotes(projectId)) ?? [];
	}

	async listApprovalAllowlist(projectId: string): Promise<readonly string[]> {
		return (await this.bridge?.listApprovalAllowlist(projectId)) ?? [];
	}

	async removeApprovalAllowPattern(projectId: string, pattern: string): Promise<readonly string[]> {
		return (await this.bridge?.removeApprovalAllowPattern(projectId, pattern)) ?? [];
	}

	async addRemote(projectId: string, input: IRemoteRepoInput): Promise<readonly IRemoteRepoView[]> {
		return (await this.bridge?.addRemote(projectId, input)) ?? [];
	}

	async removeRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]> {
		return (await this.bridge?.removeRemote(projectId, remoteId)) ?? [];
	}

	async cloneRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]> {
		return (await this.bridge?.cloneRemote(projectId, remoteId)) ?? [];
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

	async deleteProject(projectId: string): Promise<void> {
		if (!this.bridge) {
			return;
		}
		await this.bridge.deleteProject(projectId);
		await this.refresh();
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
