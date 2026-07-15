/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type {
	IDataQueryResult,
	IDataSourceInput,
	IDataSourceSecret,
	IDataSourceTestPayload,
	IDataSourceTestResult,
	IDataSourceView,
	IDatabaseSource,
	IDbTablesResult,
	IEnvironmentInput,
	IWorkspaceConfig,
	IWorkspaceConfigView,
} from '../sessions/services/environments/common/environments.js';
import { explainQueryError } from './agent/tools/dataSourceTools.js';
import { isReadOnlySql, listDbTables, runDbQuery } from './agent/dbQuery.js';
import { fakeDbRunner } from './agent/fakeDbRunner.js';
import { deleteCredential, getCredential, hasCredential, setCredential } from './credentialStorage.js';
import { getProject } from './projectsStorage.js';
import { createSafeStorageCipher } from './secretCipher.js';
import { readOrSeedWorkspaceConfig, readWorkspaceConfig, removeDataSource, removeEnvironment, upsertDataSource, upsertEnvironment, writeWorkspaceConfig } from './workspaceConfigStorage.js';

/**
 * Environment / data-source config, scoped by projectId. The main process
 * resolves the project's workspacePath and reads/writes its .mellivora config;
 * secrets go to the app credential store, never into the workspace or the view.
 */
export function registerEnvironmentsIpc(dataRoot: string): void {
	// Secrets at rest are encrypted with the OS keychain (safeStorage) when available.
	const cipher = createSafeStorageCipher();

	// E2E seam: MELLIVORA_FAKE_DB=1 swaps ONLY the database driver for a
	// deterministic in-process one — bridge, IPC, gate, and row caps stay real.
	const queryRunner = process.env['MELLIVORA_FAKE_DB'] === '1' ? fakeDbRunner : runDbQuery;

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
			dataSources.push({ ...dataSource, hasCredential: await hasCredential(dataRoot, dataSource.id, cipher) });
		}
		return { environments: config.environments, dataSources };
	};

	const emptyView: IWorkspaceConfigView = { environments: [], dataSources: [] };

	ipcMain.handle('environments:get', async (_event, projectId: string): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		return workspacePath ? toView(await readOrSeedWorkspaceConfig(workspacePath)) : emptyView;
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
				await deleteCredential(dataRoot, dataSource.id, cipher);
			}
		}
		return toView(config);
	});

	ipcMain.handle('environments:upsertDataSource', async (_event, projectId: string, input: IDataSourceInput, secret?: IDataSourceSecret): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const { config, id } = upsertDataSource(await readWorkspaceConfig(workspacePath), input);
		await writeWorkspaceConfig(workspacePath, config);
		// Credential typed alongside the connection form: store it in the same
		// call so a NEW data source never needs a second id-hunting round trip.
		// An absent/empty secret leaves any stored credential untouched.
		if (secret && hasSecretContent(secret)) {
			await setCredential(dataRoot, id, secret, cipher);
		}
		return toView(config);
	});

	ipcMain.handle('environments:removeDataSource', async (_event, projectId: string, dataSourceId: string): Promise<IWorkspaceConfigView> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return emptyView;
		}
		const config = removeDataSource(await readWorkspaceConfig(workspacePath), dataSourceId);
		await writeWorkspaceConfig(workspacePath, config);
		await deleteCredential(dataRoot, dataSourceId, cipher);
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
			await setCredential(dataRoot, dataSourceId, secret, cipher);
		}
		return toView(config);
	});

	// Connectivity test straight from the form — nothing is persisted. Database
	// drivers only (the query runner supports mysql/postgres); the credential is
	// the form-typed one, falling back to the stored secret so "test" works on a
	// saved source without retyping the password.
	ipcMain.handle('environments:testDataSource', async (_event, _projectId: string, payload: IDataSourceTestPayload): Promise<IDataSourceTestResult> => {
		const { coordinates, label } = payload;
		if (coordinates.driver !== 'mysql' && coordinates.driver !== 'postgres') {
			return { ok: false, message: `暂不支持测试 ${String(coordinates.driver)} 连接。`, durationMs: 0 };
		}
		const typed = payload.secret && hasSecretContent(payload.secret) ? payload.secret : undefined;
		const stored = !typed && payload.dataSourceId ? await getCredential(dataRoot, payload.dataSourceId, cipher) : undefined;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
		const started = Date.now();
		try {
			await runDbQuery(coordinates, typed ?? stored, 'SELECT 1', { rowLimit: 1, signal: controller.signal });
			return { ok: true, message: `连接成功（${Date.now() - started}ms）`, durationMs: Date.now() - started };
		} catch (error) {
			return { ok: false, message: explainQueryError({ label, coordinates }, error), durationMs: Date.now() - started };
		} finally {
			clearTimeout(timeout);
		}
	});

	// A saved database data source + its stored credential, or a renderable
	// error. The browse panel only ever addresses sources by id — no fuzzy
	// resolution (that's the agent tools' contract, not the UI's).
	const resolveDbSource = async (projectId: string, dataSourceId: string): Promise<{ source: IDatabaseSource; secret: IDataSourceSecret | undefined } | string> => {
		const workspacePath = await resolveWorkspace(projectId);
		if (!workspacePath) {
			return '项目没有可用的工作目录。';
		}
		const config = await readWorkspaceConfig(workspacePath);
		const source = config.dataSources.find(candidate => candidate.id === dataSourceId);
		if (!source) {
			return '数据源不存在（可能已被删除）。';
		}
		if (source.kind !== 'database') {
			return `“${source.label}” 不是数据库类型的数据源。`;
		}
		return { source, secret: await getCredential(dataRoot, dataSourceId, cipher) };
	};

	// The browse panel's query path: read-only SQL only, row-capped, per-query
	// connection. Errors return as messages (explainQueryError) — the panel's
	// status bar renders them; nothing throws across the IPC boundary.
	ipcMain.handle('environments:runQuery', async (_event, projectId: string, dataSourceId: string, sql: string, options?: { rowLimit?: number }): Promise<IDataQueryResult> => {
		const started = Date.now();
		if (typeof sql !== 'string' || !isReadOnlySql(sql)) {
			return { ok: false, message: '只允许单条只读查询（SELECT / SHOW / EXPLAIN…）。', durationMs: 0 };
		}
		const resolved = await resolveDbSource(projectId, dataSourceId);
		if (typeof resolved === 'string') {
			return { ok: false, message: resolved, durationMs: 0 };
		}
		const rowLimit = Math.max(1, Math.min(options?.rowLimit ?? DEFAULT_BROWSE_ROWS, MAX_BROWSE_ROWS));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
		try {
			const result = await queryRunner(resolved.source.coordinates, resolved.secret, sql, { rowLimit, signal: controller.signal });
			return { ok: true, columns: result.columns, rows: result.rows, truncated: result.truncated, durationMs: Date.now() - started };
		} catch (error) {
			return { ok: false, message: explainQueryError(resolved.source, error), durationMs: Date.now() - started };
		} finally {
			clearTimeout(timeout);
		}
	});

	ipcMain.handle('environments:listTables', async (_event, projectId: string, dataSourceId: string): Promise<IDbTablesResult> => {
		const resolved = await resolveDbSource(projectId, dataSourceId);
		if (typeof resolved === 'string') {
			return { ok: false, message: resolved };
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
		try {
			return { ok: true, tables: await listDbTables(resolved.source.coordinates, resolved.secret, { signal: controller.signal, runQuery: queryRunner }) };
		} catch (error) {
			return { ok: false, message: explainQueryError(resolved.source, error) };
		} finally {
			clearTimeout(timeout);
		}
	});
}

const TEST_TIMEOUT_MS = 12_000;
const QUERY_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSE_ROWS = 200;
const MAX_BROWSE_ROWS = 1000;

/** A secret counts as provided only when some field is non-empty — an untouched form must not clobber the stored credential. */
function hasSecretContent(secret: IDataSourceSecret): boolean {
	return Boolean(secret.username?.trim() || secret.password || secret.token || secret.privateKey);
}
