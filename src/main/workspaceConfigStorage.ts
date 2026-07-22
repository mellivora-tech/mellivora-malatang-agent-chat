/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	EMPTY_WORKSPACE_CONFIG,
	SEED_ENVIRONMENTS,
	defaultPort,
	type DataSourceAccess,
	type IDataSource,
	type IDataSourceInput,
	type IEnvironment,
	type IEnvironmentInput,
	type IWorkspaceConfig,
} from '../sessions/services/environments/common/environments.js';
import { reportStorageDegraded } from './storageDiagnostics.js';

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
	} catch (error) {
		// Degrading to empty here removes every environment and data source — the
		// agent then silently loses its query tools and the UI shows nothing configured.
		reportStorageDegraded('workspaceConfig', 'unparseable', {
			path: workspaceConfigPath(workspacePath),
			message: error instanceof Error ? error.message : String(error),
		});
		return EMPTY_WORKSPACE_CONFIG;
	}
	return normalizeConfig(parsed);
}

/**
 * Read the config, seeding dev/test/prod on FIRST touch (the config file does not
 * exist yet) and persisting the seed so it's stable. A file that exists but has
 * zero environments is respected as-is — the user deleted them; we never re-seed.
 */
export async function readOrSeedWorkspaceConfig(workspacePath: string): Promise<IWorkspaceConfig> {
	try {
		await readFile(workspaceConfigPath(workspacePath), 'utf8');
	} catch {
		const seeded: IWorkspaceConfig = { version: 1, environments: [...SEED_ENVIRONMENTS], dataSources: [] };
		await writeWorkspaceConfig(workspacePath, seeded);
		return seeded;
	}
	return readWorkspaceConfig(workspacePath);
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
	const environments = Array.isArray(candidate['environments'])
		? candidate['environments'].map(parseEnvironment).filter((entry): entry is IEnvironment => entry !== undefined)
		: [];
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
	const frontendUrl = typeof candidate['frontendUrl'] === 'string' && candidate['frontendUrl'].length > 0 ? candidate['frontendUrl'] : undefined;
	const backendUrl = typeof candidate['backendUrl'] === 'string' && candidate['backendUrl'].length > 0 ? candidate['backendUrl'] : undefined;
	return {
		id: candidate['id'],
		name: candidate['name'],
		writable: asWritable(candidate),
		...(frontendUrl ? { frontendUrl } : {}),
		...(backendUrl ? { backendUrl } : {}),
	};
}

function parseDataSource(value: unknown): IDataSource | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate['id'] !== 'string' || typeof candidate['environmentId'] !== 'string' || typeof candidate['label'] !== 'string') {
		return undefined;
	}
	const parsed = parseCoordinates(candidate['kind'], candidate['coordinates']);
	if (!parsed) {
		return undefined;
	}
	return {
		id: candidate['id'],
		environmentId: candidate['environmentId'],
		label: candidate['label'],
		access: candidate['access'] === 'read-write' ? 'read-write' : 'read-only',
		...parsed,
	} as IDataSource;
}

/** Per-kind coordinate parsing. host is required; kind-specific fields default. Unknown kinds are dropped. */
function parseCoordinates(kind: unknown, value: unknown): Pick<IDataSource, 'kind' | 'coordinates'> | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const c = value as Record<string, unknown>;
	if (typeof c['host'] !== 'string' || c['host'].length === 0) {
		return undefined;
	}
	const host = c['host'];
	const int = (key: string, fallback: number): number => (typeof c[key] === 'number' && Number.isFinite(c[key]) ? (c[key] as number) : fallback);
	const str = (key: string, fallback: string): string => (typeof c[key] === 'string' ? (c[key] as string) : fallback);

	switch (kind) {
		case 'database': {
			if (typeof c['database'] !== 'string') {
				return undefined;
			}
			const driver = c['driver'] === 'postgres' ? 'postgres' : 'mysql';
			return { kind: 'database', coordinates: { driver, host, port: int('port', defaultPort('database', driver)), database: c['database'] } };
		}
		case 'redis':
			return { kind: 'redis', coordinates: { host, port: int('port', defaultPort('redis')), db: int('db', 0) } };
		case 'mq': {
			const driver = c['driver'] === 'rabbitmq' ? 'rabbitmq' : 'kafka';
			return { kind: 'mq', coordinates: { driver, host, port: int('port', defaultPort('mq', driver)) } };
		}
		case 'nacos':
			return { kind: 'nacos', coordinates: { host, port: int('port', defaultPort('nacos')), namespace: str('namespace', 'public'), group: str('group', 'DEFAULT_GROUP') } };
		case 'elasticsearch':
			return { kind: 'elasticsearch', coordinates: { host, port: int('port', defaultPort('elasticsearch')), index: str('index', '') } };
		case 'server':
			return { kind: 'server', coordinates: { host, port: int('port', defaultPort('server')), user: str('user', ''), auth: c['auth'] === 'key' ? 'key' : 'password' } };
		default:
			return undefined;
	}
}

/**
 * Layer-1 writability. Prefer an explicit `writable`; else migrate the legacy
 * `role` (a 'target'/prod environment was forced read-only ⇒ not writable).
 * Default writable when neither is present.
 */
function asWritable(candidate: Record<string, unknown>): boolean {
	if (typeof candidate['writable'] === 'boolean') {
		return candidate['writable'];
	}
	return candidate['role'] !== 'target';
}

// --- Pure mutators (unit-tested; IPC = read → mutate → write) --------------------

/** Insert or update an environment; a new one gets a fresh id. Returns [config, id]. */
export function upsertEnvironment(config: IWorkspaceConfig, input: IEnvironmentInput): { readonly config: IWorkspaceConfig; readonly id: string } {
	const id = input.id ?? `env-${randomUUID().slice(0, 8)}`;
	const frontendUrl = input.frontendUrl?.trim();
	const backendUrl = input.backendUrl?.trim();
	const entry: IEnvironment = {
		id,
		name: input.name.trim() || 'environment',
		writable: input.writable,
		...(frontendUrl ? { frontendUrl } : {}),
		...(backendUrl ? { backendUrl } : {}),
	};
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
	const entry = {
		...input,
		id,
		label: input.label.trim() || 'data source',
		access: input.access === 'read-write' ? 'read-write' : 'read-only',
	} as IDataSource;
	const exists = config.dataSources.some(dataSource => dataSource.id === id);
	const dataSources = exists ? config.dataSources.map(dataSource => (dataSource.id === id ? entry : dataSource)) : [...config.dataSources, entry];
	return { config: normalizeConfig({ ...config, dataSources }), id };
}

export function removeDataSource(config: IWorkspaceConfig, dataSourceId: string): IWorkspaceConfig {
	return normalizeConfig({ ...config, dataSources: config.dataSources.filter(dataSource => dataSource.id !== dataSourceId) });
}

// Re-export for callers building configs (kept here so the storage module is the one import site).
export type { DataSourceAccess };
