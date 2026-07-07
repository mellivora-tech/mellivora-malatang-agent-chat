/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelEffort, ModelProvider } from './models.js';

/**
 * Built-in provider catalog — the fixed set of providers offered in settings.
 * A preset fixes the name and wire format and suggests a base URL and model
 * list, so the user only enters an API key. Base URL and models are
 * best-effort defaults and can be edited after setup.
 */

export interface IProviderPresetModel {
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
	/** Reasoning-effort levels the model's API accepts; omitted = no effort knob. */
	readonly efforts?: readonly ModelEffort[];
}

export interface IProviderPreset {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly description?: string;
	readonly models: readonly IProviderPresetModel[];
}

export const PROVIDER_PRESETS: readonly IProviderPreset[] = [
	{
		id: 'kimi-code',
		name: 'Kimi Code Plan',
		type: 'anthropic',
		baseURL: 'https://api.moonshot.cn/anthropic',
		description: 'Coding plan (Anthropic-compatible)',
		models: [
			{ model: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextLength: 256000 },
			{ model: 'kimi-k2.6', label: 'Kimi K2.6', contextLength: 256000 },
		],
	},
	{
		id: 'kimi-api',
		name: 'Kimi API',
		type: 'openai-compatible',
		baseURL: 'https://api.moonshot.cn/v1',
		description: 'Pay-as-you-go API',
		models: [
			{ model: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextLength: 256000 },
			{ model: 'kimi-k2.6', label: 'Kimi K2.6', contextLength: 256000 },
		],
	},
	{
		id: 'zai-glm',
		name: 'Z.ai (GLM)',
		type: 'openai-compatible',
		baseURL: 'https://api.z.ai/api/paas/v4',
		description: 'GLM coding models',
		models: [
			{ model: 'glm-5.2', label: 'GLM-5.2', contextLength: 1000000, efforts: ['high', 'max'] },
			{ model: 'glm-5-turbo', label: 'GLM-5 Turbo' },
			{ model: 'glm-4.7', label: 'GLM-4.7', contextLength: 200000 },
		],
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		type: 'openai-compatible',
		baseURL: 'https://api.deepseek.com',
		models: [
			{ model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextLength: 1000000, efforts: ['high', 'max'] },
			{ model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextLength: 1000000, efforts: ['high', 'max'] },
		],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		type: 'openai-compatible',
		baseURL: 'https://api.openai.com/v1',
		models: [
			{ model: 'gpt-5.5', label: 'GPT-5.5', contextLength: 1000000, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
			{ model: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', contextLength: 400000, efforts: ['none', 'low', 'medium', 'high'] },
		],
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		type: 'anthropic',
		baseURL: 'https://api.anthropic.com',
		models: [
			{ model: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextLength: 1000000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
			{ model: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextLength: 1000000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
			{ model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextLength: 200000 },
		],
	},
];
