/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStoredModelConfig } from '../modelConfigStorage.js';
import type { IModelClient, IModelClientConfig } from './agentTypes.js';
import { AnthropicModelClient } from './anthropicModelClient.js';
import { OpenAIModelClient } from './openaiModelClient.js';

/** Build the concrete streaming client for a stored model config (main-side, with the key). */
export function createModelClient(config: IStoredModelConfig): IModelClient {
	const clientConfig: IModelClientConfig = {
		baseURL: config.baseURL,
		model: config.model,
		...(config.apiKey ? { apiKey: config.apiKey } : {}),
		...(config.params ? { params: config.params } : {}),
	};

	switch (config.provider) {
		case 'anthropic':
			return new AnthropicModelClient(clientConfig);
		case 'openai-compatible':
			return new OpenAIModelClient(clientConfig);
	}
}
