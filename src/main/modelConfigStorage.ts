/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	IModelEntryInput,
	IModelEntryView,
	IModelParams,
	IModelRegistryView,
	IProviderInput,
	IProviderView,
	ModelProvider,
} from '../sessions/services/models/common/models.js';

/**
 * The config as persisted on disk. Unlike the renderer's view a provider holds
 * the raw `apiKey`. It is stored in plaintext at the data root for now; a future
 * revision can wrap the key with Electron `safeStorage` without touching the IPC
 * surface.
 */
interface IStoredModel {
	readonly id: string;
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
	readonly params?: IModelParams;
}

interface IStoredProvider {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly enabled: boolean;
	readonly apiKey?: string;
	readonly models: readonly IStoredModel[];
}

interface IStoredRegistry {
	readonly providers: readonly IStoredProvider[];
	readonly defaultModelId?: string;
}

/** The resolved, flattened config a single model turns into for the agent runtime. */
export interface IStoredModelConfig {
	readonly id: string;
	readonly label: string;
	readonly provider: ModelProvider;
	readonly baseURL: string;
	readonly model: string;
	readonly params?: IModelParams;
	readonly apiKey?: string;
}

const PROVIDERS: readonly ModelProvider[] = ['openai-compatible', 'anthropic'];

function registryFilePath(root: string): string {
	return join(root, 'models.json');
}

async function readRegistry(root: string): Promise<IStoredRegistry> {
	let raw: string;
	try {
		raw = await readFile(registryFilePath(root), 'utf8');
	} catch {
		return { providers: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { providers: [] };
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return { providers: [] };
	}

	const candidate = parsed as Record<string, unknown>;
	const providers = Array.isArray(candidate['providers']) ? candidate['providers'].map(parseProvider).filter((entry): entry is IStoredProvider => entry !== undefined) : [];
	const defaultModelId = typeof candidate['defaultModelId'] === 'string' && hasModel(providers, candidate['defaultModelId']) ? candidate['defaultModelId'] : undefined;

	return { providers, ...(defaultModelId ? { defaultModelId } : {}) };
}

async function writeRegistry(root: string, registry: IStoredRegistry): Promise<void> {
	await mkdir(root, { recursive: true });
	const file = registryFilePath(root);
	await writeFile(`${file}.tmp`, `${JSON.stringify(registry, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

function parseProvider(value: unknown): IStoredProvider | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const id = candidate['id'];
	const type = candidate['type'];
	if (typeof id !== 'string' || !isProvider(type)) {
		return undefined;
	}

	const apiKey = candidate['apiKey'];
	const models = Array.isArray(candidate['models']) ? candidate['models'].map(parseModel).filter((entry): entry is IStoredModel => entry !== undefined) : [];

	return {
		id,
		name: asString(candidate['name']),
		type,
		baseURL: asString(candidate['baseURL']),
		enabled: candidate['enabled'] !== false,
		models,
		...(typeof apiKey === 'string' && apiKey.length > 0 ? { apiKey } : {}),
	};
}

function parseModel(value: unknown): IStoredModel | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const id = candidate['id'];
	if (typeof id !== 'string') {
		return undefined;
	}

	const model = asString(candidate['model']);
	const params = parseParams(candidate['params']);
	const contextLength = candidate['contextLength'];

	return {
		id,
		model,
		label: typeof candidate['label'] === 'string' && candidate['label'].length > 0 ? candidate['label'] : model,
		...(typeof contextLength === 'number' && contextLength > 0 ? { contextLength } : {}),
		...(params ? { params } : {}),
	};
}

function parseParams(value: unknown): IModelParams | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const params: IModelParams = {
		...(typeof candidate['temperature'] === 'number' ? { temperature: candidate['temperature'] } : {}),
		...(typeof candidate['maxTokens'] === 'number' ? { maxTokens: candidate['maxTokens'] } : {}),
		...(typeof candidate['thinking'] === 'boolean' ? { thinking: candidate['thinking'] } : {}),
	};
	return Object.keys(params).length > 0 ? params : undefined;
}

function isProvider(value: unknown): value is ModelProvider {
	return typeof value === 'string' && PROVIDERS.includes(value as ModelProvider);
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Model config field "${field}" is required.`);
	}

	return value.trim();
}

function hasModel(providers: readonly IStoredProvider[], modelId: string): boolean {
	return providers.some(provider => provider.models.some(model => model.id === modelId));
}

/** The id of the first model across all providers, or undefined when none exist. */
function firstModelId(providers: readonly IStoredProvider[]): string | undefined {
	for (const provider of providers) {
		const first = provider.models[0];
		if (first) {
			return first.id;
		}
	}

	return undefined;
}

