/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
import type { IAgentBridge, IAgentEventPayload, IAgentMessage, IApprovalRequestPayload, ICompactionAnchor, PermissionMode } from '../sessions/services/agent/common/agent.js';
import type { IAppState, IAppStateBridge } from '../sessions/services/appState/common/appState.js';
import type {
	IModelEntryInput,
	IModelsBridge,
	IProviderInput,
	IProviderVerificationRequest,
	IRemoteModelsRequest,
	ModelEffort,
} from '../sessions/services/models/common/models.js';
import type { IGitBridge } from '../sessions/services/git/common/git.js';
import type { IProjectInput, IProjectsBridge, IRemoteRepoInput } from '../sessions/services/projects/common/projects.js';
import type { ISessionEntry, ISessionHeader, ISessionRef, ISessionsBridge } from '../sessions/services/sessions/common/sessionsBridge.js';
import type { ISkillInput, ISkillsBridge } from '../sessions/services/skills/common/skills.js';
import type { IDataSourceInput, IDataSourceSecret, IDataSourceTestPayload, IEnvironmentInput, IEnvironmentsBridge } from '../sessions/services/environments/common/environments.js';
import type { IDataFilesBridge, IExportTextMeta } from '../sessions/services/dataFiles/common/dataFiles.js';
import type { IArtifactEntryData, IArtifactFilter, IArtifactsBridge } from '../sessions/services/artifacts/common/artifacts.js';

const mockResponseDelayMs = Number.parseInt(process.env['MELLIVORA_MOCK_DELAY_MS'] ?? '', 10);

// Locale pin (#9): Chromium's --lang drives navigator.language on Linux but NOT
// on macOS (there it stays tied to the OS AppleLanguages), so the renderer can't
// rely on it. Cross the pinned locale explicitly instead — bootstrapLocale reads
// this as the deterministic 'system' answer under the e2e harness.
const pinnedLocale = process.env['MELLIVORA_LOCALE'];

const projects: IProjectsBridge = {
	list: () => ipcRenderer.invoke('projects:list'),
	create: (input: IProjectInput) => ipcRenderer.invoke('projects:create', input),
	deleteProject: (projectId: string) => ipcRenderer.invoke('projects:delete', projectId),
	pickAndCreate: () => ipcRenderer.invoke('projects:pickAndCreate'),
	revealInFolder: (projectId: string) => ipcRenderer.invoke('projects:revealInFolder', projectId),
	listFiles: (projectId: string) => ipcRenderer.invoke('projects:listFiles', projectId),
	listCodeRoots: (projectId: string) => ipcRenderer.invoke('projects:listCodeRoots', projectId),
	discoverRepos: (projectId: string, scanRoot?: string) => ipcRenderer.invoke('projects:discoverRepos', projectId, scanRoot),
	addCodeRoot: (projectId: string, path: string) => ipcRenderer.invoke('projects:addCodeRoot', projectId, path),
	removeCodeRoot: (projectId: string, path: string) => ipcRenderer.invoke('projects:removeCodeRoot', projectId, path),
	pickCodeRoot: (projectId: string) => ipcRenderer.invoke('projects:pickCodeRoot', projectId),
	listRemotes: (projectId: string) => ipcRenderer.invoke('projects:listRemotes', projectId),
	listApprovalAllowlist: (projectId: string) => ipcRenderer.invoke('projects:listApprovalAllowlist', projectId),
	removeApprovalAllowPattern: (projectId: string, pattern: string) => ipcRenderer.invoke('projects:removeApprovalAllowPattern', projectId, pattern),
	addRemote: (projectId: string, input: IRemoteRepoInput) => ipcRenderer.invoke('projects:addRemote', projectId, input),
	removeRemote: (projectId: string, remoteId: string) => ipcRenderer.invoke('projects:removeRemote', projectId, remoteId),
	cloneRemote: (projectId: string, remoteId: string) => ipcRenderer.invoke('projects:cloneRemote', projectId, remoteId),
};

const sessions: ISessionsBridge = {
	list: () => ipcRenderer.invoke('sessions:list'),
	create: (header: ISessionHeader) => ipcRenderer.invoke('sessions:create', header),
	append: (ref: ISessionRef, entry: ISessionEntry) => ipcRenderer.invoke('sessions:append', ref, entry),
	delete: (ref: ISessionRef) => ipcRenderer.invoke('sessions:delete', ref),
	storeMedia: (ref: ISessionRef, base64: string, mediaType: string) => ipcRenderer.invoke('sessions:storeMedia', ref, base64, mediaType),
	readMedia: (ref: ISessionRef, entryPath: string) => ipcRenderer.invoke('sessions:readMedia', ref, entryPath),
	storeDocument: (ref: ISessionRef, title: string, markdown: string) => ipcRenderer.invoke('sessions:storeDocument', ref, title, markdown),
	readMediaText: (ref: ISessionRef, entryPath: string) => ipcRenderer.invoke('sessions:readMediaText', ref, entryPath),
};

const appState: IAppStateBridge = {
	get: () => ipcRenderer.invoke('appState:get'),
	set: (state: IAppState) => ipcRenderer.invoke('appState:set', state),
};

