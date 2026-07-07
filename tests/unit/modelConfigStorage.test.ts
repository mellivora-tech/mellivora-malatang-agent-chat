/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listModels, removeModel, resolveModelConfig, setDefaultModel, upsertModel } from '../../src/main/modelConfigStorage.js';
import type { IModelConfigView } from '../../src/sessions/services/models/common/models.js';

async function createRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'model-config-'));
}

function onlyModel(view: { models: readonly IModelConfigView[] }): IModelConfigView {
	assert.equal(view.models.length, 1);
	const model = view.models[0];
	assert.ok(model);
	return model;
}

test('upsert creates a config, marks it default, and never returns the raw key', async () => {
	const root = await createRoot();

	const view = await upsertModel(root, {
		label: 'Kimi K2',
		provider: 'openai-compatible',
		baseURL: 'https://api.moonshot.cn/v1',
		model: 'kimi-k2',
		apiKey: 'sk-secret-123',
	});

	const model = onlyModel(view);
	assert.equal(model.label, 'Kimi K2');
	assert.equal(model.hasApiKey, true);
	assert.equal(view.defaultModelId, model.id);
	// The redacted view carries no raw key.
	assert.equal('apiKey' in model, false);

	// list() is likewise redacted...
	const listed = onlyModel(await listModels(root));
	assert.equal('apiKey' in listed, false);

	// ...but the key is persisted on disk and resolvable main-side.
	const onDisk = await readFile(join(root, 'models.json'), 'utf8');
	assert.match(onDisk, /sk-secret-123/);
	const resolved = await resolveModelConfig(root, model.id);
	assert.equal(resolved?.apiKey, 'sk-secret-123');
});

test('editing without an apiKey keeps the existing key; a new key rotates it', async () => {
	const root = await createRoot();
	const created = onlyModel(await upsertModel(root, { label: 'A', provider: 'openai-compatible', baseURL: 'https://x/v1', model: 'm', apiKey: 'key-1' }));

	// Edit label only — key preserved.
	await upsertModel(root, { id: created.id, label: 'A renamed', provider: 'openai-compatible', baseURL: 'https://x/v1', model: 'm' });
	assert.equal((await resolveModelConfig(root, created.id))?.apiKey, 'key-1');
	assert.equal(onlyModel(await listModels(root)).label, 'A renamed');

	// Edit with a new key — rotated.
	await upsertModel(root, { id: created.id, label: 'A renamed', provider: 'openai-compatible', baseURL: 'https://x/v1', model: 'm', apiKey: 'key-2' });
	assert.equal((await resolveModelConfig(root, created.id))?.apiKey, 'key-2');
});

test('setDefault switches the default and remove falls back to the first remaining model', async () => {
	const root = await createRoot();
	const first = onlyModel(await upsertModel(root, { label: 'First', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-4-8', apiKey: 'k1' }));
	const afterSecond = await upsertModel(root, { label: 'Second', provider: 'openai-compatible', baseURL: 'https://x/v1', model: 'm', apiKey: 'k2' });
	const second = afterSecond.models.find(model => model.id !== first.id);
	assert.ok(second);

	assert.equal(afterSecond.defaultModelId, first.id, 'first added stays default');

	const afterDefault = await setDefaultModel(root, second.id);
	assert.equal(afterDefault.defaultModelId, second.id);

	// Removing the default falls back to whatever remains.
	const afterRemove = await removeModel(root, second.id);
	assert.equal(afterRemove.models.length, 1);
	assert.equal(afterRemove.defaultModelId, first.id);
});

test('a corrupt registry file degrades to an empty list', async () => {
	const root = await createRoot();
	await upsertModel(root, { label: 'ok', provider: 'openai-compatible', baseURL: 'https://x/v1', model: 'm' });
	const { writeFile } = await import('node:fs/promises');
	await writeFile(join(root, 'models.json'), 'not json', 'utf8');
	assert.deepEqual((await listModels(root)).models, []);
});
