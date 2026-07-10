/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	EMPTY_WORKSPACE_CONFIG,
	type DataSourceAccess,
	type DatabaseDriver,
	type EnvironmentRole,
	type IDatabaseCoordinates,
	type IDataSource,
	type IDataSourceInput,
	type IEnvironment,
	type IEnvironmentInput,
	type IWorkspaceConfig,
} from '../sessions/services/environments/common/environments.js';

/**
 * The non-secret project config lives IN the workspace so it's inspectable,
 * git-able, and travels with the project. Credentials do NOT live here — see
 * credentialStorage.ts. A missing/garbage file folds to an empty config rather
 * than throwing, so a hand-edited or absent workspace still opens.
 */

/** `.mellivora/` keeps our metadata out of the way and easy to gitignore wholesale if desired. */
export function workspaceConfigPath(workspacePath: string): string {
	return join(workspacePath, '.mellivora', 'project.json');
}

export async function readWorkspaceConfig(workspacePath: string): Promise<IWorkspaceConfig> {
	let raw: string;
	try {
		raw = await readFile(workspaceConfigPath(workspacePath), 'utf8');
	} catch {
		return EMPTY_WORKSPACE_CONFIG;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY_WORKSPACE_CONFIG;
	}
	return normalizeConfig(parsed);
}

export async function writeWorkspaceConfig(workspacePath: string, config: IWorkspaceConfig): Promise<void> {
	const file = workspaceConfigPath(workspacePath);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, `${JSON.stringify(normalizeConfig(config), undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

/** Drop malformed entries and orphan data sources (whose environment vanished); never throws. */
export function normalizeConfig(value: unknown): IWorkspaceConfig {
	if (typeof value !== 'object' || value === null) {
		return EMPTY_WORKSPACE_CONFIG;
	}
	const candidate = value as Record<string, unknown>;
	const environments = Array.isArray(candidate['environments']) ? candidate['environments'].map(parseEnvironment).filter((entry): entry is IEnvironment => entry !== undefined) : [];
	const envIds = new Set(environments.map(environment => environment.id));
	const dataSources = Array.isArray(candidate['dataSources'])
		? candidate['dataSources'].map(parseDataSource).filter((entry): entry is IDataSource => entry !== undefined && envIds.has(entry.environmentId))
		: [];
	return { version: 1, environments, dataSources };
}

function parseEnvironment(value: unknown): IEnvironment | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate['id'] !== 'string' || typeof candidate['name'] !== 'string') {
		return undefined;
	}
	return { id: candidate['id'], name: candidate['name'], role: asRole(candidate['role']) };
}

function parseDataSource(value: unknown): IDataSource | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate['id'] !== 'string' || typeof candidate['environmentId'] !== 'string' || typeof candidate['label'] !== 'string') {
		return undefined;
	}
	// MVP: 'database' is the only kind; anything else is skipped rather than trusted.
	if (candidate['kind'] !== 'database') {
		return undefined;
	}
	const coordinates = parseDatabaseCoordinates(candidate['coordinates']);
	if (!coordinates) {
		return undefined;
	}
	return {
		id: candidate['id'],
		environmentId: candidate['environmentId'],
		kind: 'database',
		label: candidate['label'],
		access: candidate['access'] === 'read-write' ? 'read-write' : 'read-only',
		coordinates,
	};
}

function parseDatabaseCoordinates(value: unknown): IDatabaseCoordinates | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const driver: DatabaseDriver | undefined = candidate['driver'] === 'mysql' ? 'mysql' : candidate['driver'] === 'postgres' ? 'postgres' : undefined;
	if (!driver || typeof candidate['host'] !== 'string' || typeof candidate['database'] !== 'string') {
		return undefined;
	}
	const port = typeof candidate['port'] === 'number' && Number.isFinite(candidate['port']) ? candidate['port'] : driver === 'mysql' ? 3306 : 5432;
	return { driver, host: candidate['host'], port, database: candidate['database'] };
}

function asRole(value: unknown): EnvironmentRole {
	return value === 'baseline' || value === 'target' || value === 'other' ? value : 'other';
}

// --- Pure mutators (unit-tested; IPC = read → mutate → write) --------------------

/** Insert or update an environment; a new one gets a fresh id. Returns [config, id]. */
export function upsertEnvironment(config: IWorkspaceConfig, input: IEnvironmentInput): { readonly config: IWorkspaceConfig; readonly id: string } {
	const id = input.id ?? `env-${randomUUID().slice(0, 8)}`;
	const entry: IEnvironment = { id, name: input.name.trim() || 'environment', role: input.role };
	const exists = config.environments.some(environment => environment.id === id);
	const environments = exists ? config.environments.map(environment => (environment.id === id ? entry : environment)) : [...config.environments, entry];
	return { config: normalizeConfig({ ...config, environments }), id };
}

/** Remove an environment and (via normalizeConfig) any data sources orphaned by it. */
export function removeEnvironment(config: IWorkspaceConfig, environmentId: string): IWorkspaceConfig {
	return normalizeConfig({ ...config, environments: config.environments.filter(environment => environment.id !== environmentId) });
}

/** Insert or update a database data source; a new one gets a fresh id. Returns [config, id]. Throws if the target environment is unknown. */
export function upsertDataSource(config: IWorkspaceConfig, input: IDataSourceInput): { readonly config: IWorkspaceConfig; readonly id: string } {
	if (!config.environments.some(environment => environment.id === input.environmentId)) {
		throw new Error(`Unknown environment: ${input.environmentId}`);
	}
	const id = input.id ?? `ds-${randomUUID().slice(0, 8)}`;
	const entry: IDataSource = {
		id,
		environmentId: input.environmentId,
		kind: 'database',
		label: input.label.trim() || 'data source',
		access: input.access === 'read-write' ? 'read-write' : 'read-only',
		coordinates: input.coordinates,
	};
	const exists = config.dataSources.some(dataSource => dataSource.id === id);
	const dataSources = exists ? config.dataSources.map(dataSource => (dataSource.id === id ? entry : dataSource)) : [...config.dataSources, entry];
	return { config: normalizeConfig({ ...config, dataSources }), id };
}

export function removeDataSource(config: IWorkspaceConfig, dataSourceId: string): IWorkspaceConfig {
	return normalizeConfig({ ...config, dataSources: config.dataSources.filter(dataSource => dataSource.id !== dataSourceId) });
}

// Re-export for callers building configs (kept here so the storage module is the one import site).
export type { DataSourceAccess };
