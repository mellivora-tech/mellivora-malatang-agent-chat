/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Environment / data-source contracts for the "system project" model.
 *
 * dev/prod is a dimension of the DATA layer ONLY — code and the project
 * knowledge base are environment-independent (see project-ops model). An
 * environment is a named runtime instance (dev/prod/…); a data source is a
 * connection to that instance's DB / (later) config-center / redis. The ops
 * "killer feature" is diffing the same logical data source (paired by `label`)
 * across a baseline environment and a target one.
 *
 * STORAGE SPLIT — this file's shapes are the NON-SECRET config that lives in
 * the workspace (`<workspacePath>/.mellivora/project.json`, shareable/git-able).
 * Credentials never appear here: they live in the app's credential store keyed
 * by data-source id and are never sent to the renderer (only `hasCredential`
 * crosses, in the *View types).
 */

/** The connection kinds an environment can hold. Each carries its own coordinates shape. */
export type DataSourceKind = 'database' | 'redis' | 'mq' | 'nacos' | 'elasticsearch' | 'server';

export type DatabaseDriver = 'mysql' | 'postgres';
export type MqDriver = 'kafka' | 'rabbitmq';
/** How the agent authenticates the SSH connection to a server. */
export type ServerAuth = 'password' | 'key';

/**
 * The account's DECLARED permission — layer 2 of the two-layer write control.
 * Layer 1 is {@link IEnvironment.writable} (the app-side guardrail); layer 2 is
 * the reality of the account you configure (a read-only DB grant). A write only
 * happens when BOTH allow it. This field records the intent for layer 2; the
 * grant itself is out-of-band and the app cannot verify it.
 */
export type DataSourceAccess = 'read-only' | 'read-write';

/** Every coordinates variant carries host + port; kind-specific fields extend it. */
export interface ICoordinatesBase {
	readonly host: string;
	readonly port: number;
}
export interface IDatabaseCoordinates extends ICoordinatesBase {
	readonly driver: DatabaseDriver;
	readonly database: string;
}
export interface IRedisCoordinates extends ICoordinatesBase {
	readonly db: number;
}
export interface IMqCoordinates extends ICoordinatesBase {
	readonly driver: MqDriver;
}
export interface INacosCoordinates extends ICoordinatesBase {
	readonly namespace: string;
	readonly group: string;
}
export interface IElasticsearchCoordinates extends ICoordinatesBase {
	readonly index: string;
}
export interface IServerCoordinates extends ICoordinatesBase {
	readonly user: string;
	readonly auth: ServerAuth;
}

/** The default port for a kind (used when the user leaves Port blank). */
export function defaultPort(kind: DataSourceKind, driver?: string): number {
	switch (kind) {
		case 'database':
			return driver === 'postgres' ? 5432 : 3306;
		case 'redis':
			return 6379;
		case 'mq':
			return driver === 'rabbitmq' ? 5672 : 9092;
		case 'nacos':
			return 8848;
		case 'elasticsearch':
			return 9200;
		case 'server':
			return 22;
	}
}

/** A one-line coordinates summary for the data-source row. */
export function formatCoordinates(source: IDataSource): string {
	switch (source.kind) {
		case 'database':
			return `${source.coordinates.driver} · ${source.coordinates.host}:${source.coordinates.port}/${source.coordinates.database}`;
		case 'redis':
			return `${source.coordinates.host}:${source.coordinates.port} · db${source.coordinates.db}`;
		case 'mq':
			return `${source.coordinates.driver} · ${source.coordinates.host}:${source.coordinates.port}`;
		case 'nacos':
			return `${source.coordinates.host}:${source.coordinates.port} · ${source.coordinates.namespace}/${source.coordinates.group}`;
		case 'elasticsearch':
			return `${source.coordinates.host}:${source.coordinates.port}${source.coordinates.index ? `/${source.coordinates.index}` : ''}`;
		case 'server':
			return `${source.coordinates.user}@${source.coordinates.host}:${source.coordinates.port} · ${source.coordinates.auth === 'key' ? '密钥' : '密码'}`;
	}
}

