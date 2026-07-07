/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model configuration contracts shared between the main process (where the
 * config — including the API key — is stored) and the renderer (which only ever
 * sees a redacted view). The renderer manages models through {@link IModelsBridge};
 * the raw API key never crosses back over IPC.
 */

export type ModelProvider = 'openai-compatible' | 'anthropic';

export interface IModelParams {
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Adaptive thinking / reasoning toggle where the provider supports it. */
	readonly thinking?: boolean;
}

/** The upsert payload sent from the renderer. `apiKey` is write-only. */
export interface IModelConfigInput {
	/** Present when editing an existing config; absent when creating. */
	readonly id?: string;
	readonly label: string;
	readonly provider: ModelProvider;
	readonly baseURL: string;
	readonly model: string;
	readonly params?: IModelParams;
	/** Set or rotate the key. Omit to keep the existing key (edit) or leave unset (create). */
	readonly apiKey?: string;
}

/** The redacted config the renderer receives — no raw key, only whether one is set. */
export interface IModelConfigView {
	readonly id: string;
	readonly label: string;
	readonly provider: ModelProvider;
	readonly baseURL: string;
	readonly model: string;
	readonly params?: IModelParams;
	readonly hasApiKey: boolean;
}

export interface IModelRegistryView {
	readonly models: readonly IModelConfigView[];
	readonly defaultModelId?: string;
}

/** The shape exposed on `agentWindow.models` by the preload script. */
export interface IModelsBridge {
	list(): Promise<IModelRegistryView>;
	upsert(input: IModelConfigInput): Promise<IModelRegistryView>;
	remove(id: string): Promise<IModelRegistryView>;
	setDefault(id: string): Promise<IModelRegistryView>;
}