const models: IModelsBridge = {
	list: () => ipcRenderer.invoke('models:list'),
	upsertProvider: (input: IProviderInput) => ipcRenderer.invoke('models:upsertProvider', input),
	removeProvider: (id: string) => ipcRenderer.invoke('models:removeProvider', id),
	upsertModel: (providerId: string, input: IModelEntryInput) => ipcRenderer.invoke('models:upsertModel', providerId, input),
	removeModel: (modelId: string) => ipcRenderer.invoke('models:removeModel', modelId),
	setModelEnabled: (modelId: string, enabled: boolean) => ipcRenderer.invoke('models:setModelEnabled', modelId, enabled),
	setModelEffort: (modelId: string, effort: ModelEffort | undefined) => ipcRenderer.invoke('models:setModelEffort', modelId, effort),
	moveModel: (modelId: string, direction: 'up' | 'down') => ipcRenderer.invoke('models:moveModel', modelId, direction),
	listRemoteModels: (request: IRemoteModelsRequest) => ipcRenderer.invoke('models:listRemoteModels', request),
	verifyProvider: (request: IProviderVerificationRequest) => ipcRenderer.invoke('models:verifyProvider', request),
	codingQuota: () => ipcRenderer.invoke('models:codingQuota'),
};

const skills: ISkillsBridge = {
	list: () => ipcRenderer.invoke('skills:list'),
	upsert: (input: ISkillInput) => ipcRenderer.invoke('skills:upsert', input),
	delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
};

const environments: IEnvironmentsBridge = {
	get: (projectId: string) => ipcRenderer.invoke('environments:get', projectId),
	upsertEnvironment: (projectId: string, input: IEnvironmentInput) => ipcRenderer.invoke('environments:upsertEnvironment', projectId, input),
	removeEnvironment: (projectId: string, environmentId: string) => ipcRenderer.invoke('environments:removeEnvironment', projectId, environmentId),
	upsertDataSource: (projectId: string, input: IDataSourceInput, secret?: IDataSourceSecret) => ipcRenderer.invoke('environments:upsertDataSource', projectId, input, secret),
	removeDataSource: (projectId: string, dataSourceId: string) => ipcRenderer.invoke('environments:removeDataSource', projectId, dataSourceId),
	setDataSourceCredential: (projectId: string, dataSourceId: string, secret: IDataSourceSecret) =>
		ipcRenderer.invoke('environments:setDataSourceCredential', projectId, dataSourceId, secret),
	testDataSource: (projectId: string, payload: IDataSourceTestPayload) => ipcRenderer.invoke('environments:testDataSource', projectId, payload),
	runQuery: (projectId: string, dataSourceId: string, sql: string, options?: { readonly rowLimit?: number }) =>
		ipcRenderer.invoke('environments:runQuery', projectId, dataSourceId, sql, options),
	listTables: (projectId: string, dataSourceId: string) => ipcRenderer.invoke('environments:listTables', projectId, dataSourceId),
};

const dataFiles: IDataFilesBridge = {
	pick: () => ipcRenderer.invoke('dataFiles:pick'),
	readTable: (path: string, sheet?: string) => ipcRenderer.invoke('dataFiles:readTable', path, sheet),
	exportText: (defaultName: string, content: string, meta?: IExportTextMeta) => ipcRenderer.invoke('dataFiles:exportText', defaultName, content, meta),
};

const artifacts: IArtifactsBridge = {
	list: (filter?: IArtifactFilter) => ipcRenderer.invoke('artifacts:list', filter),
	record: (entry: IArtifactEntryData) => ipcRenderer.invoke('artifacts:record', entry),
	rebuild: (projectId?: string) => ipcRenderer.invoke('artifacts:rebuild', projectId),
	reveal: (path: string) => ipcRenderer.invoke('artifacts:reveal', path),
};

const git: IGitBridge = {
	branches: (projectId: string) => ipcRenderer.invoke('git:branches', projectId),
	checkout: (projectId: string, branch: string) => ipcRenderer.invoke('git:checkout', projectId, branch),
	diffStat: (projectId: string) => ipcRenderer.invoke('git:diffStat', projectId),
};

const agent: IAgentBridge = {
	run: (
		sessionId: string,
		messages: readonly IAgentMessage[],
		modelId?: string,
		projectId?: string,
		permissionMode?: PermissionMode,
		skillIds?: readonly string[],
		anchor?: ICompactionAnchor,
	) => ipcRenderer.invoke('agent:run', { sessionId, messages, modelId, projectId, permissionMode, skillIds, anchor }),
	stop: (sessionId: string) => ipcRenderer.invoke('agent:stop', sessionId),
	generateTitle: (query: string, modelId?: string) => ipcRenderer.invoke('agent:title', { query, modelId }),
	onEvent: (listener: (payload: IAgentEventPayload) => void) => {
		const handler = (_event: unknown, payload: IAgentEventPayload): void => listener(payload);
		ipcRenderer.on('agent:event', handler);
		return () => ipcRenderer.removeListener('agent:event', handler);
	},
	onApprovalRequest: (listener: (payload: IApprovalRequestPayload) => void) => {
		const handler = (_event: unknown, payload: IApprovalRequestPayload): void => listener(payload);
		ipcRenderer.on('agent:approval-request', handler);
		return () => ipcRenderer.removeListener('agent:approval-request', handler);
	},
	respondApproval: (requestId: string, approved: boolean, always?: boolean, scope?: 'session' | 'project') =>
		ipcRenderer.invoke('agent:approval-response', { requestId, approved, always, scope }),
};

contextBridge.exposeInMainWorld('agentWindow', {
	platform: process.platform,
	projects,
	sessions,
	appState,
	models,
	agent,
	git,
	skills,
	environments,
	dataFiles,
	artifacts,
	...(Number.isFinite(mockResponseDelayMs) && mockResponseDelayMs >= 0 ? { mockResponseDelayMs } : {}),
	...(pinnedLocale === 'zh-CN' || pinnedLocale === 'en-US' ? { locale: pinnedLocale } : {}),
});
