/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { IDataSourceInput, IDataSourceSecret, IDataSourceView, IEnvironmentInput, IWorkspaceConfig, IWorkspaceConfigView } from '../sessions/services/environments/common/environments.js';
import { deleteCredential, hasCredential, setCredential } from './credentialStorage.js';
import { getProject } from './projectsStorage.js';
import { readWorkspaceConfig, removeDataSource, removeEnvironment, upsertDataSource, upsertEnvironment, writeWorkspaceConfig } from './workspaceConfigStorage.js';

/**
 * Environment / data-source config, scoped by projectId. The main process
 * resolves the project's workspacePath and reads/writes its .mellivora config;
 * secrets go to the app credential store, never into the workspace or the view.
 */
export function registerEnvironmentsIpc(dataRoot: string): void {
	// Resolve a project's workspace dir; the config lives under it. A project
	// with neither is unusable for environments (returns undefined → empty view).
	const resolveWorkspace = async (projectId: string): Promise<string | undefined> => {
		const project = await getProject(dataRoot, projectId);
		return project?.workspacePath ?? project?.path;
	};

	// Attach hasCredential to each data source; the secret itself never crosses.
	const toView = async (config: IWorkspaceConfig): Promise<IWorkspaceConfigView> => {
		const dataSources: IDataSourceView[] = [];
		for (const dataSource of config.dataSources) {
			dataSources.push({ ...dataSource, hasCredential: await hasCredential(dataRoot, dataSource.id) });
		}
		return { environments: config.environments, dataSources };
	};

	const emptyView: IWorkspaceConfigView = { environments: [], dataSources: [] };

	ipcMain.handle('environments:get', async (_event, projectId: string): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		return workspacePath ? toView(await readWorkspaceConfig(workspacePath)) : emptyView;
	});

	ipcMain.handle('environments:upsertEnvironment', async (_event, projectId: string, input: IEnvironmentInput): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const { config } = upsertEnvironment(await readWorkspaceConfig(workspacePath), input);
		await writeWorkspaceConfig(workspacePath, config);
		return toView(config);
	});

	ipcMain.handle('environments:removeEnvironment', async (_event, projectId: string, environmentId: string): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const before = await readWorkspaceConfig(workspacePath);
		const config = removeEnvironment(before, environmentId);
		await writeWorkspaceConfig(workspacePath, config);
		// Purge credentials of data sources dropped along with the environment.
		for (const dataSource of before.dataSources) {
			if (!config.dataSources.some(kept => kept.id === dataSource.id)) {
				await deleteCredential(dataRoot, dataSource.id);
			}
		}
		return toView(config);
	});

	ipcMain.handle('environments:upsertDataSource', async (_event, projectId: string, input: IDataSourceInput): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const { config } = upsertDataSource(await readWorkspaceConfig(workspacePath), input);
		await writeWorkspaceConfig(workspacePath, config);
		return toView(config);
	});

	ipcMain.handle('environments:removeDataSource', async (_event, projectId: string, dataSourceId: string): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const config = removeDataSource(await readWorkspaceConfig(workspacePath), dataSourceId);
		await writeWorkspaceConfig(workspacePath, config);
		await deleteCredential(dataRoot, dataSourceId);
		return toView(config);
	});

	ipcMain.handle('environments:setDataSourceCredential', async (_event, projectId: string, dataSourceId: string, secret: IDataSourceSecret): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const config = await readWorkspaceConfig(workspacePath);
		// Only accept a credential for a data source that actually exists.
		if (config.dataSources.some(dataSource => dataSource.id === dataSourceId)) {
			await setCredential(dataRoot, dataSourceId, secret);
		}
		return toView(config);
	});
}
