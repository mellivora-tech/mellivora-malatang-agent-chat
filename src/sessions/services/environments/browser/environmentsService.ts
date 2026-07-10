/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IDataSourceInput, IDataSourceSecret, IEnvironmentInput, IEnvironmentsBridge, IWorkspaceConfigView } from '../common/environments.js';

export const IEnvironmentsService = createDecorator<IEnvironmentsService>('environmentsService');

/**
 * Thin renderer-side wrapper over the environments bridge. Deliberately not an
 * observable store: every mutation returns the fresh redacted view, so the
 * config UI just re-renders from each call's result (config is edited in one
 * modal at a time, not live-shared). `available` is false when no preload
 * bridge is present (tests / degraded launches).
 */
export interface IEnvironmentsService {
	readonly available: boolean;
	get(projectId: string): Promise<IWorkspaceConfigView>;
	upsertEnvironment(projectId: string, input: IEnvironmentInput): Promise<IWorkspaceConfigView>;
	removeEnvironment(projectId: string, environmentId: string): Promise<IWorkspaceConfigView>;
	upsertDataSource(projectId: string, input: IDataSourceInput): Promise<IWorkspaceConfigView>;
	removeDataSource(projectId: string, dataSourceId: string): Promise<IWorkspaceConfigView>;
	setDataSourceCredential(projectId: string, dataSourceId: string, secret: IDataSourceSecret): Promise<IWorkspaceConfigView>;
}

const EMPTY_VIEW: IWorkspaceConfigView = { environments: [], dataSources: [] };

export class EnvironmentsService implements IEnvironmentsService {
	readonly available: boolean;

	constructor(private readonly bridge: IEnvironmentsBridge | undefined) {
		this.available = bridge !== undefined;
	}

	get(projectId: string): Promise<IWorkspaceConfigView> {
		return this.bridge?.get(projectId) ?? Promise.resolve(EMPTY_VIEW);
	}

	upsertEnvironment(projectId: string, input: IEnvironmentInput): Promise<IWorkspaceConfigView> {
		return this.bridge?.upsertEnvironment(projectId, input) ?? Promise.resolve(EMPTY_VIEW);
	}

	removeEnvironment(projectId: string, environmentId: string): Promise<IWorkspaceConfigView> {
		return this.bridge?.removeEnvironment(projectId, environmentId) ?? Promise.resolve(EMPTY_VIEW);
	}

	upsertDataSource(projectId: string, input: IDataSourceInput): Promise<IWorkspaceConfigView> {
		return this.bridge?.upsertDataSource(projectId, input) ?? Promise.resolve(EMPTY_VIEW);
	}

	removeDataSource(projectId: string, dataSourceId: string): Promise<IWorkspaceConfigView> {
		return this.bridge?.removeDataSource(projectId, dataSourceId) ?? Promise.resolve(EMPTY_VIEW);
	}

	setDataSourceCredential(projectId: string, dataSourceId: string, secret: IDataSourceSecret): Promise<IWorkspaceConfigView> {
		return this.bridge?.setDataSourceCredential(projectId, dataSourceId, secret) ?? Promise.resolve(EMPTY_VIEW);
	}
}
