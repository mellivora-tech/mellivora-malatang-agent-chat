/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listModels, removeModel, removeProvider, resolveModelConfig, setDefaultModel, upsertModel, upsertProvider } from '../../src/main/modelConfigStorage.js';
import type { IModelRegistryView, IProviderView } from '../../src/sessions/services/models/common/models.js';

async function createRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'model-config-'));
}

function onlyProvider(view: IModelRegistryView): IProviderView {
	assert.equal(view.providers.length, 1);
	const provider = view.providers[0];
	assert.ok(provider);
	return provider;
}

/** Create a provider and return its id. */
async function addProvider(root: string, apiKey?: string): Promise<string> {
	const view = await upsertProvider(root, {
		name: 'Z.ai',
		type: 'openai-compatible',
		baseURL: 'https://api.z.ai/v1',
		...(apiKey ? { apiKey } : {}),
	});
	return onlyProvider(view).id;
}

test('a provider holds the key; adding its first model makes it the default; views are redacted', async () => {
	const root = await createRoot();
	const providerId = await addProvider(root, 'sk-secret-123');

	const view = await upsertModel(root, providerId, { model: 'glm-4.6', label: 'GLM-4.6', contextLength: 1_000_000 });
	const provider = onlyProvider(view);
	assert.equal(provider.hasApiKey, true);
	assert.equal('apiKey' in provider, false, 'the redacted provider carries no raw key');
	assert.equal(provider.models.length, 1);
	const model = provider.models[0];
	assert.ok(model);
	assert.equal(model.label, 'GLM-4.6');
	assert.equal(model.contextLength, 1_000_000);
	assert.equal(view.defaultModelId, model.id, 'first model added becomes default');

	// The key is persisted on disk and resolvable main-side by model id.
	const onDisk = await readFile(join(root, 'models.json'), 'utf8');
	assert.match(onDisk, /sk-secret-123/);
	const resolved = await resolveModelConfig(root, model.id);
	assert.equal(resolved?.apiKey, 'sk-secret-123');
	assert.equal(resolved?.provider, 'openai-compatible');
	assert.equal(resolved?.baseURL, 'https://api.z.ai/v1');
	assert.equal(resolved?.model, 'glm-4.6');
});

test('editing a provider without an apiKey keeps the key; a new key rotates it', async () => {
	const root = await createRoot();
	const providerId = await addProvider(root, 'key-1');
	const model = onlyProvider(await upsertModel(root, providerId, { model: 'm' })).models[0];
	assert.ok(model);

	// Edit provider name only — key preserved.
	await upsertProvider(root, { id: providerId, name: 'Renamed', type: 'openai-compatible', baseURL: 'https://api.z.ai/v1' });
	assert.equal(onlyProvider(await listModels(root)).name, 'Renamed');
	assert.equal((await resolveModelConfig(root, model.id))?.apiKey, 'key-1');

	// Edit with a new key — rotated.
	await upsertProvider(root, { id: providerId, name: 'Renamed', type: 'openai-compatible', baseURL: 'https://api.z.ai/v1', apiKey: 'key-2' });
	assert.equal((await resolveModelConfig(root, model.id))?.apiKey, 'key-2');
});

test('setDefault switches the default; removing a model or provider re-derives a valid default', async () => {
	const root = await createRoot();
	const providerId = await addProvider(root, 'k');
	const first = onlyProvider(await upsertModel(root, providerId, { model: 'first' })).models[0];
	const afterSecond = await upsertModel(root, providerId, { model: 'second' });
	assert.ok(first);
	const second = onlyProvider(afterSecond).models.find(model => model.id !== first.id);
	assert.ok(second);
	assert.equal(afterSecond.defaultModelId, first.id, 'first added stays default');

	const afterDefault = await setDefaultModel(root, second.id);
	assert.equal(afterDefault.defaultModelId, second.id);

	// Removing the default model falls back to whatever remains.
	const afterRemove = await removeModel(root, second.id);
	assert.equal(onlyProvider(afterRemove).models.length, 1);
	assert.equal(afterRemove.defaultModelId, first.id);

	// Removing the whole provider clears the default.
	const afterProviderRemove = await removeProvider(root, providerId);
	assert.equal(afterProviderRemove.providers.length, 0);
	assert.equal(afterProviderRemove.defaultModelId, undefined);
});

test('a corrupt registry file degrades to an empty provider list', async () => {
	const root = await createRoot();
	await addProvider(root);
	const { writeFile } = await import('node:fs/promises');
	await writeFile(join(root, 'models.json'), 'not json', 'utf8');
	assert.deepEqual((await listModels(root)).providers, []);
});