function normalizeProvider(input: IProviderInput, existing: IStoredProvider | undefined): IStoredProvider {
	if (!isProvider(input.type)) {
		throw new Error(`Unknown provider type: ${String(input.type)}`);
	}

	const apiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : existing?.apiKey;

	return {
		id: existing?.id ?? randomUUID(),
		name: requireString(input.name, 'name'),
		type: input.type,
		baseURL: requireString(input.baseURL, 'baseURL'),
		enabled: input.enabled ?? existing?.enabled ?? true,
		models: existing?.models ?? [],
		...(apiKey ? { apiKey } : {}),
	};
}

function normalizeModel(input: IModelEntryInput, existing: IStoredModel | undefined): IStoredModel {
	const model = requireString(input.model, 'model');
	const params = parseParams(input.params);
	const label = typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : model;

	return {
		id: existing?.id ?? randomUUID(),
		model,
		label,
		...(typeof input.contextLength === 'number' && input.contextLength > 0 ? { contextLength: input.contextLength } : {}),
		...(params ? { params } : {}),
	};
}

function toModelView(model: IStoredModel): IModelEntryView {
	return {
		id: model.id,
		model: model.model,
		label: model.label,
		...(model.contextLength ? { contextLength: model.contextLength } : {}),
		...(model.params ? { params: model.params } : {}),
	};
}

function toProviderView(provider: IStoredProvider): IProviderView {
	return {
		id: provider.id,
		name: provider.name,
		type: provider.type,
		baseURL: provider.baseURL,
		enabled: provider.enabled,
		hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
		models: provider.models.map(toModelView),
	};
}

function toRegistryView(registry: IStoredRegistry): IModelRegistryView {
	return {
		providers: registry.providers.map(toProviderView),
		...(registry.defaultModelId ? { defaultModelId: registry.defaultModelId } : {}),
	};
}

/** Re-derive a valid default: keep the current one if it still exists, else the first model. */
function withValidDefault(providers: readonly IStoredProvider[], preferred: string | undefined): IStoredRegistry {
	const defaultModelId = preferred && hasModel(providers, preferred) ? preferred : firstModelId(providers);
	return { providers, ...(defaultModelId ? { defaultModelId } : {}) };
}

export async function listModels(root: string): Promise<IModelRegistryView> {
	return toRegistryView(await readRegistry(root));
}

export async function upsertProvider(root: string, input: IProviderInput): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const existing = input.id ? registry.providers.find(provider => provider.id === input.id) : undefined;
	const normalized = normalizeProvider(input, existing);
	const providers = existing ? registry.providers.map(provider => (provider.id === normalized.id ? normalized : provider)) : [...registry.providers, normalized];
	const next = withValidDefault(providers, registry.defaultModelId);
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function removeProvider(root: string, id: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const providers = registry.providers.filter(provider => provider.id !== id);
	const next = withValidDefault(providers, registry.defaultModelId);
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function upsertModel(root: string, providerId: string, input: IModelEntryInput): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const provider = registry.providers.find(candidate => candidate.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const existing = input.id ? provider.models.find(model => model.id === input.id) : undefined;
	const normalized = normalizeModel(input, existing);
	const models = existing ? provider.models.map(model => (model.id === normalized.id ? normalized : model)) : [...provider.models, normalized];
	const providers = registry.providers.map(candidate => (candidate.id === providerId ? { ...candidate, models } : candidate));
	// First model added anywhere becomes the default.
	const next = withValidDefault(providers, registry.defaultModelId ?? normalized.id);
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function removeModel(root: string, modelId: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const providers = registry.providers.map(provider => ({ ...provider, models: provider.models.filter(model => model.id !== modelId) }));
	const next = withValidDefault(providers, registry.defaultModelId);
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function setDefaultModel(root: string, modelId: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	if (!hasModel(registry.providers, modelId)) {
		return toRegistryView(registry);
	}

	const next: IStoredRegistry = { providers: registry.providers, defaultModelId: modelId };
	await writeRegistry(root, next);
	return toRegistryView(next);
}

/** Main-side only: the full config incl. the API key for a model, for the agent runtime. */
export async function resolveModelConfig(root: string, modelId: string): Promise<IStoredModelConfig | undefined> {
	const registry = await readRegistry(root);
	const targetId = hasModel(registry.providers, modelId) ? modelId : registry.defaultModelId;
	if (!targetId) {
		return undefined;
	}

	for (const provider of registry.providers) {
		const model = provider.models.find(candidate => candidate.id === targetId);
		if (model) {
			return {
				id: model.id,
				label: model.label,
				provider: provider.type,
				baseURL: provider.baseURL,
				model: model.model,
				...(model.params ? { params: model.params } : {}),
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
			};
		}
	}

	return undefined;
}
