/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModelConfigInput, IModelConfigView, IModelParams, IModelRegistryView, ModelProvider } from '../sessions/services/models/common/models.js';

/**
 * The config as persisted on disk. Unlike the renderer's view this holds the raw
 * `apiKey`. It is stored in plaintext at the data root for now; a future revision
 * can wrap the key with Electron `safeStorage` without touching the IPC surface.
 */
export interface IStoredModelConfig {
	readonly id: string;
	readonly label: string;
	readonly provider: ModelProvider;
	readonly baseURL: string;
	readonly model: string;
	readonly params?: IModelParams;
	readonly apiKey?: string;
}

interface IStoredRegistry {
	readonly models: readonly IStoredModelConfig[];
	readonly defaultModelId?: string;
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
		return { models: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { models: [] };
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return { models: [] };
	}

	const candidate = parsed as Record<string, unknown>;
	const models = Array.isArray(candidate['models']) ? candidate['models'].map(parseStored).filter((entry): entry is IStoredModelConfig => entry !== undefined) : [];
	const defaultModelId =
		typeof candidate['defaultModelId'] === 'string' && models.some(model => model.id === candidate['defaultModelId']) ? candidate['defaultModelId'] : undefined;

	return { models, ...(defaultModelId ? { defaultModelId } : {}) };
}

async function writeRegistry(root: string, registry: IStoredRegistry): Promise<void> {
	await mkdir(root, { recursive: true });
	const file = registryFilePath(root);
	await writeFile(`${file}.tmp`, `${JSON.stringify(registry, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

function parseStored(value: unknown): IStoredModelConfig | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const id = candidate['id'];
	const provider = candidate['provider'];
	if (typeof id !== 'string' || !isProvider(provider)) {
		return undefined;
	}

	const params = parseParams(candidate['params']);
	const apiKey = candidate['apiKey'];

	return {
		id,
		label: asString(candidate['label']),
		provider,
		baseURL: asString(candidate['baseURL']),
		model: asString(candidate['model']),
		...(params ? { params } : {}),
		...(typeof apiKey === 'string' && apiKey.length > 0 ? { apiKey } : {}),
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

/** Normalize an untrusted upsert payload against the existing entry (if editing). */
function normalizeInput(input: IModelConfigInput, existing: IStoredModelConfig | undefined): IStoredModelConfig {
	if (!isProvider(input.provider)) {
		throw new Error(`Unknown provider: ${String(input.provider)}`);
	}

	const label = requireString(input.label, 'label');
	const baseURL = requireString(input.baseURL, 'baseURL');
	const model = requireString(input.model, 'model');
	const params = parseParams(input.params);
	const apiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : existing?.apiKey;

	return {
		id: existing?.id ?? randomUUID(),
		label,
		provider: input.provider,
		baseURL,
		model,
		...(params ? { params } : {}),
		...(apiKey ? { apiKey } : {}),
	};
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Model config field "${field}" is required.`);
	}

	return value.trim();
}

function toView(config: IStoredModelConfig): IModelConfigView {
	return {
		id: config.id,
		label: config.label,
		provider: config.provider,
		baseURL: config.baseURL,
		model: config.model,
		...(config.params ? { params: config.params } : {}),
		hasApiKey: typeof config.apiKey === 'string' && config.apiKey.length > 0,
	};
}

function toRegistryView(registry: IStoredRegistry): IModelRegistryView {
	return {
		models: registry.models.map(toView),
		...(registry.defaultModelId ? { defaultModelId: registry.defaultModelId } : {}),
	};
}

export async function listModels(root: string): Promise<IModelRegistryView> {
	return toRegistryView(await readRegistry(root));
}

export async function upsertModel(root: string, input: IModelConfigInput): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const existing = input.id ? registry.models.find(model => model.id === input.id) : undefined;
	const normalized = normalizeInput(input, existing);
	const models = existing ? registry.models.map(model => (model.id === normalized.id ? normalized : model)) : [...registry.models, normalized];
	// First model added becomes the default.
	const defaultModelId = registry.defaultModelId ?? normalized.id;
	const next: IStoredRegistry = { models, defaultModelId };
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function removeModel(root: string, id: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	const models = registry.models.filter(model => model.id !== id);
	const stillDefault = registry.defaultModelId && models.some(model => model.id === registry.defaultModelId);
	const fallbackDefault = stillDefault ? registry.defaultModelId : models[0]?.id;
	const next: IStoredRegistry = { models, ...(fallbackDefault ? { defaultModelId: fallbackDefault } : {}) };
	await writeRegistry(root, next);
	return toRegistryView(next);
}

export async function setDefaultModel(root: string, id: string): Promise<IModelRegistryView> {
	const registry = await readRegistry(root);
	if (!registry.models.some(model => model.id === id)) {
		return toRegistryView(registry);
	}

	const next: IStoredRegistry = { models: registry.models, defaultModelId: id };
	await writeRegistry(root, next);
	return toRegistryView(next);
}

/** Main-side only: the full config incl. the API key, for the agent runtime. */
export async function resolveModelConfig(root: string, id: string): Promise<IStoredModelConfig | undefined> {
	const registry = await readRegistry(root);
	const requested = registry.models.find(model => model.id === id);
	if (requested) {
		return requested;
	}

	return registry.models.find(model => model.id === registry.defaultModelId);
}
