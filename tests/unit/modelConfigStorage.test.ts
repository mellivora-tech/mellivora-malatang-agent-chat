/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	listModels,
	moveModel,
	removeModel,
	removeProvider,
	resolveModelConfig,
	setModelEffort,
	setModelEnabled,
	upsertModel,
	upsertProvider,
} from '../../src/main/modelConfigStorage.js';
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

test('creating a provider seeds its models and keeps the key main-side only', async () => {
	const root = await createRoot();
	const view = await upsertProvider(root, {
		name: 'Z.ai',
		type: 'openai-compatible',
		baseURL: 'https://api.z.ai/v1',
		presetId: 'zai-glm',
		apiKey: 'sk-secret-123',
		models: [
			{ model: 'glm-4.6', label: 'GLM-4.6', contextLength: 1_000_000 },
			{ model: 'glm-4.5-air', label: 'GLM-4.5 Air' },
		],
	});

	const provider = onlyProvider(view);
	assert.equal(provider.hasApiKey, true);
	assert.equal('apiKey' in provider, false, 'the redacted provider carries no raw key');
	assert.equal(provider.presetId, 'zai-glm');
	assert.equal(provider.models.length, 2);
	const first = provider.models[0];
	assert.ok(first);
	assert.equal(first.label, 'GLM-4.6');
	assert.equal(first.enabled, true, 'seeded models are enabled by default');

	// The key is persisted on disk and resolvable by model id.
	const onDisk = await readFile(join(root, 'models.json'), 'utf8');
	assert.match(onDisk, /sk-secret-123/);
	const resolved = await resolveModelConfig(root, first.id);
	assert.equal(resolved?.apiKey, 'sk-secret-123');
	assert.equal(resolved?.provider, 'openai-compatible');
	assert.equal(resolved?.model, 'glm-4.6');
});

test('editing a provider keeps the key unless a new one is supplied; models are untouched', async () => {
	const root = await createRoot();
	const providerId = onlyProvider(await upsertProvider(root, { name: 'P', type: 'openai-compatible', baseURL: 'https://x/v1', apiKey: 'key-1' })).id;
	const model = onlyProvider(await upsertModel(root, providerId, { model: 'm' })).models[0];
	assert.ok(model);

	await upsertProvider(root, { id: providerId, name: 'Renamed', type: 'openai-compatible', baseURL: 'https://x/v1' });
	assert.equal(onlyProvider(await listModels(root)).name, 'Renamed');
	assert.equal(onlyProvider(await listModels(root)).models.length, 1, 'edit does not wipe models');
	assert.equal((await resolveModelConfig(root, model.id))?.apiKey, 'key-1');

	await upsertProvider(root, { id: providerId, name: 'Renamed', type: 'openai-compatible', baseURL: 'https://x/v1', apiKey: 'key-2' });
	assert.equal((await resolveModelConfig(root, model.id))?.apiKey, 'key-2');
});

test('enabled toggles picker visibility; resolve falls back to the first enabled model in order', async () => {
	const root = await createRoot();
	const providerId = onlyProvider(await upsertProvider(root, { name: 'P', type: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'k' })).id;
	const a = onlyProvider(await upsertModel(root, providerId, { model: 'a' })).models[0];
	const afterB = await upsertModel(root, providerId, { model: 'b' });
	assert.ok(a);
	const b = onlyProvider(afterB).models.find(model => model.id !== a.id);
	assert.ok(b);

	// No selection -> first enabled (a).
	assert.equal((await resolveModelConfig(root, undefined))?.model, 'a');

	// Disable a -> resolve falls to b.
	await setModelEnabled(root, a.id, false);
	assert.equal(onlyProvider(await listModels(root)).models.find(m => m.id === a.id)?.enabled, false);
	assert.equal((await resolveModelConfig(root, undefined))?.model, 'b');

	// Reorder: move b up -> b is first; re-enable a; first enabled is now b.
	await moveModel(root, b.id, 'up');
	await setModelEnabled(root, a.id, true);
	assert.equal((await resolveModelConfig(root, undefined))?.model, 'b');
});

test('removing a model or provider updates the registry', async () => {
	const root = await createRoot();
	const providerId = onlyProvider(await upsertProvider(root, { name: 'P', type: 'openai-compatible', baseURL: 'https://x/v1', apiKey: 'k' })).id;
	const model = onlyProvider(await upsertModel(root, providerId, { model: 'm' })).models[0];
	assert.ok(model);

	const afterModelRemove = await removeModel(root, model.id);
	assert.equal(onlyProvider(afterModelRemove).models.length, 0);
	assert.equal(await resolveModelConfig(root, undefined), undefined, 'no enabled model resolves to undefined');

	const afterProviderRemove = await removeProvider(root, providerId);
	assert.equal(afterProviderRemove.providers.length, 0);
});

test('effort persists on the model params, clears back to provider default, and rides into the run config', async () => {
	const root = await createRoot();
	const providerId = onlyProvider(await upsertProvider(root, { name: 'P', type: 'openai-compatible', baseURL: 'https://x/v1', apiKey: 'k' })).id;
	const model = onlyProvider(await upsertModel(root, providerId, { model: 'gpt-5.5' })).models[0];
	assert.ok(model);

	const afterSet = await setModelEffort(root, model.id, 'high');
	assert.equal(onlyProvider(afterSet).models[0]?.params?.effort, 'high');
	assert.equal((await resolveModelConfig(root, model.id))?.params?.effort, 'high');
	const raw = JSON.parse(await readFile(join(root, 'models.json'), 'utf8')) as { providers: { models: { params?: { effort?: string } }[] }[] };
	assert.equal(raw.providers[0]?.models[0]?.params?.effort, 'high');

	const afterClear = await setModelEffort(root, model.id, undefined);
	assert.equal(onlyProvider(afterClear).models[0]?.params, undefined);
	assert.equal((await resolveModelConfig(root, model.id))?.params?.effort, undefined);
});

test('a corrupt registry file degrades to an empty provider list', async () => {
	const root = await createRoot();
	await upsertProvider(root, { name: 'P', type: 'openai-compatible', baseURL: 'https://x/v1' });
	const { writeFile } = await import('node:fs/promises');
	await writeFile(join(root, 'models.json'), 'not json', 'utf8');
	assert.deepEqual((await listModels(root)).providers, []);
});
