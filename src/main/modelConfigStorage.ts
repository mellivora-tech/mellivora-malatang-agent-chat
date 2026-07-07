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
 * On-disk config. A provider holds the raw `apiKey` (plaintext for now; a future
 * revision can wrap it with Electron `safeStorage` without touching IPC). There
 * is no default model — order is priority, and each model carries `enabled`.
 */
interface IStoredModel {
	readonly id: string;
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
	readonly enabled: boolean;
	readonly params?: IModelParams;
}

interface IStoredProvider {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly presetId?: string;
	readonly apiKey?: string;
	readonly models: readonly IStoredModel[];
}

interface IStoredRegistry {
	readonly providers: readonly IStoredProvider[];
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
	return { providers };
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
	const presetId = candidate['presetId'];
	const models = Array.isArray(candidate['models']) ? candidate['models'].map(parseModel).filter((entry): entry is IStoredModel => entry !== undefined) : [];

	return {
		id,
		name: asString(candidate['name']),
		type,
		baseURL: asString(candidate['baseURL']),
		models,
		...(typeof presetId === 'string' && presetId.length > 0 ? { presetId } : {}),
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
		enabled: candidate['enabled'] !== false,
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

function normalizeModel(input: IModelEntryInput, existing: IStoredModel | undefined): IStoredModel {
	const model = requireString(input.model, 'model');
	const params = parseParams(input.params);
	const label = typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : model;

	return {
		id: existing?.id ?? randomUUID(),
		model,
		label,
		enabled: input.enabled ?? existing?.enabled ?? true,
		...(typeof input.contextLength === 'number' && input.contextLength > 0 ? { contextLength: input.contextLength } : {}),
		...(params ? { params } : {}),
	};
}

function normalizeProviderOnCreate(input: IProviderInput): IStoredProvider {
	if (!isProvider(input.type)) {
		throw new Error(`Unknown provider type: ${String(input.type)}`);
	}

	return {
		id: randomUUID(),
		name: requireString(input.name, 'name'),
		type: input.type,
		baseURL: requireString(input.baseURL, 'baseURL'),
		models: (input.models ?? []).map(model => normalizeModel(model, undefined)),
		...(input.presetId ? { presetId: input.presetId } : {}),
		...(input.apiKey && input.apiKey.length > 0 ? { apiKey: input.apiKey } : {}),
	};
}

function toModelView(model: IStoredModel): IModelEntryView {
	return {
		id: model.id,
		model: model.model,
		label: model.label,
		enabled: model.enabled,
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
		hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
		models: provider.models.map(toModelView),
		...(provider.presetId ? { presetId: provider.presetId } : {}),
	};
}

function toRegistryView(registry: IStoredRegistry): IModelRegistryView {
	return { providers: registry.providers.map(toProviderView) };
}

function mapProviders(registry: IStoredRegistry, id: string, update: (provider: IStoredProvider) => IStoredProvider): IStoredRegistry {
	return { providers: registry.providers.map(provider => (provider.id === id ? update(provider) : provider)) };
}

/** The provider that owns `modelId`, or undefined. */
function findModel(registry: IStoredRegistry, modelId: string): { provider: IStoredProvider; model: IStoredModel } | undefined {
	for (const provider of registry.providers) {
		const model = provider.models.find(candidate => candidate.id === modelId);
		if (model) {
			return { provider, model };
		}
	}

	return undefined;
}

export async function listModels(root: string): Promise<IModelRegistryView> {
	return toRegistryView(await readRegistry(root));
}

export async function upsertProvider(root: string, input: IProviderInput): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const existing = input.id ? registry.providers.find(provider => provider.id === input.id) : undefined;

	let next: IStoredRegistry;
	if (existing) {
		if (!isProvider(input.type)) {
			throw new Error(`Unknown provider type: ${String(input.type)}`);
		}
		const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : existing.apiKey;
		const updated: IStoredProvider = {
			id: existing.id,
			name: requireString(input.name, 'name'),
			type: input.type,
			baseURL: requireString(input.baseURL, 'baseURL'),
			models: existing.models,
			...(input.presetId ? { presetId: input.presetId } : existing.presetId ? { presetId: existing.presetId } : {}),
			...(apiKey ? { apiKey } : {}),
		};
		next = { providers: registry.providers.map(provider => (provider.id === existing.id ? updated : provider)) };
	} else {
		next = { providers: [...registry.providers, normalizeProviderOnCreate(input)] };
	}

	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function removeProvider(root: string, id: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const next: IStoredRegistry = { providers: registry.providers.filter(provider => provider.id !== id) };
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
	const next = mapProviders(registry, providerId, candidate => ({ ...candidate, models }));
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function removeModel(root: string, modelId: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const next: IStoredRegistry = { providers: registry.providers.map(provider => ({ ...provider, models: provider.models.filter(model => model.id !== modelId) })) };
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function setModelEnabled(root: string, modelId: string, enabled: boolean): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const next: IStoredRegistry = {
		providers: registry.providers.map(provider => ({
			...provider,
			models: provider.models.map(model => (model.id === modelId ? { ...model, enabled } : model)),
		})),
	};
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function moveModel(root: string, modelId: string, direction: 'up' | 'down'): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const found = findModel(registry, modelId);
	if (!found) {
		return toRegistryView(registry);
	}

	const models = [...found.provider.models];
	const index = models.findIndex(model => model.id === modelId);
	const target = direction === 'up' ? index - 1 : index + 1;
	if (target < 0 || target >= models.length) {
		return toRegistryView(registry);
	}

	const a = models[index];
	const b = models[target];
	if (a && b) {
		models[index] = b;
		models[target] = a;
	}
	const next = mapProviders(registry, found.provider.id, provider => ({ ...provider, models }));
	await writeRegistry(root, next);
	return toRegistryView(next);
}

/** Main-side only: the full config incl. the API key. Falls back to the first enabled model. */
export async function resolveModelConfig(root: string, modelId: string | undefined): Promise<IStoredModelConfig | undefined> {
	const registry = await readRegistry(root);
	const explicit = modelId ? findModel(registry, modelId) : undefined;
	const target = explicit ?? firstEnabled(registry);
	if (!target) {
		return undefined;
	}

	return {
		id: target.model.id,
		label: target.model.label,
		provider: target.provider.type,
		baseURL: target.provider.baseURL,
		model: target.model.model,
		...(target.model.params ? { params: target.model.params } : {}),
		...(target.provider.apiKey ? { apiKey: target.provider.apiKey } : {}),
	};
}

function firstEnabled(registry: IStoredRegistry): { provider: IStoredProvider; model: IStoredModel } | undefined {
	for (const provider of registry.providers) {
		const model = provider.models.find(candidate => candidate.enabled);
		if (model) {
			return { provider, model };
		}
	}

	return undefined;
}
