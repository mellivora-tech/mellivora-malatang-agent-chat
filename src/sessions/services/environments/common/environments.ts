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

/** MVP ships 'database' only; config-center / redis / mq come later. */
export type DataSourceKind = 'database';

export type DatabaseDriver = 'mysql' | 'postgres';

/** baseline = known-good (usually dev), target = under investigation (usually prod). Diff defaults to baseline↔target. */
export type EnvironmentRole = 'baseline' | 'target' | 'other';

/** read-only is the default and is FORCED for target/prod environments (see isReadOnlyForced). */
export type DataSourceAccess = 'read-only' | 'read-write';

export interface IDatabaseCoordinates {
	readonly driver: DatabaseDriver;
	readonly host: string;
	readonly port: number;
	readonly database: string;
}

/** A named runtime instance of the project's system. Owns nothing but its identity + role; data sources reference it. */
export interface IEnvironment {
	readonly id: string;
	readonly name: string;
	readonly role: EnvironmentRole;
}

/** A connection definition (NO credential). `label` is the logical resource name used to pair across environments for diff. */
export interface IDataSource {
	readonly id: string;
	readonly environmentId: string;
	readonly kind: DataSourceKind;
	readonly label: string;
	readonly access: DataSourceAccess;
	readonly coordinates: IDatabaseCoordinates;
}

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
}

/** The redacted data-source the renderer sees: definition + whether a secret is on file (never the secret). */
export interface IDataSourceView extends IDataSource {
	readonly hasCredential: boolean;
}

/**
 * Target/prod is read-only, no exceptions from the renderer: a write there must
 * be a deliberate, separately-gated action. 'other'/baseline may allow writes.
 */
export function isReadOnlyForced(role: EnvironmentRole): boolean {
	return role === 'target';
}

/** The effective access after applying the forced-read-only policy for the owning environment's role. */
export function effectiveAccess(access: DataSourceAccess, role: EnvironmentRole): DataSourceAccess {
	return isReadOnlyForced(role) ? 'read-only' : access;
}
