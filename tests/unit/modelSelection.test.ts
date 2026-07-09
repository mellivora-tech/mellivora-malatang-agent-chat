/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { listEnabledModels, resolveSelectedModel } from '../../src/sessions/services/models/browser/modelsService.js';
import type { IModelRegistryView } from '../../src/sessions/services/models/common/models.js';

function registry(): IModelRegistryView {
	return {
		providers: [
			{
				id: 'p1',
				name: 'Z.ai (GLM)',
				type: 'openai-compatible',
				baseURL: 'https://api.z.ai/api/paas/v4',
				hasApiKey: true,
				models: [
					{ id: 'm1', model: 'glm-5.2', label: 'GLM-5.2', enabled: true },
					{ id: 'm2', model: 'glm-5-turbo', label: 'GLM-5 Turbo', enabled: false },
				],
			},
			{
				id: 'p2',
				name: 'OpenAI',
				type: 'openai-compatible',
				baseURL: 'https://api.openai.com/v1',
				hasApiKey: true,
				models: [{ id: 'm3', model: 'gpt-5.5', label: 'GPT-5.5', enabled: true }],
			},
		],
	};
}

test('listEnabledModels flattens enabled models in provider then priority order', () => {
	assert.deepEqual(
		listEnabledModels(registry()).map(model => model.id),
		['m1', 'm3'],
	);
	assert.deepEqual(listEnabledModels(registry())[0], { id: 'm1', model: 'glm-5.2', label: 'GLM-5.2', providerId: 'p1', providerName: 'Z.ai (GLM)' });
});

test('resolveSelectedModel honors an explicit pick while it stays enabled', () => {
	assert.equal(resolveSelectedModel(registry(), 'm3')?.id, 'm3');
});

test('resolveSelectedModel falls back to the first enabled model', () => {
	// No explicit pick, a disabled pick, and a removed pick all fall back.
	assert.equal(resolveSelectedModel(registry(), undefined)?.id, 'm1');
	assert.equal(resolveSelectedModel(registry(), 'm2')?.id, 'm1');
	assert.equal(resolveSelectedModel(registry(), 'gone')?.id, 'm1');
});

test('resolveSelectedModel is undefined when nothing is enabled', () => {
	assert.equal(resolveSelectedModel({ providers: [] }, 'm1'), undefined);
});

test('effort capability comes from the preset catalog; hand-added models get none', () => {
	const view: IModelRegistryView = {
		providers: [
			{
				id: 'p1',
				name: 'OpenAI',
				type: 'openai-compatible',
				baseURL: 'https://api.openai.com/v1',
				presetId: 'openai',
				hasApiKey: true,
				models: [
					{ id: 'm1', model: 'gpt-5.5', label: 'GPT-5.5', enabled: true, params: { effort: 'high' } },
					{ id: 'm2', model: 'my-custom-model', label: 'Custom', enabled: true },
				],
			},
		],
	};

	const [preset, custom] = listEnabledModels(view);
	assert.deepEqual(preset?.efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
	assert.equal(preset?.effort, 'high');
	assert.equal(custom?.efforts, undefined);
	assert.equal(custom?.effort, undefined);
});