/**
 * A named runtime instance of the project's system (dev / test / prod / …). Owns
 * nothing but its identity + writability; data sources reference it.
 *
 * `writable` is LAYER 1 of the write control — the app-side guardrail declared
 * when the environment is created. Seeds: dev/test writable, prod NOT. Names are
 * team-customizable, so protection is an explicit flag here, never inferred from
 * the name.
 */
export interface IEnvironment {
	readonly id: string;
	readonly name: string;
	readonly writable: boolean;
	/** The environment's front-end page URL (e.g. the web UI). */
	readonly frontendUrl?: string;
	/** The environment's back-end service URL (e.g. the API / gateway). */
	readonly backendUrl?: string;
}

/**
 * Every project starts with these three; all are fully editable (rename / delete /
 * add more) — they are seed data, not fixed constants. Stable ids so data sources
 * seeded alongside them stay referentially valid.
 */
export const SEED_ENVIRONMENTS: readonly IEnvironment[] = [
	{ id: 'env-dev', name: 'dev', writable: true },
	{ id: 'env-test', name: 'test', writable: true },
	{ id: 'env-prod', name: 'prod', writable: false },
];

/** Fields common to every data source (a connection definition, NO credential). */
export interface IDataSourceBase {
	readonly id: string;
	readonly environmentId: string;
	readonly label: string;
	readonly access: DataSourceAccess;
}
export interface IDatabaseSource extends IDataSourceBase {
	readonly kind: 'database';
	readonly coordinates: IDatabaseCoordinates;
}
export interface IRedisSource extends IDataSourceBase {
	readonly kind: 'redis';
	readonly coordinates: IRedisCoordinates;
}
export interface IMqSource extends IDataSourceBase {
	readonly kind: 'mq';
	readonly coordinates: IMqCoordinates;
}
export interface INacosSource extends IDataSourceBase {
	readonly kind: 'nacos';
	readonly coordinates: INacosCoordinates;
}
export interface IElasticsearchSource extends IDataSourceBase {
	readonly kind: 'elasticsearch';
	readonly coordinates: IElasticsearchCoordinates;
}
export interface IServerSource extends IDataSourceBase {
	readonly kind: 'server';
	readonly coordinates: IServerCoordinates;
}
/** A connection definition, discriminated by `kind`. */
export type IDataSource = IDatabaseSource | IRedisSource | IMqSource | INacosSource | IElasticsearchSource | IServerSource;

/** Distributes Omit over a union so the `kind`→`coordinates` correlation survives. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The shareable, non-secret project config persisted inside the workspace. */
export interface IWorkspaceConfig {
	readonly version: 1;
	readonly environments: readonly IEnvironment[];
	readonly dataSources: readonly IDataSource[];
}

export const EMPTY_WORKSPACE_CONFIG: IWorkspaceConfig = { version: 1, environments: [], dataSources: [] };

/** Secret half — main-process only, keyed by data-source id, never serialized into the workspace. */
export interface IDataSourceSecret {
	readonly username?: string;
	readonly password?: string;
	readonly token?: string;
	/** SSH private key (PEM) for a server connection using key auth. */
	readonly privateKey?: string;
}

/** The redacted data-source the renderer sees: definition + whether a secret is on file (never the secret). */
export type IDataSourceView = IDataSource & { readonly hasCredential: boolean };

/** The redacted project config the renderer sees (data sources carry hasCredential, never secrets). */
export interface IWorkspaceConfigView {
	readonly environments: readonly IEnvironment[];
	readonly dataSources: readonly IDataSourceView[];
}

/** Upsert payload for an environment; absent id ⇒ create. */
export interface IEnvironmentInput {
	readonly id?: string;
	readonly name: string;
	readonly writable: boolean;
	readonly frontendUrl?: string;
	readonly backendUrl?: string;
}

/** Upsert payload for a data source (same shape as {@link IDataSource} but id optional). Credentials go via {@link IDataSourceSecret}, never here. */
export type IDataSourceInput = DistributiveOmit<IDataSource, 'id'> & { readonly id?: string };

