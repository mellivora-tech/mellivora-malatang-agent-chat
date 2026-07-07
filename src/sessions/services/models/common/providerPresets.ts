/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelProvider } from './models.js';

/**
 * Built-in provider catalog. Picking a preset fills the base URL, wire format
 * and a suggested model list, so the user only enters an API key. Endpoints and
 * model ids are best-effort defaults and can be edited after adding.
 */

export interface IProviderPresetModel {
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
}

export interface IProviderPreset {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly description?: string;
	readonly models: readonly IProviderPresetModel[];
}

export const CUSTOM_PRESET_ID = 'custom';

export const PROVIDER_PRESETS: readonly IProviderPreset[] = [
	{
		id: 'kimi-code',
		name: 'Kimi Code Plan',
		type: 'anthropic',
		baseURL: 'https://api.moonshot.cn/anthropic',
		description: 'Coding plan (Anthropic-compatible)',
		models: [
			{ model: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', contextLength: 256000 },
			{ model: 'kimi-k2-0905-preview', label: 'Kimi K2', contextLength: 256000 },
		],
	},
	{
		id: 'kimi-api',
		name: 'Kimi API',
		type: 'openai-compatible',
		baseURL: 'https://api.moonshot.cn/v1',
		description: 'Pay-as-you-go API',
		models: [{ model: 'kimi-k2-0905-preview', label: 'Kimi K2', contextLength: 256000 }],
	},
	{
		id: 'zai-glm',
		name: 'Z.ai (GLM)',
		type: 'openai-compatible',
		baseURL: 'https://api.z.ai/api/paas/v4',
		description: 'GLM coding models',
		models: [
			{ model: 'glm-4.6', label: 'GLM-4.6', contextLength: 200000 },
			{ model: 'glm-4.5-air', label: 'GLM-4.5 Air', contextLength: 128000 },
		],
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		type: 'openai-compatible',
		baseURL: 'https://api.deepseek.com',
		models: [
			{ model: 'deepseek-chat', label: 'DeepSeek Chat', contextLength: 64000 },
			{ model: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextLength: 64000 },
		],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		type: 'openai-compatible',
		baseURL: 'https://api.openai.com/v1',
		models: [{ model: 'gpt-4o', label: 'GPT-4o', contextLength: 128000 }],
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		type: 'anthropic',
		baseURL: 'https://api.anthropic.com',
		models: [{ model: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextLength: 200000 }],
	},
];

export function findPreset(presetId: string | undefined): IProviderPreset | undefined {
	return presetId ? PROVIDER_PRESETS.find(preset => preset.id === presetId) : undefined;
}

/** Derive the wire format for a custom endpoint from its base URL. */
export function deriveProviderType(baseURL: string): ModelProvider {
	return /anthropic/i.test(baseURL) ? 'anthropic' : 'openai-compatible';
}