/** Payload for a connectivity test: the coordinates as currently typed in the form (NOT necessarily saved). */
export interface IDataSourceTestPayload {
	readonly label: string;
	readonly coordinates: IDatabaseCoordinates;
	/** When set and `secret` is absent, the test falls back to this data source's stored credential. */
	readonly dataSourceId?: string;
	/** Form-typed credential; wins over the stored one when any field is non-empty. */
	readonly secret?: IDataSourceSecret;
}

/** Outcome of a connectivity test — `message` is ready to render (includes the failure hint). */
export interface IDataSourceTestResult {
	readonly ok: boolean;
	readonly message: string;
	readonly durationMs: number;
}

/** Broad column type category, normalized main-side from the driver's type code —
 *  the renderer aligns/formats by category and never sees pg OIDs or mysql codes. */
export type DbColumnCategory = 'text' | 'number' | 'boolean' | 'date' | 'json';

export interface IDbColumn {
	readonly name: string;
	readonly category: DbColumnCategory;
}

/** A table (or view) in a database data source's catalog. */
export interface IDbTable {
	readonly schema: string;
	readonly name: string;
	/** Planner estimate (pg reltuples / information_schema.table_rows) — absent when the engine doesn't know. */
	readonly estimatedRows?: number;
}

/** Outcome of a read-only browse query — errors come back as a renderable message, never a throw. */
export type IDataQueryResult =
	| { readonly ok: true; readonly columns: readonly IDbColumn[]; readonly rows: readonly (readonly unknown[])[]; readonly truncated: boolean; readonly durationMs: number }
	| { readonly ok: false; readonly message: string; readonly durationMs: number };

export type IDbTablesResult =
	| { readonly ok: true; readonly tables: readonly IDbTable[] }
	| { readonly ok: false; readonly message: string };

/**
 * The shape exposed on `agentWindow.environments` by the preload script. All
 * calls are scoped by projectId (the main process resolves its workspacePath).
 * Returns redacted views; secrets only travel renderer→main via
 * setDataSourceCredential / upsertDataSource's secret / testDataSource.
 */
export interface IEnvironmentsBridge {
	get(projectId: string): Promise<IWorkspaceConfigView>;
	upsertEnvironment(projectId: string, input: IEnvironmentInput): Promise<IWorkspaceConfigView>;
	removeEnvironment(projectId: string, environmentId: string): Promise<IWorkspaceConfigView>;
	/** Upsert the definition; a `secret` with any non-empty field is stored for the (new or existing) data source in the same call. */
	upsertDataSource(projectId: string, input: IDataSourceInput, secret?: IDataSourceSecret): Promise<IWorkspaceConfigView>;
	removeDataSource(projectId: string, dataSourceId: string): Promise<IWorkspaceConfigView>;
	/** Set or clear (all-empty ⇒ clear) a data source's credential. Returns the refreshed view (hasCredential updated). */
	setDataSourceCredential(projectId: string, dataSourceId: string, secret: IDataSourceSecret): Promise<IWorkspaceConfigView>;
	/** Try to connect (database kinds only) with the given coordinates/credential — nothing is saved. */
	testDataSource(projectId: string, payload: IDataSourceTestPayload): Promise<IDataSourceTestResult>;
	/** Run a read-only SQL statement against a database data source (the browse panel's query path).
	 *  Write statements are refused main-side; `rowLimit` is capped by the main process. */
	runQuery(projectId: string, dataSourceId: string, sql: string, options?: { readonly rowLimit?: number }): Promise<IDataQueryResult>;
	/** List tables/views (with row estimates where the engine knows them) of a database data source. */
	listTables(projectId: string, dataSourceId: string): Promise<IDbTablesResult>;
}

/**
 * Whether the app may issue a write against this data source — the AND of the two
 * layers. Layer 1: the environment is writable. Layer 2: the account's declared
 * access is read-write. Either being restrictive makes the source effectively
 * read-only. (Layer 2's real grant is out-of-band and still the hard backstop.)
 */
export function isEffectivelyWritable(environmentWritable: boolean, access: DataSourceAccess): boolean {
	return environmentWritable && access === 'read-write';
}
